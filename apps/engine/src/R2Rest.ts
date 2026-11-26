import type { R2FailureReason } from "@aemeth/blocks";
import { R2Api, R2Failed } from "@aemeth/blocks";
import { Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

// The R2 API the archive check is given (M2 decision 13): one call over `HttpClient`, an
// object's text, with the engine's own token. An object is answered as its bytes; a failure in
// Cloudflare's envelope, `{ success, errors }`, whose codes below are R2's own.

const api = "https://api.cloudflare.com/client/v4";
/** R2's code for a key the bucket does not hold. */
const noSuchKey = 10_007;

const Errors = Schema.Struct({
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ code: Schema.Int, message: Schema.String })),
  ),
});

const failed = (reason: R2FailureReason, message: string) =>
  new R2Failed({ reason, operation: "get", message });

/** The settings the engine calls R2 with: its account, and a token that can read R2. */
export type R2Settings = { readonly accountId: string; readonly token: Redacted.Redacted<string> };

/** The R2 API over Cloudflare's REST API. */
export const makeR2Rest = ({ accountId, token }: R2Settings) =>
  Effect.map(HttpClient.HttpClient, (client) =>
    R2Api.of({
      get: (bucket, key) =>
        Effect.gen(function* () {
          const response = yield* client.execute(
            HttpClientRequest.bearerToken(
              HttpClientRequest.get(
                `${api}/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`,
              ),
              Redacted.value(token),
            ),
          );
          if (response.status === 200) {
            return Option.some(
              yield* response.text.pipe(
                Effect.mapError((error) => failed("Unavailable", error.message)),
              ),
            );
          }
          const body = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Errors)),
            Effect.orElseSucceed((): typeof Errors.Type => ({})),
          );
          const errors = body.errors ?? [];
          // A missing key is an answer. A missing bucket is not: nothing at any key would say so.
          if (response.status === 404 && errors.some((error) => error.code === noSuchKey)) {
            return Option.none();
          }
          return yield* failed(
            response.status === 429 || response.status >= 500 ? "Unavailable" : "Refused",
            errors.map((error) => `${error.code} ${error.message}`).join("; ") ||
              `HTTP ${response.status}`,
          );
        }).pipe(
          Effect.catchTag("HttpClientError", (error) =>
            Effect.fail(failed("Unavailable", error.message)),
          ),
        ),
    }),
  );
