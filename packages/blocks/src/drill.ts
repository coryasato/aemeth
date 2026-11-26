import { BlockSpec } from "@aemeth/core";
import { Effect, Option, Schema } from "effect";
import { Digest } from "effect/crypto";
import {
  checkAgainstExportSpec,
  createTemporaryDatabaseSpec,
  destroyDatabaseSpec,
  exportDatabaseSpec,
  importExportSpec,
} from "./d1";
import type { Block, BlockInputs, StepContext } from "./implement";
import { BlockFailed, implement, Secrets } from "./implement";
import { recordRestoreDrillSpec } from "./record";
import type { D1Database } from "./services";
import { D1Api, D1Failed, RunRecord } from "./services";

// The restore drill's six blocks (M2, "The restore drill's blocks"). Each reaches Cloudflare only
// through `D1Api`, holds the export's link only through `Secrets`, and writes the run's result
// only through `RunRecord`.

const Database = Schema.Struct({
  kind: Schema.Literal("cloudflare.d1.database"),
  id: Schema.String,
});
const Export = Schema.Struct({ kind: Schema.Literal("cloudflare.d1.export"), id: Schema.String });

const fail = (reason: string, message: string, retryable: boolean) =>
  Effect.fail(new BlockFailed({ reason, message, retryable }));

/**
 * A failure of the D1 API as a block's failure. Cloudflare being away is worth trying again; a
 * refusal is not, since the same request will be refused again.
 */
const fromApi = (error: D1Failed) =>
  fail(
    `D1${error.reason}`,
    `${error.operation}: ${error.message}`,
    error.reason === "Unavailable" || error.reason === "Failed",
  );

/** A required input in its written form, decoded. The engine has checked its type already. */
const input = <A, I>(schema: Schema.Codec<A, I>, inputs: BlockInputs, name: string) =>
  Schema.decodeUnknownEffect(schema)(inputs.required[name]).pipe(
    Effect.mapError(
      (issue) =>
        new BlockFailed({
          reason: "InputUnreadable",
          message: `Input ${name}: ${String(issue)}`,
          retryable: false,
        }),
    ),
  );

const optionalInput = <A, I>(schema: Schema.Codec<A, I>, inputs: BlockInputs, name: string) =>
  Option.match(inputs.optional[name] ?? Option.none(), {
    onNone: () => Effect.succeedNone,
    onSome: (value) =>
      Effect.asSome(input(schema, { required: { [name]: value }, optional: {} }, name)),
  });

/** What tells apart the items of a for-each in a name: nothing outside one, `-<item>` in one. */
const itemPart = (step: StepContext): string =>
  Option.match(step.item, { onNone: () => "", onSome: (item) => `-${item}` });

/**
 * The name a run's temporary database has: its prefix, then the run (M2 decision 5), then the
 * item when the step is one of a for-each's, so that no two items share a database.
 */
export const temporaryName = (namePrefix: string, step: StepContext): string =>
  `${namePrefix}-${step.runId}${itemPart(step)}`;

/** Whether a database's name says it belongs to this run: its run id, and perhaps an item. */
const ofRun = (name: string, step: StepContext): boolean =>
  new RegExp(`-${step.runId}(-[0-9]+)?$`, "u").test(name);

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Rows hashed at a time: the hash is taken page by page, so the page is part of its definition. */
export const pageSize = 500;

/** What the drill compares: how many rows there are, and a checksum over all of them. */
export type Figures = { readonly rowCount: number; readonly checksum: string };

const Name = Schema.Struct({ name: Schema.String });
const Row = Schema.Struct({ r: Schema.String });

/**
 * The figures of a database (M2 decision 4): every table but SQLite's and Cloudflare's own, in
 * name order; every row of each, written column by column through `quote()`, in the order of that
 * text. The checksum is SHA-256, taken page by page: each page's digest covers the digest before
 * it, the table's name and the page's rows, so it does not depend on how the rows are stored,
 * only on what they hold. Hashed in the Worker: D1 has no hash function.
 */
export const figuresOf = (database: string) =>
  Effect.gen(function* () {
    const api = yield* D1Api;
    const digest = yield* Digest.Digest;
    const encoder = new TextEncoder();
    const read = <A, I>(
      schema: Schema.Codec<A, I>,
      sql: string,
      params?: ReadonlyArray<string | number>,
    ) =>
      Effect.flatMap(api.query(database, sql, params), (rows) =>
        Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
          Effect.mapError(
            (issue) =>
              new D1Failed({
                reason: "Refused",
                operation: "query",
                message: `D1 answered rows of an unknown form: ${String(issue)}`,
              }),
          ),
        ),
      );
    const tables = yield* read(
      Name,
      String.raw`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name NOT LIKE '\_cf\_%' ESCAPE '\' ORDER BY name`,
    );
    let state = yield* digest.digestHex(Digest.sha256, new Uint8Array());
    let rowCount = 0;
    for (const { name } of tables) {
      const columns = yield* read(Name, `PRAGMA table_info(${quoted(name)})`);
      const text = columns.map((column) => `quote(${quoted(column.name)})`).join(" || ',' || ");
      for (let offset = 0; ; offset += pageSize) {
        const rows = yield* read(
          Row,
          // Both numbers are written in: D1's API takes its parameters as text.
          `SELECT ${text} AS r FROM ${quoted(name)} ORDER BY r LIMIT ${pageSize} OFFSET ${offset}`,
        );
        if (rows.length === 0) {
          break;
        }
        rowCount += rows.length;
        const page = [state, name, ...rows.map((row) => row.r)].join("\n");
        state = yield* digest.digestHex(Digest.sha256, encoder.encode(page));
        if (rows.length < pageSize) {
          break;
        }
      }
    }
    const figures: Figures = { rowCount, checksum: state };
    return figures;
  }).pipe(Effect.provide(Digest.layerWebCrypto));

const sameFigures = (a: Figures, b: Figures): boolean =>
  a.rowCount === b.rowCount && a.checksum === b.checksum;

/** The name of the secret that holds a step's export link. */
const exportSecret = (step: StepContext): string => `export:${step.step}${itemPart(step)}`;

/** `d1.exportDatabase`: the figures, the export, the figures again (M2 decision 4). */
const exportDatabase = (spec: BlockSpec): Block =>
  implement({
    spec,
    uses: [D1Api, Secrets],
    run: (inputs, step) =>
      Effect.gen(function* () {
        const database = yield* input(Database, inputs, "database");
        const api = yield* D1Api;
        const before = yield* figuresOf(database.id);
        const { url } = yield* api.exportDatabase(database.id);
        const after = yield* figuresOf(database.id);
        if (!sameFigures(before, after)) {
          return yield* fail(
            "SourceChangedDuringExport",
            `The database changed while it was exported: ${before.rowCount} rows before, ${after.rowCount} after.`,
            true,
          );
        }
        // The link downloads the whole database: it is held for the run, never logged (decision 16).
        yield* (yield* Secrets).put(exportSecret(step), url);
        return {
          export: { kind: "cloudflare.d1.export", id: exportSecret(step) },
          rowCount: after.rowCount,
          checksum: after.checksum,
        };
      }).pipe(Effect.catchTag("D1Failed", fromApi)),
  });

/** `d1.createTemporaryDatabase`: one database per run, named again, not made again, on a re-run. */
const createTemporaryDatabase = (spec: BlockSpec): Block =>
  implement({
    spec,
    uses: [D1Api],
    run: (inputs, step) =>
      Effect.gen(function* () {
        const namePrefix = yield* input(Schema.String, inputs, "namePrefix");
        const api = yield* D1Api;
        const name = temporaryName(namePrefix, step);
        // A database of this name is one an earlier attempt or run of this step made, whose
        // answer was lost: it is the one this step makes, so it is named again, not made again.
        const made: D1Database = yield* api.create(name).pipe(
          Effect.catchIf(
            (error) => error.reason === "AlreadyExists",
            (error) =>
              Effect.flatMap(api.findByName(name), (found) =>
                // Taken, and not listed yet: the list can lag a create that just happened.
                Effect.mapError(Effect.fromOption(found), () =>
                  error.reason === "AlreadyExists"
                    ? new D1Failed({
                        reason: "Unavailable",
                        operation: "create",
                        message: `${name} is taken, and not yet listed.`,
                      })
                    : error,
                ),
              ),
          ),
        );
        return { database: { kind: "cloudflare.d1.database", id: made.id } };
      }).pipe(Effect.catchTag("D1Failed", fromApi)),
  });

/** `d1.importExport`: the export, read through its secret, into the temporary database. */
const importExport = (spec: BlockSpec): Block =>
  implement({
    spec,
    uses: [D1Api, Secrets],
    run: (inputs) =>
      Effect.gen(function* () {
        const exported = yield* input(Export, inputs, "export");
        const into = yield* input(Database, inputs, "into");
        const url = yield* (yield* Secrets).get(exported.id);
        if (Option.isNone(url)) {
          return yield* fail(
            "ExportMissing",
            `The run holds no export named ${exported.id}.`,
            false,
          );
        }
        const api = yield* D1Api;
        // Cloudflare runs an import again when it is given the same file again, and the export's
        // CREATE TABLE would then fail. A temporary database that holds tables already was
        // restored by an earlier attempt whose answer was lost; the check after this says
        // whether that restore is whole.
        const tables = yield* api.query(
          into.id,
          String.raw`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name NOT LIKE '\_cf\_%' ESCAPE '\'`,
        );
        if (Number(tables[0]?.["n"] ?? 0) > 0) {
          return {};
        }
        yield* api.importExport(into.id, url.value);
        return {};
      }).pipe(
        Effect.catchTag("D1Failed", (error) =>
          error.reason === "ExportExpired"
            ? fail("ExportExpired", `${error.operation}: ${error.message}`, false)
            : fromApi(error),
        ),
      ),
  });

/** `d1.checkAgainstExport`: the same figures, taken on the restored database. */
const checkAgainstExport = (spec: BlockSpec): Block =>
  implement({
    spec,
    uses: [D1Api],
    run: (inputs) =>
      Effect.gen(function* () {
        const database = yield* input(Database, inputs, "database");
        const rowCount = yield* input(Schema.Int, inputs, "rowCount");
        const checksum = yield* input(Schema.String, inputs, "checksum");
        const restored = yield* figuresOf(database.id);
        if (!sameFigures(restored, { rowCount, checksum })) {
          return yield* fail(
            "FiguresDiffer",
            `The restored database has ${restored.rowCount} rows and checksum ${restored.checksum}; the export had ${rowCount} and ${checksum}.`,
            false,
          );
        }
        return { rowsCompared: restored.rowCount };
      }).pipe(Effect.catchTag("D1Failed", fromApi)),
  });

/**
 * `d1.destroyDatabase`, version 2 (M2 decision 18). Given a database, it deletes it only if its
 * name ends with this run's id. Given none, it looks the run's database up by `namePrefix`: a
 * create that succeeded at Cloudflare and was logged as failed left no output to name it by.
 * Given neither, there is nothing to destroy. A database already gone is a success.
 */
const destroyDatabase = (spec: BlockSpec): Block =>
  implement({
    spec,
    uses: [D1Api],
    run: (inputs, step) =>
      Effect.gen(function* () {
        const api = yield* D1Api;
        const given = yield* optionalInput(Database, inputs, "database");
        const namePrefix = yield* optionalInput(Schema.String, inputs, "namePrefix");
        if (Option.isSome(given)) {
          const found = yield* api.get(given.value.id);
          if (Option.isNone(found)) {
            return {};
          }
          if (!ofRun(found.value.name, step)) {
            return yield* fail(
              "RunTagMismatch",
              `${found.value.name} is not a database of run ${step.runId}; it was left alone.`,
              false,
            );
          }
          yield* api.delete(found.value.id);
          return {};
        }
        if (Option.isSome(namePrefix)) {
          const found = yield* api.findByName(temporaryName(namePrefix.value, step));
          if (Option.isSome(found)) {
            yield* api.delete(found.value.id);
          }
        }
        return {};
      }).pipe(Effect.catchTag("D1Failed", fromApi)),
  });

/** `record.restoreDrill`: what the drill found, on the run's row in the index. */
const recordRestoreDrill = (spec: BlockSpec): Block =>
  implement({
    spec,
    uses: [RunRecord],
    run: (inputs) =>
      Effect.gen(function* () {
        const rowsCompared = yield* optionalInput(Schema.Int, inputs, "rowsCompared");
        const checksum = yield* optionalInput(Schema.String, inputs, "checksum");
        yield* (yield* RunRecord).write({
          rowsCompared: Option.getOrNull(rowsCompared),
          checksum: Option.getOrNull(checksum),
        });
        return {};
      }).pipe(
        Effect.catchTag("RecordUnavailable", (error) =>
          fail("RecordUnavailable", error.message, true),
        ),
      ),
  });

const decodeSpec = Schema.decodeEffect(BlockSpec, { onExcessProperty: "error" });

/** Each declaration with the code that implements it. */
const implemented = [
  [exportDatabaseSpec, exportDatabase],
  [createTemporaryDatabaseSpec, createTemporaryDatabase],
  [importExportSpec, importExport],
  [checkAgainstExportSpec, checkAgainstExport],
  [destroyDatabaseSpec, destroyDatabase],
  [recordRestoreDrillSpec, recordRestoreDrill],
] as const;

/**
 * The restore drill's blocks, as the engine runs them: each declaration, decoded, with its code.
 * A declaration that does not decode is a fault of this package, which its tests show.
 */
export const drillBlocks: Effect.Effect<ReadonlyArray<Block>> = Effect.orDie(
  Effect.forEach(implemented, ([declaration, make]) => Effect.map(decodeSpec(declaration), make)),
);
