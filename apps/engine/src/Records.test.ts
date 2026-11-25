import type { Recipe } from "@aemeth/core";
import { chain, edge, failed, recipe, step } from "@aemeth/core/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import { Archive, archiveKey, archiveText, replayArchive } from "./Archive";
import { Engine } from "./Engine";
import { recordDelays } from "./RunWorkflow";
import type { Execution, Kit } from "./testing/kit";
import {
  failWith,
  finished,
  fitting,
  indexed,
  settle,
  waiting,
  withEngine,
  workflowOutcome,
} from "./testing/kit";

const by = "ada@example.com";

/** `a` (has an undo) → gate `ok` → `b`, then `f` whatever happened. */
const gated: Recipe = recipe({
  id: "gated",
  start: "a",
  nodes: [step("a", "t.undoable"), step("ok", "t.gate"), step("b", "t.act"), step("f", "t.act")],
  edges: [
    edge("a", "Succeeded", "ok"),
    edge("ok", "Approved", "b"),
    edge("ok", "Denied", failed("Run")),
  ],
  finally: ["f"],
});

/** `a` → `b`, with no gate. */
const line: Recipe = recipe({
  id: "line",
  start: "a",
  nodes: [step("a", "t.undoable"), step("b", "t.act")],
  edges: chain("a", "b"),
});

const failing =
  (steps: ReadonlyArray<string>) =>
  ({ block, step: at }: Execution) =>
    steps.includes(`${at.phase === "Undo" ? "undo " : ""}${at.step}`)
      ? failWith("Broke")
      : Effect.succeed(fitting(block));

const start = (kit: Kit, document: Recipe) =>
  Effect.flatMap(Engine, (engine) => {
    kit.recipes.set(document.id, document);
    return engine.start(document.id, {});
  });

/** Moves the clock on by more than a sixth of all the waits between tries of a write. */
const indexedSoon = TestClock.adjust("10 minutes");

describe("the index and the archive", () => {
  it.effect("the index has a run from its start, and its end and archive once it is over", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const runId = yield* start(kit, gated);
        const before = yield* waiting(runId);
        expect(kit.index.get(runId)).toEqual({
          id: runId,
          recipe: { id: "gated", version: 1 },
          state: "Running",
          startedAt: before[0]?.at,
          endedAt: null,
          archiveKey: null,
          result: null,
        });
        expect(kit.archive.size).toBe(0);

        yield* engine.approve(runId, gated.nodes[1]!.id, by, {});
        const events = yield* finished(runId);
        const row = yield* indexed(kit, runId);
        expect(row).toMatchObject({
          state: "Succeeded",
          endedAt: events.at(-1)?.at,
          archiveKey: `runs/${runId}.json`,
        });
        // One object, the whole log, which replays to the state the index records.
        expect([...kit.archive.keys()]).toEqual([`runs/${runId}.json`]);
        const text = kit.archive.get(archiveKey(runId)) ?? "";
        expect(JSON.parse(text)).toEqual(events);
        expect(Result.getOrThrow(replayArchive(text))._tag).toBe(row.state);
        expect(yield* workflowOutcome(runId)).toBe("Complete");
      }),
    ),
  );

  it.effect("records each of the four ways a run ends", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const ok = gated.nodes[1]!.id;

        const succeeded = yield* start(kit, line);
        yield* finished(succeeded);

        kit.behaviour = failing(["b"]);
        const failedRun = yield* start(kit, line);
        yield* finished(failedRun);

        kit.behaviour = failing(["b", "undo a"]);
        const flagged = yield* start(kit, line);
        yield* finished(flagged);

        kit.behaviour = failing([]);
        const cancelled = yield* start(kit, gated);
        yield* waiting(cancelled);
        yield* engine.cancel(cancelled, by);
        yield* finished(cancelled);

        const denied = yield* start(kit, gated);
        yield* waiting(denied);
        yield* engine.deny(denied, ok, by);
        yield* finished(denied);

        const states = [];
        for (const runId of [succeeded, failedRun, flagged, cancelled, denied]) {
          const row = yield* indexed(kit, runId);
          const replayed = replayArchive(kit.archive.get(archiveKey(runId)) ?? "");
          states.push([row.state, Result.getOrThrow(replayed)._tag]);
        }
        expect(states).toEqual([
          ["Succeeded", "Succeeded"],
          ["Failed", "Failed"],
          ["NeedsAttention", "NeedsAttention"],
          ["Cancelled", "Cancelled"],
          ["Failed", "Failed"],
        ]);
      }),
    ),
  );

  it.effect("writes the archive once: a second write changes nothing", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        const archive = yield* Archive;
        const runId = yield* start(kit, line);
        const events = yield* finished(runId);
        yield* indexed(kit, runId);
        const key = archiveKey(runId);
        expect(yield* archive.putOnce(key, "something else")).toBe(false);
        expect(yield* archive.get(key)).toBe(archiveText(events));
      }),
    ),
  );

  it.effect("archives once when the write is stored and the workflow is cut off", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        kit.archiveCuts = 1;
        const runId = yield* start(kit, line);
        const events = yield* finished(runId);
        const row = yield* indexed(kit, runId);
        // The activity ran twice: the second write found the object and went on to the index.
        expect(kit.archiveWrites).toBe(2);
        expect(kit.archive.get(archiveKey(runId))).toBe(archiveText(events));
        expect(row.state).toBe("Succeeded");
        expect(yield* workflowOutcome(runId)).toBe("Complete");
      }),
    ),
  );

  it.effect("tries again when the archive or the index is away for a moment", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        const runId = yield* start(kit, gated);
        yield* waiting(runId);
        // The next three writes fail: the archive, three times running. The run waits 5 seconds,
        // 30 and then two minutes, on its durable clock, and the fourth try works.
        kit.recordFaults = 3;
        yield* Effect.flatMap(Engine, (engine) => engine.cancel(runId, by));
        yield* finished(runId);
        yield* TestClock.adjust("30 seconds");
        yield* settle;
        expect(kit.archive.size).toBe(0);
        const row = yield* indexed(kit, runId);
        expect(row.state).toBe("Cancelled");
        expect(kit.recordFaults).toBe(0);
        expect(kit.archiveWrites).toBe(4);
        expect(yield* workflowOutcome(runId)).toBe("Complete");
      }),
    ),
  );

  it.effect("leaves a finished run as it is when the archive stays away, and says so", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        kit.unarchivedOnPurpose = true;
        const engine = yield* Engine;
        const runId = yield* start(kit, gated);
        yield* waiting(runId);
        kit.recordFaults = 100;
        yield* engine.cancel(runId, by);
        const events = yield* finished(runId);
        for (let tries = 0; tries < 20; tries += 1) {
          yield* settle;
          yield* indexedSoon;
        }
        expect(yield* workflowOutcome(runId)).toBe("Stuck: RecordFailed");
        // Six tries, with every wait between them, and then no more.
        expect(kit.archiveWrites).toBe(recordDelays.length + 1);
        // The log is whole and final; only the copy outside it is missing.
        expect((yield* engine.read(runId)).events).toEqual(events);
        expect(kit.archive.size).toBe(0);
        expect(kit.index.get(runId)?.state).toBe("Running");
      }),
    ),
  );

  it.effect("starts nothing when the index stays away", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        kit.recordFaults = 100;
        const runId = yield* start(kit, line);
        for (let tries = 0; tries < 20; tries += 1) {
          yield* settle;
          yield* indexedSoon;
        }
        expect(yield* workflowOutcome(runId)).toBe("Stuck: RecordFailed");
        expect(kit.executions).toEqual([]);
        expect(kit.index.size).toBe(0);
      }),
    ),
  );
});
