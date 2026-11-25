import type { EventRejected, RunEvent, RunId, RunState, StepId } from "@aemeth/core";
import {
  Actor,
  inputProblems,
  Inputs,
  namesOf,
  Outputs,
  own,
  validateDocument,
  valueFits,
} from "@aemeth/core";
import { Context, Effect, Layer, Option, Result, Schema } from "effect";
import type { WorkflowEngine } from "effect/workflow";
import { DurableDeferred } from "effect/workflow";
import { makeRunId } from "./runId";
import type { Fact, RunNotFound, RunRecord } from "./RunLog";
import { RunLog } from "./RunLog";
import { gateOf, RunWorkflow } from "./RunWorkflow";
import { Blocks, Recipes } from "./services";

/** A run that was not started, and why. Nothing was created. */
export class RunRefused extends Schema.TaggedError<RunRefused, { readonly brand: unique symbol }>()(
  "RunRefused",
  {
    reason: Schema.Literals(["RecipeNotFound", "RecipeInvalid", "InputsInvalid"]),
    /** The validator's failure or the input problems, as JSON. */
    detail: Schema.String,
  },
) {}

/**
 * An approval or a denial that was not recorded: the step is not a gate, what was approved does
 * not fit it, or the gate already has a different answer.
 */
export class ApprovalRefused extends Schema.TaggedError<
  ApprovalRefused,
  { readonly brand: unique symbol }
>()("ApprovalRefused", {
  /** `AlreadyAnswered`: the gate was closed before, by someone else or with something else. */
  reason: Schema.Literals(["NotAGate", "OutputsDoNotFit", "AlreadyAnswered"]),
  step: Schema.String,
}) {}

/** A caller the log cannot name: `by` is blank, or longer than an identity can be. */
export class ActorRefused extends Schema.TaggedError<
  ActorRefused,
  { readonly brand: unique symbol }
>()("ActorRefused", {}) {}

/**
 * Wakes the run that waits at a gate. Its own service so that a test can lose a wake, as a
 * Worker that dies between the append and the wake does.
 */
export class Waker extends Context.Service<
  Waker,
  { readonly wake: (runId: RunId, step: StepId) => Effect.Effect<void> }
>()("@aemeth/engine/Waker") {
  static readonly layer: Layer.Layer<Waker, never, WorkflowEngine.WorkflowEngine> = Layer.effect(
    Waker,
  )(
    Effect.gen(function* () {
      const context = yield* Effect.context<WorkflowEngine.WorkflowEngine>();
      return Waker.of({
        wake: (runId, step) =>
          Effect.gen(function* () {
            const gate = gateOf(step);
            const executionId = yield* RunWorkflow.executionId({ runId });
            const token = DurableDeferred.tokenFromExecutionId(gate, {
              workflow: RunWorkflow,
              executionId,
            });
            yield* DurableDeferred.succeed(gate, { token, value: undefined });
          }).pipe(Effect.provideContext(context)),
      });
    }),
  );
}

/**
 * The engine, as everything outside it sees it: start a run, close a gate, cancel, read
 * (decision 0003). The workflow module does not show through; the API in Part C is these calls
 * behind routes.
 */
export class Engine extends Context.Service<
  Engine,
  {
    /** Starts a run of a recipe and returns its id. The run goes on by itself from there. */
    readonly start: (
      recipeId: string,
      inputs: { readonly [name: string]: Schema.Json },
    ) => Effect.Effect<RunId, RunRefused>;
    /** Records who approved a gate and what they approved, and lets the run go on. */
    readonly approve: (
      runId: RunId,
      step: StepId,
      by: string,
      outputs: { readonly [name: string]: Schema.Json },
    ) => Effect.Effect<RunEvent, RunNotFound | EventRejected | ApprovalRefused | ActorRefused>;
    readonly deny: (
      runId: RunId,
      step: StepId,
      by: string,
    ) => Effect.Effect<RunEvent, RunNotFound | EventRejected | ApprovalRefused | ActorRefused>;
    /** Records a request to cancel. It takes effect between steps and at a gate, or not at all. */
    readonly cancel: (
      runId: RunId,
      by: string,
    ) => Effect.Effect<RunEvent, RunNotFound | EventRejected | ActorRefused>;
    /**
     * The run's events and the state they lead to. Reading a run also repairs it: a wake that
     * was lost is given again, and a run that was recorded and never set going is set going.
     */
    readonly read: (runId: RunId) => Effect.Effect<RunRecord, RunNotFound>;
  }
>()("@aemeth/engine/Engine") {}

const refused = (reason: RunRefused["reason"], detail: unknown) =>
  new RunRefused({ reason, detail: JSON.stringify(detail) });

const decodeInputs = Schema.decodeUnknownResult(Inputs);
const decodeOutputs = Schema.decodeUnknownResult(Outputs);

const decodeActor = Schema.decodeUnknownResult(Actor);

/** The caller as the log will record them, or a refusal for one it could not. */
const actorOf = (by: string): Effect.Effect<string, ActorRefused> =>
  Result.isSuccess(decodeActor(by)) ? Effect.succeed(by) : Effect.fail(new ActorRefused());

// `Array.isArray` does not narrow a readonly array out of a union.
const isList = (json: Schema.Json): json is ReadonlyArray<Schema.Json> => Array.isArray(json);

/** Whether two JSON values are the same, whatever order their fields were written in. */
const sameJson = (a: Schema.Json, b: Schema.Json): boolean => {
  if (isList(a) || isList(b)) {
    return (
      isList(a) &&
      isList(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index] ?? null))
    );
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return a === b;
  }
  const fields = Object.entries(a);
  return (
    fields.length === Object.keys(b).length &&
    fields.every(([key, value]) => {
      const other = own(b, key);
      return other !== undefined && sameJson(value, other);
    })
  );
};

/**
 * The gate whose closing or cancelling the run has yet to be woken for, if there is one. Only
 * while the gate is the latest thing in the log's main phase: once a step has started after it,
 * the workflow is awake, and a wake would be a wasted call.
 */
const gateToWake = (state: RunState): Option.Option<StepId> => {
  if (state._tag !== "Running" && state._tag !== "WaitingForApproval") {
    return Option.none();
  }
  const gate = state.run.attempts.at(-1);
  const due =
    gate?._tag === "Gate" &&
    (gate.status === "Approved" ||
      gate.status === "Denied" ||
      // A cancel closes a waiting gate, unless a failure handler is running (M1 decision 18).
      (gate.status === "Open" && state.track === "CancelRequested"));
  return due === true ? Option.some(gate.step) : Option.none();
};

export const layer: Layer.Layer<
  Engine,
  never,
  RunLog | Recipes | Blocks | Waker | WorkflowEngine.WorkflowEngine
> = Layer.effect(Engine)(
  Effect.gen(function* () {
    const log = yield* RunLog;
    const recipes = yield* Recipes;
    const blocks = yield* Blocks;
    const waker = yield* Waker;
    const context = yield* Effect.context<WorkflowEngine.WorkflowEngine>();

    /**
     * Wakes the run if its log shows a gate closed, or cancelled while it waits. Called after
     * every append here and on every read, so a wake lost with a dying Worker is given again by
     * the next contact (M2 decision 19). A wake given twice does nothing.
     */
    /** Sets the run's workflow going. Asking again for a run that is going does nothing. */
    const drive = (runId: RunId) =>
      RunWorkflow.execute({ runId }, { discard: true }).pipe(Effect.provideContext(context));

    const read = (runId: RunId) =>
      Effect.tap(log.read(runId), ({ events, state }) =>
        // A log that holds `RunStarted` and nothing else may belong to a run whose Worker died
        // between recording it and setting it going. Nothing else would ever drive it.
        Effect.andThen(
          events.length === 1 ? drive(runId) : Effect.void,
          Option.match(gateToWake(state), {
            onNone: () => Effect.void,
            onSome: (step) => waker.wake(runId, step),
          }),
        ),
      );

    /** Appends, and wakes the run if that is due, whether or not the log took this fact. */
    const record = (runId: RunId, fact: Fact, key: string) =>
      Effect.ensuring(log.append(runId, fact, key), Effect.ignore(read(runId)));

    /**
     * Answers a gate. The same answer given again returns the first, which is how a caller
     * repairs a lost wake. A different one (another person, other things approved) is refused:
     * the log holds one answer per gate, and returning it would look like agreement.
     */
    const answer = (
      runId: RunId,
      step: StepId,
      fact: Extract<Fact, { readonly _tag: "ApprovalGranted" | "ApprovalDenied" }>,
      key: string,
    ) =>
      Effect.flatMap(record(runId, fact, key), (event) => {
        const same =
          (event._tag === "ApprovalGranted" || event._tag === "ApprovalDenied") &&
          event.by === fact.by &&
          (event._tag !== "ApprovalGranted" ||
            fact._tag !== "ApprovalGranted" ||
            sameJson(event.outputs, fact.outputs));
        return same
          ? Effect.succeed(event)
          : Effect.fail(new ApprovalRefused({ reason: "AlreadyAnswered", step }));
      });

    return Engine.of({
      start: Effect.fnUntraced(function* (recipeId, inputs) {
        const document = yield* recipes.find(recipeId);
        if (document === undefined) {
          return yield* refused("RecipeNotFound", recipeId);
        }
        const valid = validateDocument(document, blocks.specs);
        if (Result.isFailure(valid)) {
          return yield* refused("RecipeInvalid", valid.failure);
        }
        const problems = inputProblems(valid.success.recipe, inputs);
        const given = decodeInputs(inputs);
        if (problems.length > 0 || Result.isFailure(given)) {
          return yield* refused("InputsInvalid", problems);
        }
        const runId = yield* makeRunId;
        yield* log.open(runId, valid.success.recipe);
        // The log was opened a line above, and a new log takes `RunStarted`.
        yield* Effect.orDie(
          log.append(runId, { _tag: "RunStarted", inputs: given.success }, "started"),
        );
        yield* drive(runId);
        return runId;
      }),
      approve: Effect.fnUntraced(function* (runId, step, caller, outputs) {
        const by = yield* actorOf(caller);
        const recipe = yield* log.recipe(runId);
        const node = recipe.nodes.find((candidate) => candidate.id === step);
        const spec = node === undefined ? undefined : blocks.find(node.block, node.version)?.spec;
        if (spec?.kind !== "Gate") {
          return yield* new ApprovalRefused({ reason: "NotAGate", step });
        }
        const approved = decodeOutputs(outputs);
        const declared = namesOf(spec.outputs);
        const fits =
          declared.length === Object.keys(outputs).length &&
          declared.every(([name, type]) => {
            const value = own(outputs, name);
            return value !== undefined && valueFits(type, value);
          });
        if (!fits || Result.isFailure(approved)) {
          return yield* new ApprovalRefused({ reason: "OutputsDoNotFit", step });
        }
        return yield* answer(
          runId,
          step,
          { _tag: "ApprovalGranted", step, attempt: 1, by, outputs: approved.success },
          `gate/${step}/granted`,
        );
      }),
      deny: (runId, step, caller) =>
        Effect.flatMap(actorOf(caller), (by) =>
          answer(
            runId,
            step,
            { _tag: "ApprovalDenied", step, attempt: 1, by },
            `gate/${step}/denied`,
          ),
        ),
      cancel: (runId, caller) =>
        Effect.flatMap(actorOf(caller), (by) =>
          record(runId, { _tag: "CancellationRequested", by }, `cancel/${by}`),
        ),
      read,
    });
  }),
);
