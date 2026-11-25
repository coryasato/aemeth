import type * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Option, Schema } from "effect";
import { Archive, ArchiveFailed } from "../Archive";
import { IndexFailed, RunIndex, RunRow } from "../RunIndex";

/**
 * Runs a binding call where there is no request: a workflow's activity. Alchemy's binding
 * clients need the Worker's `RuntimeContext`, which a request handler has and a workflow's layer
 * does not (M2 Part A, "the one awkward seam").
 */
export type WithHost = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) => Effect.Effect<A, E>;

/**
 * Whatever the binding does wrong, typed or thrown, is one failure the workflow tries again. An
 * interrupt is not a failure and passes through. Applied before `withHost`, so a call made where
 * there is no Worker stays the defect it is.
 */
const failing =
  <Failure>(make: (message: string) => Failure) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Failure, R> =>
    effect.pipe(
      Effect.mapError((error) => make(String(error))),
      Effect.catchDefect((defect) => Effect.fail(make(String(defect)))),
    );

/** The archive on an R2 bucket. `If-None-Match: *` is what makes a write happen once. */
export const archiveOn = (
  bucket: Cloudflare.R2.ReadWriteBucketClient,
  withHost: WithHost,
): Archive["Service"] =>
  Archive.of({
    putOnce: (key, text) =>
      bucket
        .put(key, text, {
          onlyIf: new Headers({ "If-None-Match": "*" }),
          httpMetadata: { contentType: "application/json" },
        })
        .pipe(
          // `null` is R2's answer when the condition failed: an object is already there.
          Effect.map((written) => written !== null),
          failing((message) => new ArchiveFailed({ message })),
          withHost,
        ),
    get: (key) =>
      bucket.get(key).pipe(
        Effect.flatMap((object) => (object === null ? Effect.undefined : object.text())),
        failing((message) => new ArchiveFailed({ message })),
        withHost,
      ),
  });

const Stored = Schema.Struct({
  id: Schema.String,
  recipe_id: Schema.String,
  recipe_version: Schema.Finite,
  state: Schema.String,
  started_at: Schema.Finite,
  ended_at: Schema.NullOr(Schema.Finite),
  archive_key: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String),
});
const decodeStored = Schema.decodeUnknownEffect(Stored);
const decodeRow = Schema.decodeUnknownEffect(RunRow);
const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** The index on a D1 database: the `runs` table of `migrations/0001_runs.sql`. */
export const indexOn = (
  database: Cloudflare.D1.QueryDatabaseClient,
  withHost: WithHost,
): RunIndex["Service"] =>
  RunIndex.of({
    started: ({ runId, recipe, at }) =>
      database
        .prepare(
          "INSERT INTO runs (id, recipe_id, recipe_version, state, started_at) VALUES (?1, ?2, ?3, 'Running', ?4) ON CONFLICT (id) DO NOTHING",
        )
        .bind(runId, recipe.id, recipe.version, at)
        .run()
        .pipe(
          Effect.asVoid,
          failing((message) => new IndexFailed({ message })),
          withHost,
        ),
    ended: ({ runId, state, at, archiveKey }) =>
      database
        .prepare("UPDATE runs SET state = ?2, ended_at = ?3, archive_key = ?4 WHERE id = ?1")
        .bind(runId, state, at, archiveKey)
        .run()
        .pipe(
          failing((message) => new IndexFailed({ message })),
          // An update that changed no row recorded nothing: the run is not in the index.
          Effect.flatMap((result) =>
            result.meta.changes === 1
              ? Effect.void
              : Effect.fail(new IndexFailed({ message: `The index has no row for ${runId}.` })),
          ),
          withHost,
        ),
    find: (runId) =>
      Effect.gen(function* () {
        const found = yield* database
          .prepare("SELECT * FROM runs WHERE id = ?1")
          .bind(runId)
          .first();
        if (found === null) {
          return undefined;
        }
        const row = yield* decodeStored(found);
        return yield* decodeRow({
          id: row.id,
          recipe: { id: row.recipe_id, version: row.recipe_version },
          state: row.state,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          archiveKey: row.archive_key,
          result: row.result === null ? null : Option.getOrNull(decodeResult(row.result)),
        });
      }).pipe(
        failing((message) => new IndexFailed({ message })),
        withHost,
      ),
  });
