import type { FakeD1 } from "@aemeth/blocks/testing";
import type { RunEvent, RunId } from "@aemeth/core";
import { recipeFiles } from "@aemeth/recipes";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import type { RunRow } from "./RunIndex";
import indexSql from "../migrations/0001_runs.sql?raw";
import sampleSql from "../sample/0001_sample.sql?raw";
import { Engine } from "./Engine";
import { RunLog } from "./RunLog";
import type { Kit } from "./testing/kit";
import { archiveBucket, finished, indexed, withEngine } from "./testing/kit";

// The restore drill on the in-memory engine, with its real blocks against the fake D1 API
// (M2 Part D, D2 and D3 before the deploy): what the run does to the databases, and what it
// keeps of the export's link.

const drill = recipeFiles.find((each) => each.id === "restore-drill");
const aemethDrill = recipeFiles.find((each) => each.id === "aemeth-restore-drill");

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

/** A file of SQL, statement by statement. */
const statementsOf = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\n/u)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

/** The seed of the sample database a stage that is thrown away has. */
const sampleSeed = statementsOf(sampleSql);

const literal = (value: string | number | null): string =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${value.replaceAll("'", "''")}'`;

/**
 * The kit's index of runs as a D1 database, made by the engine's own migration: what the drill of
 * Aemeth's own index exports. `change` lets a test plant a row that is not what the engine wrote.
 */
const indexDatabase = (kit: Kit, change: (rows: Array<RunRow>) => void = () => {}) =>
  Effect.gen(function* () {
    const rows = [...kit.index.values()];
    change(rows);
    const inserts = rows.map(
      (row) =>
        `INSERT INTO runs VALUES (${[
          row.id,
          row.recipe.id,
          row.recipe.version,
          row.state,
          row.startedAt,
          row.endedAt,
          row.archiveKey,
          row.result === null ? null : JSON.stringify(row.result),
        ]
          .map(literal)
          .join(", ")})`,
    );
    return yield* fakeOf(kit).seed("aemeth-index", [...statementsOf(indexSql), ...inserts]);
  });

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

describe("the restore drill of Aemeth's own index", () => {
  it("is one of the recipe files", () => {
    expect(aemethDrill).toBeDefined();
  });

  /** Two drills of a database that end, one well and one not: the runs the index then holds. */
  const earlierRuns = (kit: Kit) =>
    Effect.gen(function* () {
      const first = yield* startDrill(kit);
      yield* finished(first.runId);
      kit.drillFault = "verify";
      const second = yield* startDrill(kit);
      yield* finished(second.runId);
      kit.drillFault = undefined;
      expect([
        (yield* indexed(kit, first.runId)).state,
        (yield* indexed(kit, second.runId)).state,
      ]).toEqual(["Succeeded", "Failed"]);
      return [first.runId, second.runId];
    });

  const startAemethDrill = (kit: Kit, index: { readonly id: string }) =>
    Effect.gen(function* () {
      kit.recipes.set("aemeth-restore-drill", aemethDrill);
      return yield* Effect.flatMap(Engine, (engine) =>
        engine.start("aemeth-restore-drill", {
          production: { kind: "cloudflare.d1.database", id: index.id },
          archive: { kind: "cloudflare.r2.bucket", id: archiveBucket },
        }),
      );
    });

  it.effect("restores the index, replays the archived runs it records, and records how many", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        yield* earlierRuns(kit);
        const index = yield* indexDatabase(kit);
        const before = fakeOf(kit).databases();
        const runId = yield* startAemethDrill(kit, index);
        const events = yield* finished(runId);
        expect(outcome(events)).toEqual([
          "StepSucceeded export",
          "StepSucceeded createTemp",
          "StepSucceeded restore",
          "StepSucceeded verify",
          "StepSucceeded checkArchive",
          "StepSucceeded destroyTemp",
          "StepSucceeded record",
          "RunSucceeded",
        ]);
        const row = yield* indexed(kit, runId);
        expect(row.result).toMatchObject({ runsChecked: 2 });
        expect(fakeOf(kit).databases()).toEqual(before);
        yield* linkIsNowhere(kit, runId, events);
      }),
    ),
  );

  const planted = [
    [
      "whose archive replays to another state than its row",
      (rows: Array<RunRow>) => {
        rows[1] = { ...rows[1]!, state: "Succeeded" };
      },
    ],
    [
      "whose archive is not there",
      (rows: Array<RunRow>) => {
        rows[0] = { ...rows[0]!, archiveKey: "runs/gone.json" };
      },
    ],
  ] as const;

  for (const [what, change] of planted) {
    it.effect(`fails at the check, and still cleans up, on a run ${what}`, () =>
      withEngine((kit) =>
        Effect.gen(function* () {
          const [first, second] = yield* earlierRuns(kit);
          const index = yield* indexDatabase(kit, change);
          const before = fakeOf(kit).databases();
          const runId = yield* startAemethDrill(kit, index);
          const events = yield* finished(runId);
          expect(outcome(events)).toEqual([
            "StepSucceeded export",
            "StepSucceeded createTemp",
            "StepSucceeded restore",
            "StepSucceeded verify",
            "StepFailed checkArchive",
            "StepSucceeded destroyTemp",
            "StepSucceeded record",
            "RunFailed",
          ]);
          const failure = JSON.stringify(
            events.filter((event) => event._tag === "StepFailed" && event.step === "checkArchive"),
          );
          expect(failure).toContain("ArchiveDisagrees");
          expect(failure).toContain(what.includes("state") ? second : first);
          expect((yield* indexed(kit, runId)).result).toMatchObject({ runsChecked: null });
          expect(fakeOf(kit).databases()).toEqual(before);
        }),
      ),
    );
  }
});
