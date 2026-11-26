import type { RunId } from "@aemeth/core";
import {
  AttemptNumber,
  idempotencyKey,
  ItemIndex,
  RunId as RunIdSchema,
  StepId,
} from "@aemeth/core";
import { describe, expect, it } from "@effect/vitest";
import type { Schema } from "effect";
import { Context, Effect, Exit, Option } from "effect";
import type { Block, BlockInputs, BlockOutputs, StepContext } from "./implement";
import { Secrets } from "./implement";
import { drillBlocks, figuresOf, pageSize, temporaryName } from "./drill";
import { D1Api, RecordUnavailable, RunRecord } from "./services";
import type { FakeD1 } from "./testing/fakeD1";
import { makeFakeD1 } from "./testing/fakeD1";

const runId = RunIdSchema.make("01jb3m5x7z9a2c4e6g8j0k2m4p");
const otherRun: RunId = RunIdSchema.make("01jb3m5x7z9a2c4e6g8j0k2zzz");

const stepOf = (step: string, run: RunId = runId): StepContext => ({
  runId: run,
  step: StepId.make(step),
  item: Option.none(),
  phase: "Forward",
  attempt: AttemptNumber.make(1),
  idempotencyKey: idempotencyKey(run, StepId.make(step), "Forward", undefined),
});

const inputsOf = (
  required: { readonly [name: string]: Schema.Json },
  optional: { readonly [name: string]: Schema.Json | undefined } = {},
): BlockInputs => ({
  required,
  optional: Object.fromEntries(
    Object.entries(optional).map(([name, value]) => [name, Option.fromUndefinedOr(value)]),
  ),
});

/** The world a block runs in here: the fake D1 API, a run's secrets and its record. */
const worldOf = (fake: FakeD1) => {
  const secrets = new Map<string, string>();
  const records: Array<Schema.Json> = [];
  let recordAway = 0;
  const services = Context.make(D1Api, fake.api).pipe(
    Context.add(
      Secrets,
      Secrets.of({
        put: (name, value) => Effect.sync(() => void secrets.set(name, value)),
        get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
      }),
    ),
    Context.add(
      RunRecord,
      RunRecord.of({
        write: (result) =>
          Effect.suspend(() => {
            if (recordAway > 0) {
              recordAway -= 1;
              return Effect.fail(new RecordUnavailable({ message: "The index is away." }));
            }
            records.push(result);
            return Effect.void;
          }),
      }),
    ),
  );
  return {
    secrets,
    records,
    recordAwayFor: (times: number) => {
      recordAway = times;
    },
    services: services as Context.Context<never>,
  };
};

const blockNamed = (blocks: ReadonlyArray<Block>, id: string): Block => {
  const found = blocks.find((block) => block.spec.id === id);
  expect(found, id).toBeDefined();
  return found!;
};

/** A world with a seeded production database and the drill's blocks. */
const drill = Effect.gen(function* () {
  const fake = yield* makeFakeD1;
  const production = yield* fake.seed("aemeth-production-index", [
    "CREATE TABLE runs (id TEXT PRIMARY KEY, state TEXT NOT NULL, result TEXT, size REAL, data BLOB)",
    `INSERT INTO runs VALUES ('a', 'Succeeded', '{"rows":3}', 1.5, X'00ff'), ('b', 'Failed', NULL, NULL, NULL), ('c', 'it''s', 'x', -0.25, X'')`,
    "CREATE TABLE notes (body TEXT)",
    "INSERT INTO notes VALUES ('same'), ('same'), ('other')",
  ]);
  const world = worldOf(fake);
  const blocks = yield* drillBlocks;
  const run = (id: string, inputs: BlockInputs, step: StepContext = stepOf(id.split(".")[1]!)) =>
    Effect.exit(blockNamed(blocks, id).run(inputs, step, world.services));
  return { fake, production, world, blocks, run };
});

/** What a block returned; a test whose block failed fails here. */
const succeeded = (exit: Exit.Exit<BlockOutputs, unknown>): BlockOutputs => {
  expect(Exit.isSuccess(exit), String(exit)).toBe(true);
  return Exit.isSuccess(exit) ? exit.value : {};
};

const asDatabase = (id: string) => ({ kind: "cloudflare.d1.database", id });

const failedAs = (
  exit: Exit.Exit<unknown, { readonly reason: string; readonly retryable: boolean }>,
) =>
  Exit.match(exit, {
    onSuccess: () => "succeeded",
    onFailure: (cause) => {
      const error = cause.reasons.find((reason) => reason._tag === "Fail");
      return error === undefined
        ? "died"
        : `${error.error.reason}${error.error.retryable ? " (retryable)" : ""}`;
    },
  });

describe("the drill's blocks", () => {
  it.effect("are the six the restore drill uses, each with its declaration", () =>
    Effect.gen(function* () {
      const blocks = yield* drillBlocks;
      expect(blocks.map((block) => `${block.spec.id}@${block.spec.version}`)).toEqual([
        "d1.exportDatabase@1",
        "d1.createTemporaryDatabase@1",
        "d1.importExport@1",
        "d1.checkAgainstExport@1",
        "d1.destroyDatabase@2",
        "record.restoreDrill@1",
      ]);
      expect(blocks.map((block) => block.uses)).toEqual([
        ["@aemeth/blocks/D1Api", "@aemeth/blocks/Secrets"],
        ["@aemeth/blocks/D1Api"],
        ["@aemeth/blocks/D1Api", "@aemeth/blocks/Secrets"],
        ["@aemeth/blocks/D1Api"],
        ["@aemeth/blocks/D1Api"],
        ["@aemeth/blocks/RunRecord"],
      ]);
    }),
  );

  it.effect("restore a database end to end, and record what they compared", () =>
    Effect.gen(function* () {
      const { fake, production, world, run } = yield* drill;
      const exported = yield* run(
        "d1.exportDatabase",
        inputsOf({ database: asDatabase(production.id) }),
      );
      const outputs = succeeded(exported);
      expect(outputs).toMatchObject({
        export: { kind: "cloudflare.d1.export", id: "export:exportDatabase" },
        rowCount: 6,
      });
      // The link is held for the run and is in no output.
      expect(JSON.stringify(outputs)).not.toContain("d1-exports.invalid");
      expect(world.secrets.get("export:exportDatabase")).toMatch(
        /^https:\/\/d1-exports\.invalid\//u,
      );

      const created = yield* run(
        "d1.createTemporaryDatabase",
        inputsOf({ namePrefix: "restore-drill" }),
      );
      const temporary = { database: succeeded(created)["database"] ?? null };
      expect(fake.databases().map((each) => each.name)).toContain(`restore-drill-${runId}`);

      expect(
        Exit.isSuccess(
          yield* run(
            "d1.importExport",
            inputsOf({ export: outputs["export"]!, into: temporary.database }),
          ),
        ),
      ).toBe(true);
      const verified = yield* run(
        "d1.checkAgainstExport",
        inputsOf({
          database: temporary.database,
          rowCount: outputs["rowCount"]!,
          checksum: outputs["checksum"]!,
        }),
      );
      expect(verified).toEqual(Exit.succeed({ rowsCompared: 6 }));

      expect(
        Exit.isSuccess(
          yield* run("d1.destroyDatabase", inputsOf({}, { database: temporary.database })),
        ),
      ).toBe(true);
      expect(fake.databases().map((each) => each.id)).toEqual([production.id]);

      yield* run(
        "record.restoreDrill",
        inputsOf({}, { rowsCompared: 6, checksum: outputs["checksum"]! }),
      );
      expect(world.records).toEqual([{ rowsCompared: 6, checksum: outputs["checksum"] }]);
      expect(fake.effects).toEqual({ created: 1, deleted: 1, imported: 1, exported: 1 });
    }),
  );

  describe("d1.exportDatabase", () => {
    it.effect("fails, to be tried again, when the database changed while it was exported", () =>
      Effect.gen(function* () {
        const { fake, production, world, run } = yield* drill;
        fake.beforeNextExport(fake.write(production.id, ["INSERT INTO notes VALUES ('late')"]));
        const first = yield* run(
          "d1.exportDatabase",
          inputsOf({ database: asDatabase(production.id) }),
        );
        expect(failedAs(first)).toBe("SourceChangedDuringExport (retryable)");
        expect(world.secrets.size).toBe(0);
        // The retry finds the database settled.
        const second = yield* run(
          "d1.exportDatabase",
          inputsOf({ database: asDatabase(production.id) }),
        );
        expect(Exit.isSuccess(second)).toBe(true);
      }),
    );

    it.effect("run twice, holds one link for the run under the same name", () =>
      Effect.gen(function* () {
        const { production, world, run } = yield* drill;
        const first = yield* run(
          "d1.exportDatabase",
          inputsOf({ database: asDatabase(production.id) }),
        );
        const second = yield* run(
          "d1.exportDatabase",
          inputsOf({ database: asDatabase(production.id) }),
        );
        expect(Exit.isSuccess(first) && Exit.isSuccess(second)).toBe(true);
        expect([...world.secrets.keys()]).toEqual(["export:exportDatabase"]);
        expect(second).toEqual(first);
      }),
    );

    it.effect("fails as the API does, retryable only when Cloudflare was away", () =>
      Effect.gen(function* () {
        const { fake, production, run } = yield* drill;
        const database = inputsOf({ database: asDatabase(production.id) });
        fake.failNext("exportDatabase", "Unavailable");
        expect(failedAs(yield* run("d1.exportDatabase", database))).toBe(
          "D1Unavailable (retryable)",
        );
        fake.failNext("exportDatabase", "Failed");
        expect(failedAs(yield* run("d1.exportDatabase", database))).toBe("D1Failed (retryable)");
        fake.failNext("query", "Refused");
        expect(failedAs(yield* run("d1.exportDatabase", database))).toBe("D1Refused");
        const gone = inputsOf({ database: asDatabase("00000000-0000-4000-8000-999999999999") });
        expect(failedAs(yield* run("d1.exportDatabase", gone))).toBe("D1NotFound");
      }),
    );
  });

  describe("d1.createTemporaryDatabase", () => {
    it.effect("run twice, makes one database and names it both times", () =>
      Effect.gen(function* () {
        const { fake, run } = yield* drill;
        const inputs = inputsOf({ namePrefix: "restore-drill" });
        const first = yield* run("d1.createTemporaryDatabase", inputs);
        const second = yield* run("d1.createTemporaryDatabase", inputs);
        expect(second).toEqual(first);
        expect(fake.effects.created).toBe(1);
      }),
    );

    it.effect("finds the database whose create answered as lost, on the retry", () =>
      Effect.gen(function* () {
        const { fake, run } = yield* drill;
        const inputs = inputsOf({ namePrefix: "restore-drill" });
        fake.loseNextCreateAnswer();
        expect(failedAs(yield* run("d1.createTemporaryDatabase", inputs))).toBe(
          "D1Unavailable (retryable)",
        );
        expect(Exit.isSuccess(yield* run("d1.createTemporaryDatabase", inputs))).toBe(true);
        expect(fake.effects.created).toBe(1);
      }),
    );

    it.effect("fails, to be tried again, when its name is taken and not listed yet", () =>
      Effect.gen(function* () {
        const { fake, run } = yield* drill;
        fake.failNext("create", "AlreadyExists");
        const exit = yield* run(
          "d1.createTemporaryDatabase",
          inputsOf({ namePrefix: "restore-drill" }),
        );
        expect(failedAs(exit)).toBe("D1Unavailable (retryable)");
      }),
    );

    it.effect("gives each item of a for-each a database of its own", () =>
      Effect.gen(function* () {
        const { fake, blocks } = yield* drill;
        const world = worldOf(fake);
        const create = blockNamed(blocks, "d1.createTemporaryDatabase");
        const destroy = blockNamed(blocks, "d1.destroyDatabase");
        const made = [];
        for (const item of [0, 1]) {
          const step = { ...stepOf("createTemp"), item: Option.some(ItemIndex.make(item)) };
          made.push(
            succeeded(
              yield* Effect.exit(
                create.run(inputsOf({ namePrefix: "restore-drill" }), step, world.services),
              ),
            ),
          );
        }
        expect(made[0]).not.toEqual(made[1]);
        expect(fake.databases().map((each) => each.name)).toContain(`restore-drill-${runId}-1`);
        // An item's database is still the run's own, and is destroyed.
        const exit = yield* Effect.exit(
          destroy.run(
            inputsOf({}, { database: made[1]!["database"] ?? null }),
            stepOf("destroyTemp"),
            world.services,
          ),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(fake.effects.deleted).toBe(1);
      }),
    );

    it.effect("names a database another attempt made just before its create", () =>
      Effect.gen(function* () {
        const { fake, run } = yield* drill;
        // Another attempt's database is there by the time this one creates.
        fake.beforeNextCreate(
          Effect.asVoid(fake.seed(temporaryName("restore-drill", stepOf("x")), [])),
        );
        const exit = yield* run(
          "d1.createTemporaryDatabase",
          inputsOf({ namePrefix: "restore-drill" }),
        );
        expect(succeeded(exit)).toEqual({ database: asDatabase(fake.databases()[1]!.id) });
        expect(fake.effects.created).toBe(0);
      }),
    );
  });

  describe("d1.importExport", () => {
    it.effect("run twice, imports once", () =>
      Effect.gen(function* () {
        const { fake, production, run } = yield* drill;
        const exported = yield* run(
          "d1.exportDatabase",
          inputsOf({ database: asDatabase(production.id) }),
        );
        const created = yield* run("d1.createTemporaryDatabase", inputsOf({ namePrefix: "p" }));
        const inputs = inputsOf({
          export: Exit.isSuccess(exported) ? exported.value["export"]! : null,
          into: Exit.isSuccess(created) ? created.value["database"]! : null,
        });
        expect(Exit.isSuccess(yield* run("d1.importExport", inputs))).toBe(true);
        expect(Exit.isSuccess(yield* run("d1.importExport", inputs))).toBe(true);
        expect(fake.effects.imported).toBe(1);
      }),
    );

    it.effect("fails for good when the link has expired, or the run holds no link", () =>
      Effect.gen(function* () {
        const { fake, production, run } = yield* drill;
        const exported = yield* run(
          "d1.exportDatabase",
          inputsOf({ database: asDatabase(production.id) }),
        );
        const created = yield* run("d1.createTemporaryDatabase", inputsOf({ namePrefix: "p" }));
        const into = Exit.isSuccess(created) ? created.value["database"]! : null;
        fake.expireExports();
        const inputs = inputsOf({
          export: Exit.isSuccess(exported) ? exported.value["export"]! : null,
          into,
        });
        expect(failedAs(yield* run("d1.importExport", inputs))).toBe("ExportExpired");
        const missing = inputsOf({
          export: { kind: "cloudflare.d1.export", id: "export:other" },
          into,
        });
        expect(failedAs(yield* run("d1.importExport", missing))).toBe("ExportMissing");
      }),
    );
  });

  describe("d1.checkAgainstExport", () => {
    it.effect("fails for good when the figures differ", () =>
      Effect.gen(function* () {
        const { production, run } = yield* drill;
        const database = asDatabase(production.id);
        const figures = yield* figuresOf(production.id).pipe(
          Effect.provideService(D1Api, (yield* drill).fake.api),
        );
        expect(figures.rowCount).toBe(6);
        expect(
          failedAs(
            yield* run("d1.checkAgainstExport", inputsOf({ database, rowCount: 7, checksum: "x" })),
          ),
        ).toBe("FiguresDiffer");
      }),
    );
  });

  describe("d1.destroyDatabase", () => {
    it.effect("deletes only a database of its own run", () =>
      Effect.gen(function* () {
        const { fake, production, run } = yield* drill;
        const inputs = inputsOf({}, { database: asDatabase(production.id) });
        expect(failedAs(yield* run("d1.destroyDatabase", inputs))).toBe("RunTagMismatch");
        const another = yield* fake.seed(temporaryName("restore-drill", stepOf("x", otherRun)), []);
        expect(
          failedAs(
            yield* run("d1.destroyDatabase", inputsOf({}, { database: asDatabase(another.id) })),
          ),
        ).toBe("RunTagMismatch");
        expect(fake.effects.deleted).toBe(0);
      }),
    );

    it.effect("run twice, deletes once, and a database already gone is a success", () =>
      Effect.gen(function* () {
        const { fake, run } = yield* drill;
        const mine = yield* fake.seed(temporaryName("restore-drill", stepOf("x")), []);
        const inputs = inputsOf({}, { database: asDatabase(mine.id) });
        expect(Exit.isSuccess(yield* run("d1.destroyDatabase", inputs))).toBe(true);
        expect(Exit.isSuccess(yield* run("d1.destroyDatabase", inputs))).toBe(true);
        expect(fake.effects.deleted).toBe(1);
      }),
    );

    it.effect("given no database, finds the run's own by its prefix", () =>
      Effect.gen(function* () {
        const { fake, production, run } = yield* drill;
        const other = yield* fake.seed(temporaryName("restore-drill", stepOf("x", otherRun)), []);
        yield* fake.seed(temporaryName("restore-drill", stepOf("x")), []);
        expect(
          Exit.isSuccess(
            yield* run("d1.destroyDatabase", inputsOf({}, { namePrefix: "restore-drill" })),
          ),
        ).toBe(true);
        expect(
          fake
            .databases()
            .map((each) => each.id)
            .sort(),
        ).toEqual([production.id, other.id].sort());
        // With neither, there is nothing to destroy.
        expect(Exit.isSuccess(yield* run("d1.destroyDatabase", inputsOf({})))).toBe(true);
        expect(fake.effects.deleted).toBe(1);
      }),
    );

    it.effect("fails, to be tried again, when Cloudflare is away", () =>
      Effect.gen(function* () {
        const { fake, run } = yield* drill;
        const mine = yield* fake.seed(temporaryName("restore-drill", stepOf("x")), []);
        fake.failNext("delete", "Unavailable");
        const inputs = inputsOf({}, { database: asDatabase(mine.id) });
        expect(failedAs(yield* run("d1.destroyDatabase", inputs))).toBe(
          "D1Unavailable (retryable)",
        );
        expect(Exit.isSuccess(yield* run("d1.destroyDatabase", inputs))).toBe(true);
      }),
    );
  });

  describe("record.restoreDrill", () => {
    it.effect("records what is known, and is tried again when the record is away", () =>
      Effect.gen(function* () {
        const { world, run } = yield* drill;
        world.recordAwayFor(1);
        expect(failedAs(yield* run("record.restoreDrill", inputsOf({})))).toBe(
          "RecordUnavailable (retryable)",
        );
        expect(Exit.isSuccess(yield* run("record.restoreDrill", inputsOf({})))).toBe(true);
        expect(world.records).toEqual([{ rowsCompared: null, checksum: null }]);
      }),
    );
  });
});

describe("a database's figures", () => {
  it.effect("do not depend on the order rows were written in, and change with any value", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeD1;
      // `b` has no type, so SQLite keeps each value as it was written.
      const schema = "CREATE TABLE t (a INTEGER, b)";
      const one = yield* fake.seed("one", [schema, "INSERT INTO t VALUES (1, 'x'), (2, 'y')"]);
      const two = yield* fake.seed("two", [schema, "INSERT INTO t VALUES (2, 'y'), (1, 'x')"]);
      const three = yield* fake.seed("three", [schema, "INSERT INTO t VALUES (1, 'x'), (2, 'Y')"]);
      const four = yield* fake.seed("four", [schema, "INSERT INTO t VALUES (1, 'x'), (2, '2')"]);
      const five = yield* fake.seed("five", [schema, "INSERT INTO t VALUES (1, 'x'), (2, 2)"]);
      const figures = yield* Effect.forEach([one, two, three, four, five], (database) =>
        figuresOf(database.id),
      ).pipe(Effect.provideService(D1Api, fake.api));
      expect(figures[0]).toEqual(figures[1]);
      expect(new Set(figures.map((each) => each.checksum)).size).toBe(4);
      // A text '2' and an integer 2 are told apart: quote() writes the one with quotes.
      expect(figures[3]!.checksum).not.toBe(figures[4]!.checksum);
    }),
  );

  it.effect("read every row of a table longer than a page", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeD1;
      const rows = pageSize * 2 + 7;
      const database = yield* fake.seed("long", [
        "CREATE TABLE t (n INTEGER)",
        `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${rows}) INSERT INTO t SELECT n FROM c`,
      ]);
      const figures = yield* figuresOf(database.id).pipe(Effect.provideService(D1Api, fake.api));
      expect(figures.rowCount).toBe(rows);
      const removed = yield* fake.seed("long minus one", [
        "CREATE TABLE t (n INTEGER)",
        `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${rows - 1}) INSERT INTO t SELECT n FROM c`,
      ]);
      const fewer = yield* figuresOf(removed.id).pipe(Effect.provideService(D1Api, fake.api));
      expect(fewer.rowCount).toBe(rows - 1);
      expect(fewer.checksum).not.toBe(figures.checksum);
    }),
  );
});
