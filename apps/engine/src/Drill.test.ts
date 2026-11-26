import type { FakeD1 } from "@aemeth/blocks/testing";
import type { RunEvent, RunId } from "@aemeth/core";
import { recipeFiles } from "@aemeth/recipes";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import sampleSql from "../sample/0001_sample.sql?raw";
import { Engine } from "./Engine";
import { RunLog } from "./RunLog";
import type { Kit } from "./testing/kit";
import { finished, indexed, withEngine } from "./testing/kit";

// The restore drill on the in-memory engine, with its real blocks against the fake D1 API
// (M2 Part D, D2 and D3 before the deploy): what the run does to the databases, and what it
// keeps of the export's link.

const drill = recipeFiles.find((each) => each.id === "restore-drill");

const productionRows = [
  "CREATE TABLE runs (id TEXT PRIMARY KEY, state TEXT NOT NULL, result TEXT)",
  `INSERT INTO runs VALUES ('a', 'Succeeded', '{"rowsCompared":3}'), ('b', 'Failed', NULL)`,
  "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)",
  "INSERT INTO d1_migrations VALUES (1, '0001_runs.sql')",
];

const fakeOf = (kit: Kit): FakeD1 => {
  expect(kit.d1).toBeDefined();
  return kit.d1!;
};

/** The seed of the sample database a stage that is thrown away has, statement by statement. */
const sampleSeed = sampleSql
  .split("\n")
  .filter((line) => !line.startsWith("--"))
  .join("\n")
  .split(/;\n/u)
  .map((statement) => statement.trim())
  .filter((statement) => statement !== "");

/** Starts the drill on a seeded production database. */
const startDrill = (kit: Kit, rows: ReadonlyArray<string> = productionRows) =>
  Effect.gen(function* () {
    const d1 = fakeOf(kit);
    const production = yield* d1.seed("aemeth-index", rows);
    kit.recipes.set("restore-drill", drill);
    const runId = yield* Effect.flatMap(Engine, (engine) =>
      engine.start("restore-drill", {
        production: { kind: "cloudflare.d1.database", id: production.id },
      }),
    );
    return { d1, production, runId };
  });

const outcomes = new Set([
  "StepSucceeded",
  "StepFailed",
  "RunSucceeded",
  "RunFailed",
  "RunFlaggedForAttention",
]);

/** How each step and the run ended, in order. */
const outcome = (events: ReadonlyArray<RunEvent>) =>
  events.flatMap((event) =>
    outcomes.has(event._tag) ? ["step" in event ? `${event._tag} ${event.step}` : event._tag] : [],
  );

/** Nothing the run kept, logged or archived holds the export's link. */
const linkIsNowhere = (kit: Kit, runId: RunId, events: ReadonlyArray<RunEvent>) =>
  Effect.gen(function* () {
    expect(JSON.stringify(events)).not.toContain("d1-exports.invalid");
    expect([...kit.archive.values()].join("")).not.toContain("d1-exports.invalid");
    expect(JSON.stringify(kit.index.get(runId))).not.toContain("d1-exports.invalid");
    // The run's secrets are gone once it has ended.
    const log = yield* RunLog;
    expect(Option.isNone(yield* log.secret(runId, "export:export"))).toBe(true);
  });

describe("the restore drill", () => {
  it("is one of the recipe files", () => {
    expect(drill).toBeDefined();
  });

  it.effect("restores the sample database a stage that is thrown away is seeded with", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        const { d1, production, runId } = yield* startDrill(kit, sampleSeed);
        const events = yield* finished(runId);
        expect(outcome(events).at(-1)).toBe("RunSucceeded");
        const counted = events.flatMap((event) =>
          event._tag === "StepSucceeded" && event.step === "verify"
            ? [Object.entries(event.outputs).find(([name]) => name === "rowsCompared")?.[1]]
            : [],
        );
        // 400 customers, 800 orders (two pages of the figures) and 5 settings.
        expect(counted).toEqual([1205]);
        expect(d1.databases()).toEqual([production]);
      }),
    ),
  );

  it.effect(
    "restores production into a database of its own, checks it, removes it and records it",
    () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const { d1, production, runId } = yield* startDrill(kit);
          const events = yield* finished(runId);
          expect(outcome(events)).toEqual([
            "StepSucceeded export",
            "StepSucceeded createTemp",
            "StepSucceeded restore",
            "StepSucceeded verify",
            "StepSucceeded destroyTemp",
            "StepSucceeded record",
            "RunSucceeded",
          ]);
          expect(d1.databases()).toEqual([production]);
          expect(d1.effects).toEqual({ created: 1, deleted: 1, imported: 1, exported: 1 });
          const row = yield* indexed(kit, runId);
          expect(row.state).toBe("Succeeded");
          expect(row.result).toMatchObject({ rowsCompared: 3 });
          yield* linkIsNowhere(kit, runId, events);
        }),
      ),
  );

  for (const step of ["export", "createTemp", "restore", "verify", "destroyTemp", "record"]) {
    it.effect(`failing for good at ${step} leaves no temporary database, or says so`, () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          kit.drillFault = step;
          const { d1, production, runId } = yield* startDrill(kit);
          const events = yield* finished(runId);
          expect(outcome(events)).toContain(`StepFailed ${step}`);
          // A failed `finally` step needs a person: a record not written, or a cleanup not done.
          expect(outcome(events).at(-1)).toBe(
            step === "destroyTemp" || step === "record" ? "RunFlaggedForAttention" : "RunFailed",
          );
          if (step === "destroyTemp") {
            // The cleanup itself failed: the run cannot say it cleaned up, and does not.
            expect(d1.databases()).toHaveLength(2);
          } else {
            expect(d1.databases()).toEqual([production]);
          }
          yield* linkIsNowhere(kit, runId, events);
        }),
      ),
    );
  }

  it.effect("removes a database whose create answered as lost on every try", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        const d1 = fakeOf(kit);
        // Three tries: the first makes the database and loses the answer, the other two are refused.
        d1.loseNextCreateAnswer();
        d1.failNext("create", "Unavailable", 2);
        const { production, runId } = yield* startDrill(kit);
        const events = yield* finished(runId);
        expect(outcome(events)).toContain("StepFailed createTemp");
        expect(d1.databases()).toEqual([production]);
        expect(d1.effects.deleted).toBe(1);
      }),
    ),
  );

  it.effect("tries the export again when production changed while it was exported", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        const d1 = fakeOf(kit);
        const { production, runId } = yield* startDrill(kit);
        d1.beforeNextExport(
          d1.write(production.id, ["INSERT INTO runs VALUES ('c', 'Running', NULL)"]),
        );
        const events = yield* finished(runId);
        const exportFailures = events.filter(
          (event) => event._tag === "StepFailed" && event.step === "export",
        );
        expect(exportFailures).toHaveLength(1);
        expect(JSON.stringify(exportFailures)).toContain("SourceChangedDuringExport");
        expect(outcome(events).at(-1)).toBe("RunSucceeded");
        expect((yield* indexed(kit, runId)).result).toMatchObject({ rowsCompared: 4 });
      }),
    ),
  );
});
