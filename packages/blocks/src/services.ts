import type { Effect, Option } from "effect";
import { Context, Schema } from "effect";

// The services a block reaches the outside world through, other than `Secrets`. The engine
// offers each to the blocks that list it (M2, "Blocks"); a block's tests give it a fake.

/** A D1 database as Cloudflare names it: its UUID and its name. */
export type D1Database = { readonly id: string; readonly name: string };

/** A row of a query's results, by column name. */
export type D1Row = { readonly [column: string]: Schema.Json };

/**
 * Why a call to the D1 API did not do what was asked.
 *
 * - `NotFound`: the database is not there.
 * - `AlreadyExists`: a database of that name is there already.
 * - `ExportExpired`: the export's download link no longer works.
 * - `Unavailable`: Cloudflare could not be reached, answered 5xx, or asked to slow down.
 * - `Refused`: Cloudflare refused the request, as a 4xx other than the above.
 * - `Failed`: an export or an import that Cloudflare took on ended in an error.
 */
export const D1FailureReason = Schema.Literals([
  "NotFound",
  "AlreadyExists",
  "ExportExpired",
  "Unavailable",
  "Refused",
  "Failed",
]);
export type D1FailureReason = typeof D1FailureReason.Type;

/** A call to the D1 API that failed, with what the block can do about it. */
export class D1Failed extends Schema.TaggedError<D1Failed, { readonly brand: unique symbol }>()(
  "D1Failed",
  { reason: D1FailureReason, operation: Schema.String, message: Schema.String },
) {}

/**
 * Cloudflare's D1 API, as the drill's blocks use it (M2, "The restore drill's blocks"). A target
 * database is a recipe input, not a binding, so the engine calls the REST API with a token of its
 * own (M2 decision 12).
 */
export class D1Api extends Context.Service<
  D1Api,
  {
    /** One statement, its `?` filled by `params` in order, and the rows it returns. */
    readonly query: (
      database: string,
      sql: string,
      params?: ReadonlyArray<string | number>,
    ) => Effect.Effect<ReadonlyArray<D1Row>, D1Failed>;
    /**
     * Exports a database and waits until the export is ready. The link downloads the whole
     * database as SQL and works for about an hour. The database is blocked while it is exported.
     */
    readonly exportDatabase: (
      database: string,
    ) => Effect.Effect<{ readonly url: string }, D1Failed>;
    /**
     * Downloads an export and imports it into a database, waiting until it is done. Cloudflare
     * imports the same file again if asked twice, so a caller that may repeat itself looks first.
     * `ExportExpired` if the link no longer works.
     */
    readonly importExport: (database: string, url: string) => Effect.Effect<void, D1Failed>;
    readonly create: (name: string) => Effect.Effect<D1Database, D1Failed>;
    readonly get: (database: string) => Effect.Effect<Option.Option<D1Database>, D1Failed>;
    readonly findByName: (name: string) => Effect.Effect<Option.Option<D1Database>, D1Failed>;
    /** Deletes a database. One that is not there is not an error. */
    readonly delete: (database: string) => Effect.Effect<void, D1Failed>;
  }
>()("@aemeth/blocks/D1Api") {}

/** The run's record could not be written just now. */
export class RecordUnavailable extends Schema.TaggedError<
  RecordUnavailable,
  { readonly brand: unique symbol }
>()("RecordUnavailable", { message: Schema.String }) {}

/**
 * The run's own record in the index (M2, "Persistence"): what a record block writes there, such
 * as the rows a drill compared. A second write replaces the first.
 */
export class RunRecord extends Context.Service<
  RunRecord,
  { readonly write: (result: Schema.Json) => Effect.Effect<void, RecordUnavailable> }
>()("@aemeth/blocks/RunRecord") {}

/**
 * Why a call to the R2 API did not do what was asked.
 *
 * - `Unavailable`: Cloudflare could not be reached, answered 5xx, or asked to slow down.
 * - `Refused`: Cloudflare refused the request, as a 4xx other than an object that is not there.
 */
export const R2FailureReason = Schema.Literals(["Unavailable", "Refused"]);
export type R2FailureReason = typeof R2FailureReason.Type;

/** A call to the R2 API that failed. */
export class R2Failed extends Schema.TaggedError<R2Failed, { readonly brand: unique symbol }>()(
  "R2Failed",
  { reason: R2FailureReason, operation: Schema.String, message: Schema.String },
) {}

/**
 * Cloudflare's R2 API, as the archive check reads it (M2 decision 13). A bucket to check is a
 * recipe input, not a binding, so the engine calls the REST API with its own token, as it does
 * for D1.
 */
export class R2Api extends Context.Service<
  R2Api,
  {
    /** An object's text, or `None` if the bucket holds nothing at that key. */
    readonly get: (bucket: string, key: string) => Effect.Effect<Option.Option<string>, R2Failed>;
  }
>()("@aemeth/blocks/R2Api") {}
