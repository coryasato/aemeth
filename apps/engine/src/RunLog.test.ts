import { RunId } from "@aemeth/core";
import { recipe, step } from "@aemeth/core/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { Fact } from "./index";
import { layerMemory, RunLog } from "./index";
import { layerSqlite } from "./testing/sqlLog";

const runId = Schema.decodeSync(RunId)("run-1");
const other = Schema.decodeSync(RunId)("run-2");
const document = recipe({ id: "drill", version: 3, start: "a", nodes: [step("a", "t.act")] });

const started: Fact = { _tag: "RunStarted", inputs: {} };
const mainEnded: Fact = { _tag: "MainPhaseEnded", main: { result: "Succeeded" } };
const ended: Fact = { _tag: "RunSucceeded" };

const opened = Effect.gen(function* () {
  const log = yield* RunLog;
  yield* log.open(runId, document);
  return log;
});

describe.each([
  ["in memory", layerMemory],
  ["on SQLite, as the log entity keeps it", layerSqlite],
])("the run log, %s", (_name, layer) => {
  it.effect("gives each event its run, its recipe, the next seq and the time", () =>
    Effect.gen(function* () {
      const log = yield* opened;
      yield* TestClock.setTime(1_795_000_000_000);
      const first = yield* log.append(runId, started, "started");
      yield* TestClock.adjust("2 seconds");
      const second = yield* log.append(runId, mainEnded, "main-ended");
      expect(first).toEqual({
        _tag: "RunStarted",
        eventSchemaVersion: 1,
        runId,
        seq: 0,
        at: 1_795_000_000_000,
        recipe: { id: "drill", version: 3 },
        inputs: {},
      });
      expect(second).toMatchObject({ seq: 1, at: 1_795_000_002_000 });
      const record = yield* log.read(runId);
      expect(record.events).toEqual([first, second]);
      expect(record.state).toMatchObject({ _tag: "Finalizing", main: "Succeeded" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("stores nothing for a fact that does not fit, and says why", () =>
    Effect.gen(function* () {
      const log = yield* opened;
      const rejected = yield* Effect.flip(log.append(runId, mainEnded, "main-ended"));
      expect(rejected).toEqual({
        _tag: "EventRejected",
        reason: "RunNotStarted",
        state: "NotStarted",
        event: "MainPhaseEnded",
        seq: 0,
      });
      expect(yield* log.read(runId)).toEqual({ events: [], state: { _tag: "NotStarted" } });
      // The key of a rejected fact is still free.
      yield* log.append(runId, started, "started");
      expect(yield* log.append(runId, mainEnded, "main-ended")).toMatchObject({ seq: 1 });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("appends once for a key, and answers the repeat with the stored event", () =>
    Effect.gen(function* () {
      const log = yield* opened;
      const first = yield* log.append(runId, started, "started");
      yield* TestClock.adjust("5 seconds");
      // The same key again, as an activity run twice sends it. Even a different fact changes nothing.
      expect(yield* log.append(runId, started, "started")).toEqual(first);
      expect(yield* log.append(runId, mainEnded, "started")).toEqual(first);
      expect((yield* log.read(runId)).events).toEqual([first]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps each run's log apart, and the recipe a run was opened with", () =>
    Effect.gen(function* () {
      const log = yield* opened;
      yield* log.open(other, recipe({ id: "other", start: "a", nodes: [step("a", "t.act")] }));
      yield* log.append(runId, started, "started");
      expect((yield* log.read(other)).events).toEqual([]);
      expect((yield* log.append(other, started, "started")).recipe).toEqual({
        id: "other",
        version: 1,
      });
      // Opening a run again changes nothing: not its recipe, and not its events.
      yield* log.open(runId, recipe({ id: "changed", start: "a", nodes: [step("a", "t.act")] }));
      expect(yield* log.recipe(runId)).toEqual(document);
      expect((yield* log.read(runId)).events).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("knows nothing of a run that was never opened", () =>
    Effect.gen(function* () {
      const log = yield* RunLog;
      const missing = { _tag: "RunNotFound", runId };
      expect(yield* Effect.flip(log.read(runId))).toMatchObject(missing);
      expect(yield* Effect.flip(log.recipe(runId))).toMatchObject(missing);
      expect(yield* Effect.flip(log.append(runId, started, "started"))).toMatchObject(missing);
      expect(yield* Effect.flip(log.putSecret(runId, "export", "link"))).toMatchObject(missing);
      expect(yield* Effect.flip(log.secret(runId, "export"))).toMatchObject(missing);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a run's secrets outside its events, until the run ends", () =>
    Effect.gen(function* () {
      const log = yield* opened;
      yield* log.open(other, document);
      yield* log.append(runId, started, "started");
      yield* log.putSecret(runId, "export", "link-1");
      yield* log.putSecret(runId, "export", "link-2");
      yield* log.putSecret(runId, "token", "t");
      expect(yield* log.secret(runId, "export")).toEqual(Option.some("link-2"));
      expect(yield* log.secret(runId, "token")).toEqual(Option.some("t"));
      expect(yield* log.secret(runId, "nothing")).toEqual(Option.none());
      expect(yield* log.secret(other, "export")).toEqual(Option.none());
      yield* log.append(runId, mainEnded, "main-ended");
      expect(yield* log.secret(runId, "export")).toEqual(Option.some("link-2"));
      expect(JSON.stringify(yield* log.read(runId))).not.toContain("link-");
      yield* log.append(runId, ended, "ended");
      expect(yield* log.secret(runId, "export")).toEqual(Option.none());
      expect(yield* log.secret(runId, "token")).toEqual(Option.none());
    }).pipe(Effect.provide(layer)),
  );
});
