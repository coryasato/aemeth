import type { Block, StepContext } from "@aemeth/blocks";
import type {
  Decision,
  KeyPhase,
  ResolvedStep,
  ResolvedUndo,
  RunEvent as RunEventType,
  RunValues,
  StepInputs,
  ValidRecipe,
  Work,
} from "@aemeth/core";
import {
  decide,
  EventRejected,
  idempotencyKey,
  inputsOf,
  maxSideBySide,
  Recipe,
  replay,
  RunEvent,
  RunId,
  sizeOf,
  undoInputsOf,
  validate,
  valuesOf,
} from "@aemeth/core";
import { Effect, Option, Result, Schema } from "effect";
import type { WorkflowEngine } from "effect/workflow";
import { Activity, DurableClock, DurableDeferred, Workflow } from "effect/workflow";
import type { BlockResult as BlockResultType } from "./runBlock";
import { BlockResult, runBlock } from "./runBlock";
import type { Fact } from "./RunLog";
import { RunLog, RunNotFound } from "./RunLog";
import type { BlockServices } from "./services";
import { Blocks, delayBefore, retryPolicy } from "./services";

/**
 * A run the engine cannot take further: its log is gone, its recipe no longer validates against
 * the blocks deployed, or the log refused what the engine's own decision led to. None of these is
 * a state of the run; each is a fault in the engine or in a deploy, and the run is left as it is
 * for a person (M2, "A rejected append is an answer").
 */
export class RunStuck extends Schema.TaggedError<RunStuck, { readonly brand: unique symbol }>()(
  "RunStuck",
  {
    runId: Schema.String,
    reason: Schema.Literals([
      "LogMissing",
      "LogDoesNotReplay",
      "RecipeNoLongerValid",
      "NotStarted",
      "WorkLeftOpen",
      "GateWokenWhileOpen",
      "RejectedTwice",
    ]),
    detail: Schema.String,
  },
) {}

/** The workflow that drives one run. It holds nothing of its own: the log is the run. */
export const RunWorkflow = Workflow.make("AemethRun", {
  payload: { runId: RunId },
  idempotencyKey: ({ runId }) => runId,
  error: RunStuck,
});

/** What wakes a run that waits at a gate. The log entry is the fact; this only wakes. */
export const gateOf = (step: string) => DurableDeferred.make(`gate/${step}`);

const AppendFailed = Schema.Union([EventRejected, RunNotFound]);

/** What came of acting on a decision: the run is over, a gate's wake came, or facts were appended. */
type Acted =
  | { readonly _tag: "Ended" }
  | { readonly _tag: "Woken"; readonly step: string }
  | { readonly _tag: "Appended"; readonly refused: ReadonlyArray<EventRejected> };

const appended = (refused: ReadonlyArray<EventRejected>): Acted => ({ _tag: "Appended", refused });

/** What one append was refused with, as a list. */
const one = (rejected: Option.Option<EventRejected>): ReadonlyArray<EventRejected> =>
  Option.toArray(rejected);

const placeOf = (step: ResolvedStep, work: Work) =>
  work.item === undefined
    ? { step: step.step.id, attempt: work.attempt }
    : { step: step.step.id, item: work.item, attempt: work.attempt };

/** One piece of work with everything its block needs. */
type Job = {
  readonly step: ResolvedStep;
  readonly work: Work;
  readonly phase: KeyPhase;
  readonly block: Block | undefined;
  readonly inputs: StepInputs;
  readonly context: StepContext;
  readonly started: Fact;
  readonly ended: (result: BlockResultType) => Fact;
};

/**
 * The run's loop: read the log, ask `decide`, do what it says, append what happened. Everything
 * that reads, appends or runs a block is an activity, so a replay after a wake or a crash does
 * none of it twice, and everything else here is a pure function of what the activities returned.
 */
const runWorkflow = ({ runId }: { readonly runId: RunId }) =>
  Effect.gen(function* () {
    const log = yield* RunLog;
    const blocks = yield* Blocks;
    const stuck = (reason: RunStuck["reason"], detail: unknown) =>
      new RunStuck({
        runId,
        reason,
        detail: typeof detail === "string" ? detail : JSON.stringify(detail),
      });

    const document = yield* Activity.make({
      name: "recipe",
      success: Recipe,
      error: RunNotFound,
      execute: log.recipe(runId),
    });
    const validated = validate(document, blocks.specs);
    if (Result.isFailure(validated)) {
      return yield* stuck("RecipeNoLongerValid", validated.failure);
    }
    const valid: ValidRecipe = validated.success;

    /** Appends a fact, and says whether the log took it. A rejection is an answer, not a failure. */
    const append = (turn: number, key: string, fact: Fact) =>
      Activity.make({
        name: `${turn}/append/${key}`,
        success: RunEvent,
        error: AppendFailed,
        execute: log.append(runId, fact, key),
      }).pipe(
        Effect.as(Option.none<EventRejected>()),
        Effect.catchTag("EventRejected", (rejected) => Effect.succeedSome(rejected)),
      );

    const jobOf = (
      values: RunValues,
      step: ResolvedStep,
      work: Work,
      as:
        | { readonly _tag: "Step"; readonly phase: "Main" | "Finally" }
        | { readonly _tag: "Undo"; readonly undo: ResolvedUndo },
    ): Job => {
      const phase: KeyPhase = as._tag === "Undo" ? "Undo" : "Forward";
      const key = idempotencyKey(runId, step.step.id, phase, work.item);
      const place = placeOf(step, work);
      const failure = (result: Extract<BlockResultType, { readonly _tag: "Failed" }>) => ({
        error: result.error,
        // The failure of the last attempt allowed is final, whatever the block said, so the log
        // never shows a failure that may be retried and was not (M2 decision 9).
        retryable: result.retryable && work.attempt < retryPolicy.maxAttempts,
      });
      const context: StepContext = {
        runId,
        step: step.step.id,
        item: Option.fromUndefinedOr(work.item),
        phase,
        attempt: work.attempt,
        idempotencyKey: key,
      };
      if (as._tag === "Undo") {
        const { undo } = as;
        return {
          step,
          work,
          phase,
          block: blocks.find(undo.block.id, undo.block.version),
          inputs: undoInputsOf(valid.resolved, step, undo, values, work.item),
          context,
          started: { _tag: "UndoStarted", ...place, idempotencyKey: key },
          ended: (result) =>
            result._tag === "Succeeded"
              ? { _tag: "UndoSucceeded", ...place }
              : { _tag: "UndoFailed", ...place, ...failure(result) },
        };
      }
      return {
        step,
        work,
        phase,
        block: blocks.find(step.block.id, step.block.version),
        inputs: inputsOf(valid.resolved, step, values, work.item),
        context,
        started: { _tag: "StepStarted", phase: as.phase, ...place, idempotencyKey: key },
        ended: (result) =>
          result._tag === "Succeeded"
            ? { _tag: "StepSucceeded", ...place, outputs: result.outputs }
            : { _tag: "StepFailed", ...place, ...failure(result) },
      };
    };

    /**
     * Does a batch of work: waits out each retry's delay, appends every start in order, then runs
     * the blocks side by side and appends each end as it comes. A start the log refuses is not
     * run. Returns the rejections.
     */
    const perform = (turn: number, jobs: ReadonlyArray<Job>) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          jobs,
          ({ context }) =>
            DurableClock.sleep({
              name: `retry/${context.idempotencyKey}/${context.attempt}`,
              duration: delayBefore(context.attempt),
            }),
          { concurrency: maxSideBySide, discard: true },
        );
        const rejections: Array<EventRejected> = [];
        const begun: Array<Job> = [];
        for (const job of jobs) {
          const { attempt, idempotencyKey: key } = job.context;
          const rejected = yield* append(turn, `started/${key}/${attempt}`, job.started);
          if (Option.isSome(rejected)) {
            rejections.push(rejected.value);
          } else {
            begun.push(job);
          }
        }
        const ends = yield* Effect.forEach(
          begun,
          (job) =>
            Effect.gen(function* () {
              const { attempt, idempotencyKey: key } = job.context;
              const { block } = job;
              const result = yield* Activity.make({
                name: `block/${key}/${attempt}`,
                success: BlockResult,
                execute:
                  block === undefined
                    ? Effect.succeed<BlockResultType>({
                        _tag: "Failed",
                        error: {
                          name: "BlockNotImplemented",
                          message: "This engine has no code for the block.",
                        },
                        retryable: false,
                      })
                    : runBlock(block, job.inputs, job.context),
              });
              return yield* append(turn, `ended/${key}/${attempt}`, job.ended(result));
            }),
          { concurrency: maxSideBySide },
        );
        return [...rejections, ...ends.flatMap((rejected) => Option.toArray(rejected))];
      });

    /** Acts on one decision, and says what came of it. */
    const act = (
      turn: number,
      decision: Decision,
      values: RunValues,
      woken: ReadonlySet<string>,
    ): Effect.Effect<
      Acted,
      RunStuck | RunNotFound,
      BlockServices | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    > =>
      Effect.gen(function* () {
        switch (decision._tag) {
          case "Ended": {
            return { _tag: "Ended" };
          }
          case "AwaitStart": {
            return yield* stuck("NotStarted", "The log has no RunStarted.");
          }
          case "AwaitWork": {
            return yield* stuck("WorkLeftOpen", "The log holds work the workflow did not end.");
          }
          case "RunSteps": {
            const { phase, step, work } = decision;
            return appended(
              yield* perform(
                turn,
                work.map((each) => jobOf(values, step, each, { _tag: "Step", phase })),
              ),
            );
          }
          case "RunUndo": {
            return appended(
              yield* perform(turn, [
                jobOf(values, decision.step, decision.work, { _tag: "Undo", undo: decision.undo }),
              ]),
            );
          }
          case "OpenGate": {
            const step = decision.step.step.id;
            return appended(
              one(
                yield* append(turn, `gate/${step}/opened`, {
                  _tag: "GateOpened",
                  step,
                  attempt: 1,
                }),
              ),
            );
          }
          case "AwaitGate": {
            const step = decision.step.step.id;
            // The wake is given only once the log shows the gate closed or cancelled. Waking to
            // find it still open would spin: the wake has been spent.
            if (woken.has(step)) {
              return yield* stuck("GateWokenWhileOpen", step);
            }
            yield* DurableDeferred.await(gateOf(step));
            return { _tag: "Woken", step };
          }
          case "EndMainPhase": {
            return appended(
              one(
                yield* append(turn, "main-ended", { _tag: "MainPhaseEnded", main: decision.main }),
              ),
            );
          }
          case "EndRun": {
            return appended(one(yield* append(turn, "ended", { _tag: decision.event })));
          }
        }
      });

    const woken = new Set<string>();
    let refusedBefore: ReadonlyArray<EventRejected> = [];
    for (let turn = 0; ; turn += 1) {
      const events: ReadonlyArray<RunEventType> = yield* Activity.make({
        name: `${turn}/read`,
        success: Schema.Array(RunEvent),
        error: RunNotFound,
        execute: Effect.map(log.read(runId), (record) => record.events),
      });
      const state = replay(events);
      if (Result.isFailure(state)) {
        return yield* stuck("LogDoesNotReplay", state.failure);
      }
      const values = valuesOf(events);
      const decision = decide(valid, state.success, (step) => sizeOf(valid.resolved, step, values));
      const outcome = yield* act(turn, decision, values, woken);
      if (outcome._tag === "Ended") {
        return;
      }
      if (outcome._tag === "Woken") {
        woken.add(outcome.step);
        continue;
      }
      // The log may have moved between the read and the append: a cancel landed, say. So the
      // first refusal means "read again and decide again". A second in a row, of what `decide`
      // said after reading again, is the engine's own bug.
      if (outcome.refused.length > 0 && refusedBefore.length > 0) {
        return yield* stuck("RejectedTwice", outcome.refused);
      }
      refusedBefore = outcome.refused;
    }
  }).pipe(
    Effect.catchTag("RunNotFound", () =>
      Effect.fail(new RunStuck({ runId, reason: "LogMissing", detail: "The run has no log." })),
    ),
  );

/** Registers the run workflow with whichever workflow engine is provided. */
export const RunWorkflowLayer = RunWorkflow.toLayer(runWorkflow);
