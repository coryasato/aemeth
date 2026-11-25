import type { BlockOutputs } from "@aemeth/blocks";
import { implement } from "@aemeth/blocks";
import type { EventRejected, Recipe, RunEvent } from "@aemeth/core";
import { RunId, StepId } from "@aemeth/core";
import {
  block,
  chain,
  database,
  each,
  edge,
  failed,
  fromRecipe,
  fromStep,
  item,
  list,
  maybeFromStep,
  recipe,
  step,
} from "@aemeth/core/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Engine, RunLog } from "./index";
import type { Execution, Kit } from "./testing/kit";
import {
  brief,
  failWith,
  finished,
  fitting,
  logWhen,
  secretLink,
  settle,
  Stage,
  waiting,
  withEngine,
  workflowOutcome,
} from "./testing/kit";

const stepId = Schema.decodeSync(StepId);
const orphan = Schema.decodeSync(RunId)("orphan-1");
const by = "ada@example.com";
const db = (id: string) => ({ kind: "test.database", id });

/** `a` (has an undo) → `b`, then `f` and `g` whatever happened. */
const line: Recipe = recipe({
  id: "line",
  start: "a",
  nodes: [step("a", "t.undoable"), step("b", "t.act"), step("f", "t.act"), step("g", "t.act")],
  edges: chain("a", "b"),
  finally: ["f", "g"],
});

/** `a` → gate `ok`: approved → `b`; denied → `h`, the handler, and a failed end that skips undo. */
const gated: Recipe = recipe({
  id: "gated",
  start: "a",
  nodes: [
    step("a", "t.undoable"),
    step("ok", "t.gate"),
    step("b", "t.act"),
    step("h", "t.act"),
    step("f", "t.act"),
  ],
  edges: [
    edge("a", "Succeeded", "ok"),
    edge("ok", "Approved", "b"),
    edge("ok", "Denied", "h"),
    edge("h", "Succeeded", failed("Skip")),
  ],
  finally: ["f"],
});

/** `a` → `e`, once per thing → `c` → `b`. All but `b` have an undo. */
const undoing: Recipe = recipe({
  id: "undoing",
  start: "a",
  inputs: { things: { type: list(database) } },
  nodes: [
    step("a", "t.undoable"),
    step("e", "t.each", { thing: item }, each(fromRecipe("things"))),
    step("c", "t.undoable"),
    step("b", "t.act"),
    step("f", "t.act"),
  ],
  edges: chain("a", "e", "c", "b"),
  finally: ["f"],
});

const failing =
  (steps: ReadonlyArray<string>, retryable = false) =>
  ({ block: blockId, step: at }: Execution) =>
    steps.includes(`${at.phase === "Undo" ? "undo " : ""}${at.step}`)
      ? failWith("Broke", retryable)
      : Effect.succeed(fitting(blockId));

/** Starts a run of a recipe on the kit's engine. */
const start = (
  kit: Kit,
  document: Recipe,
  inputs: Parameters<Engine["Service"]["start"]>[1] = {},
) =>
  Effect.gen(function* () {
    const engine = yield* Engine;
    kit.recipes.set(document.id, document);
    return yield* engine.start(document.id, inputs);
  });

const briefly = (events: ReadonlyArray<RunEvent>): ReadonlyArray<string> => events.map(brief);

describe("the engine, on the in-memory workflow engine", () => {
  describe("a run to each final state", () => {
    it.effect("succeeds, with every transition in its log", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const runId = yield* start(kit, line);
          const events = yield* finished(runId);
          expect(briefly(events)).toEqual([
            "RunStarted",
            "StepStarted a@1",
            "StepSucceeded a@1",
            "StepStarted b@1",
            "StepSucceeded b@1",
            "MainPhaseEnded Succeeded",
            "StepStarted f@1",
            "StepSucceeded f@1",
            "StepStarted g@1",
            "StepSucceeded g@1",
            "RunSucceeded",
          ]);
          expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
          expect(new Set(events.map((event) => event.runId))).toEqual(new Set([runId]));
          expect(events[0]?.recipe).toEqual({ id: "line", version: 1 });
          expect((yield* engine.read(runId)).state._tag).toBe("Succeeded");
          expect(yield* workflowOutcome(runId)).toBe("Complete");
          expect(kit.executions.map((execution) => execution.step.step)).toEqual([
            "a",
            "b",
            "f",
            "g",
          ]);
        }),
      ),
    );

    it.effect("fails, undoing what succeeded and still running the finally steps", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          kit.behaviour = failing(["b"]);
          const runId = yield* start(kit, line);
          expect(briefly(yield* finished(runId))).toEqual([
            "RunStarted",
            "StepStarted a@1",
            "StepSucceeded a@1",
            "StepStarted b@1",
            "StepFailed b@1 Broke",
            "MainPhaseEnded Failed Run",
            "UndoStarted a@1",
            "UndoSucceeded a@1",
            "StepStarted f@1",
            "StepSucceeded f@1",
            "StepStarted g@1",
            "StepSucceeded g@1",
            "RunFailed",
          ]);
          // The undo ran the undo block, under the undo's own key.
          const undo = kit.executions.find((execution) => execution.step.phase === "Undo");
          expect(undo?.block).toBe("t.act");
          expect(undo?.step.idempotencyKey).toBe(`${runId}:a:Undo`);
        }),
      ),
    );

    it.effect("is cancelled between steps, and cleans up like a failure", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const cancelled: Array<string> = [];
          // The cancel arrives while `a` is in flight. `a` finishes, and `b` never starts.
          kit.behaviour = (execution) =>
            execution.step.step === "a" && execution.step.phase === "Forward"
              ? Effect.as(
                  Effect.orDie(engine.cancel(execution.step.runId, by)).pipe(
                    Effect.tap((event) => Effect.sync(() => cancelled.push(event._tag))),
                  ),
                  {},
                )
              : Effect.succeed({});
          const runId = yield* start(kit, line);
          expect(briefly(yield* finished(runId))).toEqual([
            "RunStarted",
            "StepStarted a@1",
            "CancellationRequested",
            "StepSucceeded a@1",
            "MainPhaseEnded Cancelled",
            "UndoStarted a@1",
            "UndoSucceeded a@1",
            "StepStarted f@1",
            "StepSucceeded f@1",
            "StepStarted g@1",
            "StepSucceeded g@1",
            "RunCancelled",
          ]);
          expect(cancelled).toEqual(["CancellationRequested"]);
        }),
      ),
    );

    it.effect("needs attention after a failed cleanup, with every other cleanup still run", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          kit.behaviour = failing(["b", "undo a", "f"]);
          const runId = yield* start(kit, line);
          expect(briefly(yield* finished(runId))).toEqual([
            "RunStarted",
            "StepStarted a@1",
            "StepSucceeded a@1",
            "StepStarted b@1",
            "StepFailed b@1 Broke",
            "MainPhaseEnded Failed Run",
            "UndoStarted a@1",
            "UndoFailed a@1 Broke",
            "StepStarted f@1",
            "StepFailed f@1 Broke",
            "StepStarted g@1",
            "StepSucceeded g@1",
            "RunFlaggedForAttention",
          ]);
          expect((yield* engine.read(runId)).state).toMatchObject({
            _tag: "NeedsAttention",
            main: "Failed",
          });
        }),
      ),
    );
  });

  describe("a gate", () => {
    it.effect("waits, and goes on when approved, recording who approved", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const runId = yield* start(kit, gated);
          expect(briefly(yield* waiting(runId))).toEqual([
            "RunStarted",
            "StepStarted a@1",
            "StepSucceeded a@1",
            "GateOpened ok",
          ]);
          yield* settle;
          expect((yield* engine.read(runId)).state._tag).toBe("WaitingForApproval");
          const granted = yield* engine.approve(runId, stepId("ok"), by, {});
          expect(granted).toMatchObject({ _tag: "ApprovalGranted", step: "ok", by, seq: 4 });
          expect(briefly(yield* finished(runId)).slice(4)).toEqual([
            "ApprovalGranted ok",
            "StepStarted b@1",
            "StepSucceeded b@1",
            "MainPhaseEnded Succeeded",
            "StepStarted f@1",
            "StepSucceeded f@1",
            "RunSucceeded",
          ]);
        }),
      ),
    );

    it.effect("runs the recipe's handler when denied", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const runId = yield* start(kit, gated);
          yield* waiting(runId);
          expect(yield* engine.deny(runId, stepId("ok"), by)).toMatchObject({
            _tag: "ApprovalDenied",
            by,
          });
          expect(briefly(yield* finished(runId)).slice(4)).toEqual([
            "ApprovalDenied ok",
            "StepStarted h@1",
            "StepSucceeded h@1",
            // The handler put things right: the end skips undo, so `a` is not undone.
            "MainPhaseEnded Failed Skip",
            "StepStarted f@1",
            "StepSucceeded f@1",
            "RunFailed",
          ]);
        }),
      ),
    );

    it.effect("is closed by a cancel while it waits", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const runId = yield* start(kit, gated);
          yield* waiting(runId);
          yield* engine.cancel(runId, by);
          expect(briefly(yield* finished(runId)).slice(4)).toEqual([
            "CancellationRequested",
            "MainPhaseEnded Cancelled",
            "UndoStarted a@1",
            "UndoSucceeded a@1",
            "StepStarted f@1",
            "StepSucceeded f@1",
            "RunCancelled",
          ]);
        }),
      ),
    );

    it.effect(
      "answers the same approval again with the first, and refuses a different answer",
      () =>
        withEngine((kit) =>
          Effect.gen(function* () {
            const engine = yield* Engine;
            const runId = yield* start(kit, gated);
            yield* waiting(runId);
            const first = yield* engine.approve(runId, stepId("ok"), by, {});
            const second = yield* engine.approve(runId, stepId("ok"), by, {});
            expect(second).toEqual(first);
            // Someone else approving a gate that is closed is told so: nothing of theirs is recorded.
            const other = yield* Effect.flip(
              engine.approve(runId, stepId("ok"), "grace@example.com", {}),
            );
            expect(other).toMatchObject({ _tag: "ApprovalRefused", reason: "AlreadyAnswered" });
            const denial = yield* Effect.flip(engine.deny(runId, stepId("ok"), by));
            expect(denial).toMatchObject({ _tag: "EventRejected", event: "ApprovalDenied" });
            const events = yield* finished(runId);
            expect(events.filter((event) => event._tag === "ApprovalGranted")).toHaveLength(1);
            expect(events.at(-1)?._tag).toBe("RunSucceeded");
          }),
        ),
    );

    it.effect("refuses an approval of a step that is not a gate, or of the wrong things", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const runId = yield* start(kit, gated);
          yield* waiting(runId);
          for (const [id, outputs, reason] of [
            ["a", {}, "NotAGate"],
            ["nowhere", {}, "NotAGate"],
            ["ok", { extra: 1 }, "OutputsDoNotFit"],
          ] as const) {
            const refusal = yield* Effect.flip(engine.approve(runId, stepId(id), by, outputs));
            expect(refusal).toMatchObject({ _tag: "ApprovalRefused", reason, step: id });
          }
          expect((yield* engine.read(runId)).state._tag).toBe("WaitingForApproval");
          yield* engine.approve(runId, stepId("ok"), by, {});
          yield* finished(runId);
        }),
      ),
    );

    // `a` fails → `ok`, a gate inside the failure handler → `h`.
    const handled: Recipe = recipe({
      id: "handled",
      start: "a",
      nodes: [step("a", "t.act"), step("ok", "t.gate"), step("h", "t.act")],
      edges: [edge("a", "Failed", "ok"), edge("ok", "Approved", "h")],
    });

    it.effect("is not closed by a cancel inside a failure handler, and the run does not spin", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          kit.behaviour = failing(["a"]);
          const runId = yield* start(kit, handled);
          yield* waiting(runId);
          yield* engine.cancel(runId, by);
          yield* settle;
          expect((yield* engine.read(runId)).state).toMatchObject({
            _tag: "WaitingForApproval",
            track: "Handling",
          });
          expect(yield* workflowOutcome(runId)).toBe("Running");
          yield* engine.approve(runId, stepId("ok"), by, {});
          expect(briefly(yield* finished(runId)).slice(-5)).toEqual([
            "ApprovalGranted ok",
            "StepStarted h@1",
            "StepSucceeded h@1",
            "MainPhaseEnded Succeeded",
            "RunSucceeded",
          ]);
        }),
      ),
    );
  });

  describe("a caller the log cannot name", () => {
    it.effect.each<readonly [string, string]>([
      ["blank", "   "],
      ["empty", ""],
      ["longer than an identity can be", "a".repeat(321)],
    ])("is refused, not a crash, when it is %s", ([, caller]) =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const runId = yield* start(kit, gated);
          const before = yield* waiting(runId);
          const refusals = yield* Effect.all([
            Effect.flip(engine.cancel(runId, caller)),
            Effect.flip(engine.approve(runId, stepId("ok"), caller, {})),
            Effect.flip(engine.deny(runId, stepId("ok"), caller)),
          ]);
          expect(refusals.map((refusal) => refusal._tag)).toEqual([
            "ActorRefused",
            "ActorRefused",
            "ActorRefused",
          ]);
          expect((yield* engine.read(runId)).events).toEqual(before);
          yield* engine.approve(runId, stepId("ok"), "a".repeat(320), {});
          yield* finished(runId);
        }),
      ),
    );
  });

  describe("a gate that already has its answer", () => {
    // `g` approves a list and a note: what was approved is part of the answer.
    const choosing: Recipe = recipe({ id: "choosing", start: "g", nodes: [step("g", "t.choose")] });
    const chosen = { chosen: [db("a"), db("b")], note: { reason: "ok", count: 2 } };

    it.effect("takes the same things again in any order of fields, and refuses other things", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const runId = yield* start(kit, choosing);
          yield* waiting(runId);
          const first = yield* engine.approve(runId, stepId("g"), by, chosen);
          const again = yield* engine.approve(runId, stepId("g"), by, {
            note: { count: 2, reason: "ok" },
            chosen: [db("a"), db("b")],
          });
          expect(again).toEqual(first);
          for (const different of [
            { ...chosen, chosen: [db("b"), db("a")] },
            { ...chosen, chosen: [db("a")] },
            { ...chosen, chosen: [db("a"), db("b"), db("c")] },
            { ...chosen, note: { reason: "ok", count: 3 } },
            { ...chosen, note: { reason: "no", count: 2 } },
          ]) {
            const refusal = yield* Effect.flip(engine.approve(runId, stepId("g"), by, different));
            expect(refusal).toMatchObject({ _tag: "ApprovalRefused", reason: "AlreadyAnswered" });
          }
          const events = yield* finished(runId);
          expect(events.filter((event) => event._tag === "ApprovalGranted")).toHaveLength(1);
        }),
      ),
    );

    it.effect("refuses a second denial by someone else, and takes the same one again", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const runId = yield* start(kit, gated);
          yield* waiting(runId);
          const first = yield* engine.deny(runId, stepId("ok"), by);
          expect(yield* engine.deny(runId, stepId("ok"), by)).toEqual(first);
          expect(
            yield* Effect.flip(engine.deny(runId, stepId("ok"), "grace@example.com")),
          ).toMatchObject({ _tag: "ApprovalRefused", reason: "AlreadyAnswered" });
          yield* finished(runId);
        }),
      ),
    );
  });

  describe("a run that was recorded and never set going", () => {
    it.effect("is set going by a read", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const log = yield* RunLog;
          // What a Worker leaves that dies in `start` after the log took `RunStarted`.
          const runId = orphan;
          yield* log.open(runId, line);
          yield* log.append(runId, { _tag: "RunStarted", inputs: {} }, "started");
          yield* settle;
          expect(briefly((yield* log.read(runId)).events)).toEqual(["RunStarted"]);
          expect((yield* engine.read(runId)).state._tag).toBe("Running");
          expect(briefly(yield* finished(runId)).at(-1)).toBe("RunSucceeded");
          // Reading it again starts nothing twice.
          yield* engine.read(runId);
          expect(kit.executions.map((execution) => execution.step.step)).toEqual([
            "a",
            "b",
            "f",
            "g",
          ]);
        }),
      ),
    );
  });

  describe("a wake", () => {
    it.effect("is not sent again once a step has started after the gate", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          let held = true;
          // `b` holds the run in its main phase after the gate, as a long step would.
          kit.behaviour = ({ block: blockId, step: at }) =>
            at.step === "b"
              ? Effect.as(Effect.repeat(settle, { until: () => !held }), fitting(blockId))
              : Effect.succeed(fitting(blockId));
          const runId = yield* start(kit, gated);
          yield* waiting(runId);
          yield* engine.approve(runId, stepId("ok"), by, {});
          yield* logWhen(runId, (_, events) => briefly(events).includes("StepStarted b@1"));
          const sent = kit.wakes;
          expect(sent).toBeGreaterThan(0);
          yield* engine.read(runId);
          yield* engine.read(runId);
          expect(kit.wakes).toBe(sent);
          held = false;
          yield* finished(runId);
        }),
      ),
    );
  });

  describe("a wake that was lost", () => {
    it.effect("is given again by a second approval", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const runId = yield* start(kit, gated);
          yield* waiting(runId);
          kit.wakesToLose = 1;
          const first = yield* engine.approve(runId, stepId("ok"), by, {});
          yield* settle;
          // The approval is in the log, and the run is still asleep at its gate.
          const { events } = yield* Effect.flatMap(RunLog, (log) => log.read(runId));
          expect(briefly(events).at(-1)).toBe("ApprovalGranted ok");
          expect(yield* engine.approve(runId, stepId("ok"), by, {})).toEqual(first);
          expect(briefly(yield* finished(runId)).at(-1)).toBe("RunSucceeded");
        }),
      ),
    );

    it.effect("is given again by a read of the run", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const runId = yield* start(kit, gated);
          yield* waiting(runId);
          kit.wakesToLose = 1;
          yield* engine.deny(runId, stepId("ok"), by);
          yield* settle;
          const log = yield* RunLog;
          expect(briefly((yield* log.read(runId)).events).at(-1)).toBe("ApprovalDenied ok");
          expect((yield* engine.read(runId)).state._tag).toBe("Running");
          expect(briefly(yield* finished(runId)).at(-1)).toBe("RunFailed");
        }),
      ),
    );

    it.effect("is given again by a read after a cancel at a gate", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const runId = yield* start(kit, gated);
          yield* waiting(runId);
          kit.wakesToLose = 1;
          yield* engine.cancel(runId, by);
          yield* settle;
          const log = yield* RunLog;
          expect(briefly((yield* log.read(runId)).events).at(-1)).toBe("CancellationRequested");
          yield* engine.read(runId);
          expect(briefly(yield* finished(runId)).at(-1)).toBe("RunCancelled");
        }),
      ),
    );
  });

  describe("undo", () => {
    const things = [db("t0"), db("t1"), db("t2"), db("t3"), db("t4"), db("t5")];

    it.effect("runs in reverse order, item by item, each fed from the step it undoes", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          kit.behaviour = failing(["b"]);
          const runId = yield* start(kit, undoing, { things });
          const events = yield* finished(runId);
          expect(briefly(events).filter((line) => line.startsWith("Undo"))).toEqual([
            "UndoStarted c@1",
            "UndoSucceeded c@1",
            ...[5, 4, 3, 2, 1, 0].flatMap((index) => [
              `UndoStarted e#${index}@1`,
              `UndoSucceeded e#${index}@1`,
            ]),
            "UndoStarted a@1",
            "UndoSucceeded a@1",
          ]);
          expect(events.at(-1)?._tag).toBe("RunFailed");
          const undos = kit.executions.filter(
            (execution) => execution.step.phase === "Undo" && execution.step.step === "e",
          );
          expect(undos.map((execution) => execution.block)).toEqual(undos.map(() => "t.uneach"));
          expect(undos.map((execution) => execution.inputs.required)).toEqual(
            things.toReversed().map((thing) => ({ thing })),
          );
          expect(undos.map((execution) => execution.step.idempotencyKey)).toEqual(
            [5, 4, 3, 2, 1, 0].map((index) => `${runId}:e:Undo:${index}`),
          );
        }),
      ),
    );

    it.effect("gives each item of a for-each its own thing, at most four side by side", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const runId = yield* start(kit, undoing, { things });
          const events = yield* finished(runId);
          const ofE = briefly(events).filter((line) => line.includes(" e#"));
          expect(ofE.slice(0, 4)).toEqual([0, 1, 2, 3].map((index) => `StepStarted e#${index}@1`));
          expect(ofE.slice(4, 8).toSorted()).toEqual(
            [0, 1, 2, 3].map((index) => `StepSucceeded e#${index}@1`),
          );
          expect(ofE.slice(8, 10)).toEqual(["StepStarted e#4@1", "StepStarted e#5@1"]);
          const forward = kit.executions.filter((execution) => execution.step.step === "e");
          expect(
            forward
              .toSorted(
                (one, other) =>
                  Option.getOrThrow(one.step.item) - Option.getOrThrow(other.step.item),
              )
              .map((execution) => execution.inputs.required),
          ).toEqual(things.map((thing) => ({ thing })));
          expect(events.at(-1)?._tag).toBe("RunSucceeded");
        }),
      ),
    );

    it.effect("passes a for-each over an empty list", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const runId = yield* start(kit, undoing, { things: [] });
          const events = yield* finished(runId);
          expect(briefly(events).filter((line) => line.startsWith("StepStarted"))).toEqual([
            "StepStarted a@1",
            "StepStarted c@1",
            "StepStarted b@1",
            "StepStarted f@1",
          ]);
        }),
      ),
    );
  });

  describe("retries", () => {
    it.effect("wait five and then thirty seconds, and stop at the third attempt", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const log = yield* RunLog;
          kit.behaviour = failing(["a"], true);
          const runId = yield* start(kit, line);
          const has = (line: string) =>
            Effect.map(log.read(runId), ({ events }) => briefly(events).includes(line));
          yield* logWhen(runId, (_, events) =>
            briefly(events).includes("StepFailed a@1 Broke retryable"),
          );
          yield* settle;
          expect(yield* has("StepStarted a@2")).toBe(false);
          yield* TestClock.adjust("4 seconds");
          yield* settle;
          expect(yield* has("StepStarted a@2")).toBe(false);
          yield* TestClock.adjust("1 second");
          yield* logWhen(runId, (_, events) =>
            briefly(events).includes("StepFailed a@2 Broke retryable"),
          );
          yield* TestClock.adjust("29 seconds");
          yield* settle;
          expect(yield* has("StepStarted a@3")).toBe(false);
          yield* TestClock.adjust("1 second");
          const events = yield* finished(runId);
          // The block said the third failure could be retried too. It is the last attempt
          // allowed, so the log says it is final.
          expect(briefly(events).slice(1, 8)).toEqual([
            "StepStarted a@1",
            "StepFailed a@1 Broke retryable",
            "StepStarted a@2",
            "StepFailed a@2 Broke retryable",
            "StepStarted a@3",
            "StepFailed a@3 Broke",
            "MainPhaseEnded Failed Run",
          ]);
          const attempts = kit.executions.filter((execution) => execution.step.step === "a");
          expect(attempts.map((execution) => execution.step.attempt)).toEqual([1, 2, 3]);
          expect(new Set(attempts.map((execution) => execution.step.idempotencyKey))).toEqual(
            new Set([`${runId}:a:Forward`]),
          );
        }),
      ),
    );

    it.effect(
      "apply to an undo and to a finally step too, and a retry that succeeds is no failure",
      () =>
        withEngine((kit) =>
          Effect.gen(function* () {
            kit.behaviour = ({ block: blockId, step: at }) =>
              (at.step === "b" || at.phase === "Undo" || at.step === "f") && at.attempt === 1
                ? failWith("Flaky", at.step !== "b")
                : Effect.succeed(fitting(blockId));
            const runId = yield* start(kit, line);
            expect(briefly(yield* finished(runId)).slice(5)).toEqual([
              "MainPhaseEnded Failed Run",
              "UndoStarted a@1",
              "UndoFailed a@1 Flaky retryable",
              "UndoStarted a@2",
              "UndoSucceeded a@2",
              "StepStarted f@1",
              "StepFailed f@1 Flaky retryable",
              "StepStarted f@2",
              "StepSucceeded f@2",
              "StepStarted g@1",
              "StepSucceeded g@1",
              "RunFailed",
            ]);
          }),
        ),
    );
  });

  describe("what a block returns", () => {
    /** `m` makes a database, and `d` drops it whatever happened. */
    const making: Recipe = recipe({
      id: "making",
      start: "m",
      nodes: [
        step("m", "t.make"),
        step("d", "t.drop", { database: maybeFromStep("m", "database") }),
        step("r", "t.report", { made: maybeFromStep("m", "database") }),
      ],
      finally: ["d", "r"],
    });

    it.effect("reaches later steps, and an optional input with no value is None", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const runId = yield* start(kit, making);
          const events = yield* finished(runId);
          expect(events.find((event) => event._tag === "StepSucceeded")).toMatchObject({
            step: "m",
            outputs: { database: db("id-1") },
          });
          const drop = kit.executions.find((execution) => execution.step.step === "d");
          expect(drop?.inputs).toEqual({
            required: {},
            optional: { database: Option.some(db("id-1")) },
          });
          const report = kit.executions.find((execution) => execution.step.step === "r");
          expect(report?.inputs.optional).toEqual({
            copies: Option.none(),
            made: Option.some(db("id-1")),
          });
        }),
      ),
    );

    it.effect.each<readonly [string, BlockOutputs]>([
      ["a value of the wrong type", { database: "not a resource" }],
      ["a missing output", {}],
      ["an output it does not declare", { database: db("d"), extra: 1 }],
    ])("fails the step, not to be retried, when it is %s", ([, outputs]) =>
      withEngine((kit) =>
        Effect.gen(function* () {
          kit.behaviour = ({ block: blockId }) =>
            Effect.succeed(blockId === "t.make" ? outputs : fitting(blockId));
          const runId = yield* start(kit, making);
          const events = yield* finished(runId);
          expect(briefly(events).slice(1, 4)).toEqual([
            "StepStarted m@1",
            "StepFailed m@1 OutputTypeMismatch",
            "MainPhaseEnded Failed Run",
          ]);
          // Nothing was made as far as the log knows, so the cleanup is given nothing.
          const drop = kit.executions.find((execution) => execution.step.step === "d");
          expect(drop?.inputs.optional).toEqual({ database: Option.none() });
          expect(JSON.stringify(events)).not.toContain("not a resource");
        }),
      ),
    );

    it.effect(
      "is recorded as a failure when the block reports one with a name the log cannot hold",
      () =>
        withEngine((kit) =>
          Effect.gen(function* () {
            kit.behaviour = () => failWith("not a name", true);
            const runId = yield* start(kit, making);
            const events = yield* logWhen(runId, (_, all) =>
              all.some((event) => event._tag === "StepFailed"),
            );
            expect(events.find((event) => event._tag === "StepFailed")).toMatchObject({
              error: { name: "BlockFailed", message: "not a name happened." },
              retryable: true,
            });
            yield* finished(runId);
          }),
        ),
    );

    it.effect("is recorded as a failure when the block dies", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          kit.behaviour = ({ block: blockId }) =>
            blockId === "t.make" ? Effect.die(new Error("boom")) : Effect.succeed(fitting(blockId));
          const runId = yield* start(kit, making);
          const events = yield* finished(runId);
          expect(events.find((event) => event._tag === "StepFailed")).toMatchObject({
            error: { name: "BlockDefect", message: "Error: boom" },
            retryable: false,
          });
        }),
      ),
    );
  });

  describe("the services a block gets", () => {
    const one = (id: string, blockId: string): Recipe =>
      recipe({ id, start: "s", nodes: [step("s", blockId)] });

    it("are exactly the ones it declares: using another does not compile", () => {
      const spec = block("t.honest");
      const honest = implement({
        spec,
        uses: [Stage],
        run: (inputs) => Effect.flatMap(Stage, (stage) => stage.perform(spec.id, inputs)),
      });
      expect(honest.uses).toEqual([Stage.key]);
      const undeclared = implement({
        spec,
        uses: [],
        // The planted violation: `Stage` is not in `uses`, so `run` may not require it. TypeScript
        // and the Effect diagnostics both refuse it, and one comment line answers both.
        // @ts-expect-error @effect-diagnostics-next-line missingEffectContext:off
        run: (inputs) => Effect.flatMap(Stage, (stage) => stage.perform(spec.id, inputs)),
      });
      expect(undeclared.uses).toEqual([]);
    });

    it.effect("do not include one it did not declare, nor anything of the engine's own", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const runId = yield* start(kit, one("sneaky", "t.sneaky"));
          const events = yield* finished(runId);
          expect(briefly(events)).toEqual([
            "RunStarted",
            "StepStarted s@1",
            "StepFailed s@1 BlockDefect",
            "MainPhaseEnded Failed Run",
            "RunFailed",
          ]);
          // It looked for the offered service and for the engine's own, and found none of them.
          expect(events.find((event) => event._tag === "StepFailed")).toMatchObject({
            error: { name: "BlockDefect", message: "Error: found []" },
          });
          expect(kit.touched).toBe(0);
        }),
      ),
    );

    it.effect("fail the step when the engine does not offer one the block declares", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const runId = yield* start(kit, one("needy", "t.needy"));
          expect(briefly(yield* finished(runId)).slice(1, 3)).toEqual([
            "StepStarted s@1",
            "StepFailed s@1 ServiceNotOffered",
          ]);
        }),
      ),
    );
  });

  describe("a step that runs twice after a crash", () => {
    it.effect(
      "is one attempt in the log, run again under the same key, with a span each time",
      () =>
        withEngine((kit) =>
          Effect.gen(function* () {
            let crashes = 1;
            // The first execution of `b` is cut off, as by a Worker that dies mid-step.
            kit.behaviour = ({ step: at }) => {
              if (at.step === "b" && crashes > 0) {
                crashes -= 1;
                return Effect.interrupt;
              }
              return Effect.succeed({});
            };
            const runId = yield* start(kit, line);
            const events = yield* finished(runId);
            expect(briefly(events).filter((line) => line.includes(" b@"))).toEqual([
              "StepStarted b@1",
              "StepSucceeded b@1",
            ]);
            const runs = kit.executions.filter((execution) => execution.step.step === "b");
            expect(
              runs.map((execution) => [execution.step.attempt, execution.step.idempotencyKey]),
            ).toEqual([
              [1, `${runId}:b:Forward`],
              [1, `${runId}:b:Forward`],
            ]);
            const spans = kit.spans.filter(
              (span) => span.attributes.get("aemeth.idempotencyKey") === `${runId}:b:Forward`,
            );
            expect(spans).toHaveLength(2);
          }),
        ),
    );

    it.effect("appends each event once when an append is run again", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const repeated: Array<string> = [];
          // Every append is stored, and then cut off before the workflow hears of it, once.
          kit.onAppend = (_fact, key, append) =>
            repeated.includes(key)
              ? append
              : Effect.flatMap(append, () => {
                  repeated.push(key);
                  return Effect.interrupt;
                });
          const runId = yield* Effect.flatMap(Engine, (engine) => {
            kit.recipes.set("line", line);
            // `RunStarted` is appended by `start`, not by the workflow: leave it alone.
            repeated.push("started");
            return engine.start("line", {});
          });
          const events = yield* finished(runId);
          expect(briefly(events)).toEqual([
            "RunStarted",
            "StepStarted a@1",
            "StepSucceeded a@1",
            "StepStarted b@1",
            "StepSucceeded b@1",
            "MainPhaseEnded Succeeded",
            "StepStarted f@1",
            "StepSucceeded f@1",
            "StepStarted g@1",
            "StepSucceeded g@1",
            "RunSucceeded",
          ]);
          expect(repeated).toHaveLength(events.length);
          expect(kit.executions).toHaveLength(4);
        }),
      ),
    );
  });

  describe("tracing", () => {
    it.effect("gives every execution of a block a span that names the work", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          kit.behaviour = failing(["b"]);
          const runId = yield* start(kit, undoing, { things: [db("t0"), db("t1")] });
          yield* finished(runId);
          const spans = kit.spans.filter((span) => span.name.startsWith("block "));
          expect(spans).toHaveLength(kit.executions.length);
          const attributes = (key: string) =>
            Object.fromEntries(
              spans.find((span) => span.attributes.get("aemeth.idempotencyKey") === key)
                ?.attributes ?? [],
            );
          expect(attributes(`${runId}:a:Forward`)).toEqual({
            "aemeth.run": runId,
            "aemeth.step": "a",
            "aemeth.phase": "Forward",
            "aemeth.attempt": 1,
            "aemeth.idempotencyKey": `${runId}:a:Forward`,
            "aemeth.block": "t.undoable@1",
          });
          expect(attributes(`${runId}:e:Undo:1`)).toEqual({
            "aemeth.run": runId,
            "aemeth.step": "e",
            "aemeth.item": 1,
            "aemeth.phase": "Undo",
            "aemeth.attempt": 1,
            "aemeth.idempotencyKey": `${runId}:e:Undo:1`,
            "aemeth.block": "t.uneach@1",
          });
          expect(spans.find((span) => span.attributes.get("aemeth.step") === "e")?.name).toBe(
            "block t.each",
          );
          // A span is closed inside the activity that opened it.
          expect(spans.map((span) => span.status._tag)).toEqual(spans.map(() => "Ended"));
        }),
      ),
    );
  });

  describe("an append the log refuses", () => {
    it.effect(
      "is followed, not failed on: a cancel that lands between the read and the append",
      () =>
        withEngine((kit) =>
          Effect.gen(function* () {
            const engine = yield* Engine;
            let cancelled = false;
            kit.onAppend = (fact, _key, append) => {
              if (fact._tag === "StepStarted" && fact.step === "b" && !cancelled) {
                cancelled = true;
                // The workflow has read the log and decided to start `b`. The cancel gets in first.
                return Effect.flatMap(Effect.orDie(engine.cancel(runId, by)), () => append);
              }
              return append;
            };
            const runId: RunId = yield* start(kit, line);
            expect(briefly(yield* finished(runId))).toEqual([
              "RunStarted",
              "StepStarted a@1",
              "StepSucceeded a@1",
              "CancellationRequested",
              "MainPhaseEnded Cancelled",
              "UndoStarted a@1",
              "UndoSucceeded a@1",
              "StepStarted f@1",
              "StepSucceeded f@1",
              "StepStarted g@1",
              "StepSucceeded g@1",
              "RunCancelled",
            ]);
            expect(kit.executions.map((execution) => execution.step.step)).not.toContain("b");
            expect(yield* workflowOutcome(runId)).toBe("Complete");
          }),
        ),
    );

    it.effect(
      "twice in a row is the engine's own fault: the workflow stops and the run is left",
      () =>
        withEngine((kit) =>
          Effect.gen(function* () {
            const rejected: EventRejected = {
              _tag: "EventRejected",
              reason: "AttemptsOpen",
              state: "Running",
              event: "StepStarted",
              seq: 3,
            };
            kit.onAppend = (fact, _key, append) =>
              fact._tag === "StepStarted" && fact.step === "b" ? Effect.fail(rejected) : append;
            const runId = yield* start(kit, line);
            yield* logWhen(runId, (_, events) => briefly(events).includes("StepSucceeded a@1"));
            yield* settle;
            expect(yield* workflowOutcome(runId)).toBe("Stuck: RejectedTwice");
            const log = yield* RunLog;
            expect(briefly((yield* log.read(runId)).events)).toEqual([
              "RunStarted",
              "StepStarted a@1",
              "StepSucceeded a@1",
            ]);
          }),
        ),
    );
  });

  describe("the recipe a run follows", () => {
    it.effect("is the document it started with, whatever the bundle holds later", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const runId = yield* start(kit, gated);
          yield* waiting(runId);
          // A deploy replaces the recipe under the waiting run: `ok` now leads straight to `h`.
          kit.recipes.set(
            "gated",
            recipe({
              id: "gated",
              start: "a",
              nodes: [step("a", "t.undoable"), step("ok", "t.gate"), step("h", "t.act")],
              edges: [edge("a", "Succeeded", "ok"), edge("ok", "Approved", "h")],
            }),
          );
          yield* engine.approve(runId, stepId("ok"), by, {});
          expect(briefly(yield* finished(runId)).slice(5)).toEqual([
            "StepStarted b@1",
            "StepSucceeded b@1",
            "MainPhaseEnded Succeeded",
            "StepStarted f@1",
            "StepSucceeded f@1",
            "RunSucceeded",
          ]);
          // A run started now follows the new document.
          const next = yield* engine.start("gated", {});
          yield* waiting(next);
          yield* engine.approve(next, stepId("ok"), by, {});
          expect(briefly(yield* finished(next))).toContain("StepStarted h@1");
        }),
      ),
    );

    it.effect(
      "must exist, validate against the engine's blocks, and be given inputs that fit",
      () =>
        withEngine((kit) =>
          Effect.gen(function* () {
            const engine = yield* Engine;
            kit.recipes.set("undoing", undoing);
            kit.recipes.set(
              "unknown-block",
              recipe({ start: "s", nodes: [step("s", "t.nowhere")] }),
            );
            kit.recipes.set("not-a-recipe", { format: 9 });
            const refusal = (id: string, inputs: Parameters<typeof engine.start>[1]) =>
              Effect.map(Effect.flip(engine.start(id, inputs)), ({ _tag, reason }) => [
                _tag,
                reason,
              ]);
            expect(yield* refusal("nowhere", {})).toEqual(["RunRefused", "RecipeNotFound"]);
            expect(yield* refusal("unknown-block", {})).toEqual(["RunRefused", "RecipeInvalid"]);
            expect(yield* refusal("not-a-recipe", {})).toEqual(["RunRefused", "RecipeInvalid"]);
            expect(yield* refusal("undoing", {})).toEqual(["RunRefused", "InputsInvalid"]);
            expect(yield* refusal("undoing", { things: [db("a")], extra: 1 })).toEqual([
              "RunRefused",
              "InputsInvalid",
            ]);
            expect(yield* refusal("undoing", { things: "all" })).toEqual([
              "RunRefused",
              "InputsInvalid",
            ]);
            const detail = yield* Effect.map(
              Effect.flip(engine.start("undoing", {})),
              (refused) => refused.detail,
            );
            expect(JSON.parse(detail)).toEqual([{ _tag: "InputMissing", name: "things" }]);
            expect(kit.executions).toEqual([]);
          }),
        ),
    );

    it.effect("records the inputs the run was started with", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const runId = yield* start(kit, undoing, { things: [db("a")] });
          const events = yield* finished(runId);
          expect(events[0]).toMatchObject({ _tag: "RunStarted", inputs: { things: [db("a")] } });
        }),
      ),
    );
  });

  describe("a secret", () => {
    /** `x` exports and keeps the link as a secret → gate → `i` imports through the link. */
    const drill: Recipe = recipe({
      id: "drill",
      start: "x",
      inputs: { production: { type: database } },
      nodes: [
        step("x", "t.export", { database: fromRecipe("production") }),
        step("ok", "t.gate"),
        step("i", "t.import", { export: fromStep("x", "export") }),
      ],
      edges: [edge("x", "Succeeded", "ok"), edge("ok", "Approved", "i")],
    });

    it.effect("reaches the block it is for, is in no event, and is gone when the run ends", () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const engine = yield* Engine;
          const log = yield* RunLog;
          const runId = yield* start(kit, drill, { production: db("prod") });
          yield* waiting(runId);
          expect(yield* log.secret(runId, "export")).toEqual(Option.some(secretLink));
          yield* engine.approve(runId, stepId("ok"), by, {});
          const events = yield* finished(runId);
          expect(events.at(-1)?._tag).toBe("RunSucceeded");
          // The import was handed the link by the engine's secret store.
          expect(kit.executions.map((execution) => execution.block)).toEqual([
            "t.export",
            `t.import ${secretLink}`,
          ]);
          // The log holds the handle that names the secret, and never the secret.
          expect(events.find((event) => event._tag === "StepSucceeded")).toMatchObject({
            outputs: { export: { kind: "test.export", id: "export" } },
          });
          expect(JSON.stringify(events)).not.toContain("do-not-log-me");
          expect(JSON.stringify(yield* engine.read(runId))).not.toContain("do-not-log-me");
          expect(yield* log.secret(runId, "export")).toEqual(Option.none());
        }),
      ),
    );
  });
});
