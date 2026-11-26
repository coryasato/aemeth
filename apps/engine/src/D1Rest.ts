import type { D1Database, D1FailureReason, D1Row } from "@aemeth/blocks";
import { D1Api, D1Failed } from "@aemeth/blocks";
import { Duration, Effect, Option, Redacted, Schema } from "effect";
import { Digest } from "effect/crypto";
import type { HttpClientResponse } from "effect/http";
import { HttpClient, HttpClientRequest } from "effect/http";

// The D1 API the drill's blocks are given (M2 decision 12): a small client over `HttpClient`
// for the calls the drill makes, with the engine's own token. Cloudflare's REST API answers in
// one envelope, `{ success, errors, result }`; the codes below are D1's own.

const api = "https://api.cloudflare.com/client/v4";
/** D1's code for a name already taken. */
const alreadyExists = 7502;
/** D1's code for a database that is not there. */
const notFound = 7404;

/** How long an export or an import is waited for, and how often it is asked after. */
const waitAtMost = Duration.minutes(10);
const askEvery = Duration.seconds(1);

const Envelope = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ code: Schema.Int, message: Schema.String })),
  ),
  result: Schema.optional(Schema.Unknown),
});

const DatabaseResult = Schema.Struct({ uuid: Schema.String, name: Schema.String });
const QueryResult = Schema.Array(
  Schema.Struct({ results: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }),
);
const Progress = Schema.Struct({
  status: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  at_bookmark: Schema.optional(Schema.NullOr(Schema.String)),
  success: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
const ExportProgress = Schema.Struct({
  ...Progress.fields,
  result: Schema.optional(
    Schema.NullOr(Schema.Struct({ signed_url: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});
const ImportStart = Schema.Struct({
  ...Progress.fields,
  upload_url: Schema.optional(Schema.NullOr(Schema.String)),
  filename: Schema.optional(Schema.NullOr(Schema.String)),
});

const failed = (operation: string, reason: D1FailureReason, message: string) =>
  new D1Failed({ reason, operation, message });

/** What a status and D1's error codes mean for the block that asked. */
const reasonOf = (status: number, codes: ReadonlyArray<number>): D1FailureReason => {
  if (codes.includes(alreadyExists)) {
    return "AlreadyExists";
  }
  if (status === 404 || codes.includes(notFound)) {
    return "NotFound";
  }
  return status === 429 || status >= 500 ? "Unavailable" : "Refused";
};

const opened = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Envelope)),
    Effect.mapError(() =>
      failed(
        operation,
        response.status === 429 || response.status >= 500 ? "Unavailable" : "Refused",
        `HTTP ${response.status}, and not Cloudflare's answer`,
      ),
    ),
  );

/** Asks again, every second, until `done` says it has an answer, for at most ten minutes. */
const until = <A, E, B>(
  operation: string,
  first: A,
  next: (current: A) => Effect.Effect<A, E>,
  done: (current: A) => Effect.Effect<Option.Option<B>, D1Failed>,
) =>
  Effect.gen(function* () {
    let current = first;
    for (
      let asked = 0;
      asked * Duration.toMillis(askEvery) < Duration.toMillis(waitAtMost);
      asked++
    ) {
      const answer = yield* done(current);
      if (Option.isSome(answer)) {
        return answer.value;
      }
      yield* Effect.sleep(askEvery);
      current = yield* next(current);
    }
    return yield* failed(operation, "Unavailable", "Cloudflare did not finish in ten minutes.");
  });

/**
 * Whether an export or an import is over. One that failed, or that Cloudflare gave no bookmark to
 * ask after, is a failure: asking again without a bookmark would start the work over.
 */
const progressDone = <B>(
  operation: string,
  progress: typeof Progress.Type,
  value: () => Option.Option<B>,
): Effect.Effect<Option.Option<B>, D1Failed> => {
  if (progress.status === "error" || progress.success === false) {
    return Effect.fail(
      failed(operation, "Failed", progress.error ?? "Cloudflare reported an error."),
    );
  }
  if (progress.status === "complete") {
    return Effect.succeed(value());
  }
  return progress.at_bookmark === undefined || progress.at_bookmark === null
    ? Effect.fail(failed(operation, "Failed", "Cloudflare gave no bookmark to ask after."))
    : Effect.succeedNone;
};

const databaseOf = ({ uuid, name }: typeof DatabaseResult.Type): D1Database => ({
  id: uuid,
  name,
});

/** The fields of a request's JSON body. */
type Fields = { readonly [key: string]: string };

/** A body with a field that is there only when it has a value. */
const withField = (body: Fields, key: string, value: string | null | undefined): Fields =>
  value === undefined || value === null ? body : Object.assign({}, body, { [key]: value });

/** The settings the engine calls D1 with: its account, and a token with `D1 Write` on it. */
export type D1Settings = { readonly accountId: string; readonly token: Redacted.Redacted<string> };

/** The D1 API over Cloudflare's REST API. */
export const makeD1Rest = ({ accountId, token }: D1Settings) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const digest = yield* Digest.Digest;
    const base = `${api}/accounts/${accountId}/d1/database`;

    /** One call, its envelope opened: the result, or why there is none. */
    const call = <A, I>(
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
      schema: Schema.Codec<A, I>,
    ) =>
      Effect.gen(function* () {
        const response = yield* client.execute(
          HttpClientRequest.bearerToken(request, Redacted.value(token)),
        );
        const envelope = yield* opened(operation, response);
        if (response.status >= 400 || !envelope.success) {
          const errors = envelope.errors ?? [];
          return yield* failed(
            operation,
            reasonOf(
              response.status,
              errors.map((error) => error.code),
            ),
            errors.map((error) => `${error.code} ${error.message}`).join("; ") ||
              `HTTP ${response.status}`,
          );
        }
        return yield* Schema.decodeUnknownEffect(schema)(envelope.result).pipe(
          Effect.mapError((issue) =>
            failed(
              operation,
              "Refused",
              `Cloudflare answered in an unknown form: ${String(issue)}`,
            ),
          ),
        );
      }).pipe(
        Effect.catchTag("HttpClientError", (error) =>
          Effect.fail(failed(operation, "Unavailable", error.message)),
        ),
      );

    const exportOnce = (database: string, bookmark: string | null | undefined) =>
      call(
        "exportDatabase",
        HttpClientRequest.bodyJsonUnsafe(
          HttpClientRequest.post(`${base}/${encodeURIComponent(database)}/export`),
          withField({ output_format: "polling" }, "current_bookmark", bookmark),
        ),
        ExportProgress,
      );

    const importCall = (database: string, body: Fields) =>
      call(
        "importExport",
        HttpClientRequest.bodyJsonUnsafe(
          HttpClientRequest.post(`${base}/${encodeURIComponent(database)}/import`),
          body,
        ),
        ImportStart,
      );

    return D1Api.of({
      query: (database, sql, params = []) =>
        Effect.map(
          call(
            "query",
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${base}/${encodeURIComponent(database)}/query`),
              {
                sql,
                params,
              },
            ),
            QueryResult,
          ),
          (results): ReadonlyArray<D1Row> => results.flatMap((result) => result.results),
        ),

      exportDatabase: (database) =>
        Effect.flatMap(exportOnce(database, undefined), (first) =>
          until(
            "exportDatabase",
            first,
            (current) => exportOnce(database, current.at_bookmark),
            (current) =>
              progressDone("exportDatabase", current, () =>
                Option.map(Option.fromNullishOr(current.result?.signed_url), (url) => ({ url })),
              ),
          ),
        ),

      importExport: (database, url) =>
        Effect.gen(function* () {
          const download = yield* client
            .get(url)
            .pipe(
              Effect.catchTag("HttpClientError", (error) =>
                Effect.fail(failed("importExport", "Unavailable", error.message)),
              ),
            );
          // A signed link that has run out answers 4xx: it will not work again.
          if (download.status >= 400 && download.status < 500) {
            return yield* failed(
              "importExport",
              "ExportExpired",
              `The export's link answered ${download.status}.`,
            );
          }
          if (download.status >= 400) {
            return yield* failed(
              "importExport",
              "Unavailable",
              `The export's link answered ${download.status}.`,
            );
          }
          const bytes = new Uint8Array(
            yield* download.arrayBuffer.pipe(
              Effect.mapError((error) => failed("importExport", "Unavailable", error.message)),
            ),
          );
          // Cloudflare knows a file by its MD5: the same file again is not imported twice.
          const etag = yield* digest.digestHex(Digest.md5, bytes);
          const started = yield* importCall(database, { action: "init", etag });
          let progress: typeof ImportStart.Type = started;
          if (started.upload_url !== undefined && started.upload_url !== null) {
            const uploaded = yield* client
              .execute(
                HttpClientRequest.bodyUint8Array(
                  HttpClientRequest.put(started.upload_url),
                  bytes,
                  "application/sql",
                ),
              )
              .pipe(
                Effect.catchTag("HttpClientError", (error) =>
                  Effect.fail(failed("importExport", "Unavailable", error.message)),
                ),
              );
            if (uploaded.status >= 300) {
              return yield* failed(
                "importExport",
                "Unavailable",
                `The upload answered ${uploaded.status}.`,
              );
            }
            progress = yield* importCall(
              database,
              withField({ action: "ingest", etag }, "filename", started.filename),
            );
          }
          yield* until(
            "importExport",
            progress,
            (current) =>
              importCall(
                database,
                withField({ action: "poll" }, "current_bookmark", current.at_bookmark),
              ),
            (current) => progressDone("importExport", current, () => Option.some(undefined)),
          );
        }),

      create: (name) =>
        Effect.map(
          call(
            "create",
            HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(base), { name }),
            DatabaseResult,
          ),
          databaseOf,
        ),

      get: (database) =>
        call(
          "get",
          HttpClientRequest.get(`${base}/${encodeURIComponent(database)}`),
          DatabaseResult,
        ).pipe(
          Effect.map((found) => Option.some(databaseOf(found))),
          Effect.catchIf(
            (error) => error.reason === "NotFound",
            () => Effect.succeedNone,
          ),
        ),

      findByName: (name) =>
        Effect.map(
          call(
            "findByName",
            HttpClientRequest.get(base, { urlParams: { name, per_page: "100" } }),
            Schema.Array(DatabaseResult),
          ),
          // The list's filter is by part of the name: the database is the one with all of it.
          (found) =>
            Option.map(
              Option.fromUndefinedOr(found.find((each) => each.name === name)),
              databaseOf,
            ),
        ),

      delete: (database) =>
        call(
          "delete",
          HttpClientRequest.delete(`${base}/${encodeURIComponent(database)}`),
          Schema.Unknown,
        ).pipe(
          Effect.asVoid,
          Effect.catchIf(
            (error) => error.reason === "NotFound",
            () => Effect.void,
          ),
        ),
    });
  });
