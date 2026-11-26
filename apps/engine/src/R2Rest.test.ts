import { R2Api } from "@aemeth/blocks";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { makeR2Rest } from "./R2Rest";

const accountId = "acc123";
type Answer = { readonly status: number; readonly body: string } | "network";

/** A fake Cloudflare: each request is answered by `answer`, and every URL asked is kept. */
const cloudflare = (answer: Answer) => {
  const seen: Array<{ readonly url: string; readonly auth: string }> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      seen.push({ url: request.url, auth: request.headers["authorization"] ?? "" });
      if (answer === "network") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection reset" }),
        });
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(answer.body, { status: answer.status }),
      );
    }),
  );
  const layer = Layer.effect(R2Api)(makeR2Rest({ accountId, token: Redacted.make("t0k3n") })).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return { seen, layer };
};

const envelope = (code: number, message: string) =>
  JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null });

const get = (answer: Answer) => {
  const fake = cloudflare(answer);
  return Effect.map(
    Effect.exit(
      Effect.flatMap(R2Api, (r2) => r2.get("aemeth-archive", "runs/r1.json")).pipe(
        Effect.provide(fake.layer),
      ),
    ),
    (exit) => ({ exit, seen: fake.seen }),
  );
};

const reasonOf = (exit: Exit.Exit<unknown, { readonly reason: string }>): string =>
  Exit.match(exit, {
    onSuccess: () => "succeeded",
    onFailure: (cause) => {
      const error = cause.reasons.find((reason) => reason._tag === "Fail");
      return error === undefined ? "died" : error.error.reason;
    },
  });

describe("the R2 REST client", () => {
  it.effect("reads an object's text, from the account's bucket, with the engine's token", () =>
    Effect.gen(function* () {
      const { exit, seen } = yield* get({ status: 200, body: '[{"seq":0}]' });
      expect(exit).toEqual(Exit.succeed(Option.some('[{"seq":0}]')));
      expect(seen).toEqual([
        {
          url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/aemeth-archive/objects/runs%2Fr1.json`,
          auth: "Bearer t0k3n",
        },
      ]);
    }),
  );

  it.effect("answers a key the bucket does not hold as nothing there", () =>
    Effect.gen(function* () {
      const { exit } = yield* get({
        status: 404,
        body: envelope(10_007, "The specified key does not exist."),
      });
      expect(exit).toEqual(Exit.succeed(Option.none()));
    }),
  );

  it.effect("refuses a bucket that is not there, which is not an empty answer", () =>
    Effect.gen(function* () {
      const { exit } = yield* get({
        status: 404,
        body: envelope(10_006, "The specified bucket does not exist."),
      });
      expect(reasonOf(exit)).toBe("Refused");
      expect(String(exit)).toContain("10006 The specified bucket");
    }),
  );

  it.effect("is away when Cloudflare is, and refused when the token may not read", () =>
    Effect.gen(function* () {
      expect(reasonOf((yield* get({ status: 503, body: "busy" })).exit)).toBe("Unavailable");
      expect(reasonOf((yield* get({ status: 429, body: envelope(10_058, "slow") })).exit)).toBe(
        "Unavailable",
      );
      expect(reasonOf((yield* get("network")).exit)).toBe("Unavailable");
      expect(
        reasonOf(
          (yield* get({ status: 403, body: envelope(10_000, "Authentication error") })).exit,
        ),
      ).toBe("Refused");
      // A 404 that is not R2's answer says nothing of the key.
      expect(reasonOf((yield* get({ status: 404, body: "not found" })).exit)).toBe("Refused");
    }),
  );
});
