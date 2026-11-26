import { D1Api, drillBlocks, Secrets } from "@aemeth/blocks";
import type { Block, BlockFailed, StepContext } from "@aemeth/blocks";
import { makeFakeD1 } from "@aemeth/blocks/testing";
import { idempotencyKey, RunId, StepId, validateDocument } from "@aemeth/core";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Option, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Archive } from "../Archive";
import type { Fault } from "./fixtures";
import { faultyDrill, fixtureBlocks, fixtureRecipes, gatedRecipe, heldDrill } from "./fixtures";

const runId = Schema.decodeSync(RunId)("run-1");
const work = Schema.decodeSync(StepId)("work");

describe("the fixtures of a stage that is thrown away", () => {
  it.effect("the recipe passes the validator against the fake blocks", () =>
    Effect.gen(function* () {
      const blocks = yield* fixtureBlocks;
      const result = validateDocument(
        gatedRecipe,
        blocks.map((block) => block.spec),
      );
      expect(Result.isFailure(result) ? JSON.stringify(result.failure) : "valid").toBe("valid");
      expect((yield* fixtureRecipes).map((recipe) => recipe.id)).toEqual([
        "test-gated",
        "test-drill",
      ]);
    }),
  );

  it.effect("the drill held at a gate passes the validator against the stage's blocks", () =>
    Effect.gen(function* () {
      const blocks = [...(yield* drillBlocks), ...(yield* fixtureBlocks)];
      const drill = yield* heldDrill;
      const result = validateDocument(
        drill,
        blocks.map((block) => block.spec),
      );
      expect(Result.isFailure(result) ? JSON.stringify(result.failure) : "valid").toBe("valid");
      expect([drill.id, drill.start, drill.nodes.length]).toEqual(["test-drill", "hold", 7]);
    }),
  );

  it.effect("the work block says how many times the same attempt was run", () =>
    Effect.gen(function* () {
      const blocks = yield* fixtureBlocks;
      const block = blocks.find((each) => each.spec.id === "test.work");
      const kept = new Map<string, string>();
      const services = Context.make(
        Secrets,
        Secrets.of({
          put: (name, value) => Effect.sync(() => void kept.set(name, value)),
          get: (name) => Effect.sync(() => Option.fromUndefinedOr(kept.get(name))),
        }),
      );
      const step = (attempt: number): StepContext => ({
        runId,
        step: work,
        item: Option.none(),
        phase: "Forward",
        attempt,
        idempotencyKey: idempotencyKey(runId, work, "Forward", undefined),
      });
      const run = (attempt: number) =>
        block === undefined
          ? Effect.die(new Error("no test.work"))
          : block.run({ required: {}, optional: { for: Option.some(0) } }, step(attempt), services);
      expect(block?.uses).toEqual([Secrets.key]);
      expect(yield* run(1)).toEqual({ executions: 1 });
      // The Worker died during the first execution: the same attempt runs again.
      expect(yield* run(1)).toEqual({ executions: 2 });
      // A retry is another attempt, and counts for itself.
      expect(yield* run(2)).toEqual({ executions: 1 });
    }),
  );
});

/** The archive in memory, written once per key, as the bucket is. */
const archiveInMemory = () => {
  const objects = new Map<string, string>();
  const archive = Archive.of({
    putOnce: (key, text) =>
      Effect.sync(() => {
        if (objects.has(key)) {
          return false;
        }
        objects.set(key, text);
        return true;
      }),
    get: (key) => Effect.sync(() => objects.get(key)),
  });
  return { objects, archive };
};

const stepNamed = (name: string): StepContext => {
  const id = Schema.decodeSync(StepId)(name);
  return {
    runId,
    step: id,
    item: Option.none(),
    phase: "Forward",
    attempt: 1,
    idempotencyKey: idempotencyKey(runId, id, "Forward", undefined),
  };
};

describe("the drill's fault on a stage that is thrown away", () => {
  /** A block that exports or creates through the D1 API it is given, and counts its runs. */
  const world = Effect.gen(function* () {
    const fake = yield* makeFakeD1;
    const { objects, archive } = archiveInMemory();
    const database = yield* fake.seed("sample", [
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)",
    ]);
    let runs = 0;
    const spec = (yield* fixtureBlocks)[0]!.spec;
    const probe: Block = {
      spec,
      uses: [D1Api.key],
      run: (_inputs, step, services) =>
        Effect.gen(function* () {
          runs += 1;
          const api = Option.getOrUndefined(Context.getOption(services, D1Api));
          if (api === undefined) {
            return yield* Effect.die(new Error("no D1 API"));
          }
          if (step.step === "export") {
            yield* Effect.orDie(api.exportDatabase(database.id));
          }
          if (step.step === "createTemp") {
            yield* api
              .create("restore-drill-x")
              .pipe(Effect.catch((error) => Effect.die(new Error(error.reason))));
          }
          return {};
        }),
    };
    const [faulty] = faultyDrill([probe], archive);
    const run = (step: string) =>
      faulty!.run({ required: {}, optional: {} }, stepNamed(step), Context.make(D1Api, fake.api));
    const setFault = (fault: Fault) =>
      Effect.sync(() => void objects.set(`test/${runId}/fault`, JSON.stringify(fault)));
    return { fake, objects, database, run, setFault, runs: () => runs };
  });

  const reasonOf = (exit: Exit.Exit<unknown, BlockFailed>) =>
    Exit.isFailure(exit)
      ? Option.match(Exit.findErrorOption(exit), {
          onNone: () => "defect",
          onSome: (error) => `${error.reason} ${error.retryable}`,
        })
      : "succeeded";

  it.effect("does nothing to a run with no fault", () =>
    Effect.gen(function* () {
      const { run, objects, runs } = yield* world;
      yield* run("export");
      expect(runs()).toBe(1);
      expect([...objects.keys()]).toEqual([]);
    }),
  );

  it.effect("fails the step it names for good, before the block runs", () =>
    Effect.gen(function* () {
      const { run, setFault, runs } = yield* world;
      yield* setFault({ _tag: "Fail", step: "restore" });
      expect(reasonOf(yield* Effect.exit(run("restore")))).toBe("PlantedFault false");
      expect(runs()).toBe(0);
      yield* run("export");
      expect(runs()).toBe(1);
    }),
  );

  it.effect(
    "holds the step it names once, after its work, until released, and counts each run",
    () =>
      Effect.gen(function* () {
        const { run, setFault, objects, runs } = yield* world;
        yield* setFault({ _tag: "Kill", step: "export" });
        const first = yield* Effect.forkChild(run("export"));
        yield* TestClock.adjust("1 minute");
        // The work is done, and the block is still holding: a deploy kills it here.
        expect(runs()).toBe(1);
        expect(objects.has(`test/${runId}/held/export`)).toBe(true);
        expect(first.pollUnsafe()).toBeUndefined();
        // It holds until the test releases the run, however long the deploy takes.
        yield* TestClock.adjust("10 minutes");
        expect(first.pollUnsafe()).toBeUndefined();
        objects.set(`test/${runId}/released`, "");
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(first);
        // Run again, as after the restart: counted, and not held.
        yield* run("export");
        expect(runs()).toBe(2);
        expect(
          [...objects.keys()].filter((key) => key.startsWith(`test/${runId}/executions/export/`)),
        ).toHaveLength(2);
      }),
  );

  it.effect("writes to the database before the export, once", () =>
    Effect.gen(function* () {
      const { run, setFault, fake, database } = yield* world;
      yield* setFault({ _tag: "WriteBeforeExport" });
      yield* run("export");
      yield* run("export");
      const rows = yield* fake.api.query(database.id, "SELECT key FROM settings");
      expect(rows).toEqual([{ key: `written-during-${runId}` }]);
    }),
  );

  it.effect("makes the temporary database and loses the answer, every time", () =>
    Effect.gen(function* () {
      const { run, setFault, fake } = yield* world;
      yield* setFault({ _tag: "LoseCreate" });
      expect(Exit.isFailure(yield* Effect.exit(run("createTemp")))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(run("createTemp")))).toBe(true);
      expect(fake.databases().map((each) => each.name)).toEqual(["sample", "restore-drill-x"]);
    }),
  );
});
