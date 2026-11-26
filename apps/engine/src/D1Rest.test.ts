import { D1Api } from "@aemeth/blocks";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Option, Redacted } from "effect";
import { Digest } from "effect/crypto";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { makeD1Rest } from "./D1Rest";

const accountId = "acc123";
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`;

type Seen = {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly auth: string;
};
type Answer = { readonly status: number; readonly body: unknown } | "network";

/** Cloudflare's envelope around a result, or around errors. */
const ok = (result: unknown): Answer => ({
  status: 200,
  body: { success: true, errors: [], result },
});
const error = (status: number, code: number, message = "no"): Answer => ({
  status,
  body: { success: false, errors: [{ code, message }], result: null },
});

/** A fake Cloudflare: each request is answered by `answer`, and every request is kept. */
const cloudflare = (answer: (seen: Seen) => Answer) => {
  const seen: Array<Seen> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const body =
        request.body._tag === "Uint8Array"
          ? {
              text: new TextDecoder().decode(request.body.body),
              json: request.body.contentType === "application/json",
            }
          : undefined;
      const one: Seen = {
        method: request.method,
        url:
          request.url +
          (request.urlParams.params.length > 0
            ? `?${new URLSearchParams(request.urlParams.params.map(([key, value]) => [key, String(value)])).toString()}`
            : ""),
        body: body === undefined ? undefined : body.json ? JSON.parse(body.text) : body.text,
        auth: request.headers["authorization"] ?? "",
      };
      seen.push(one);
      const answered = answer(one);
      if (answered === "network") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection reset" }),
        });
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          typeof answered.body === "string" ? answered.body : JSON.stringify(answered.body),
          {
            status: answered.status,
          },
        ),
      );
    }),
  );
  const layer = Layer.effect(D1Api)(makeD1Rest({ accountId, token: Redacted.make("t0k3n") })).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(Digest.layerWebCrypto),
  );
  return { seen, layer };
};

/** Runs an effect that waits on the clock, moving the test clock on until it is done. */
const withTime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.exit(effect));
    yield* TestClock.adjust("15 minutes");
    return yield* Fiber.join(fiber);
  });

const reasonOf = (exit: Exit.Exit<unknown, { readonly reason: string }>) =>
  Exit.match(exit, {
    onSuccess: () => "succeeded",
    onFailure: (cause) =>
      cause.reasons.find((reason) => reason._tag === "Fail")?.error.reason ?? "died",
  });

describe("the D1 API over REST", () => {
  it.effect("queries with the engine's token, and returns the rows", () =>
    Effect.gen(function* () {
      const { seen, layer } = cloudflare(() =>
        ok([{ results: [{ r: "1" }, { r: "2" }], success: true }]),
      );
      const rows = yield* Effect.flatMap(D1Api, (api) => api.query("db1", "SELECT ?", [7])).pipe(
        Effect.provide(layer),
      );
      expect(rows).toEqual([{ r: "1" }, { r: "2" }]);
      expect(seen).toEqual([
        {
          method: "POST",
          url: `${base}/db1/query`,
          body: { sql: "SELECT ?", params: [7] },
          auth: "Bearer t0k3n",
        },
      ]);
    }),
  );

  it.effect("says why a call failed, in the terms a block acts on", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [Answer, string]> = [
        [error(400, 7502), "AlreadyExists"],
        [error(404, 7404), "NotFound"],
        [error(400, 7404), "NotFound"],
        [error(429, 971), "Unavailable"],
        [error(503, 7500), "Unavailable"],
        [{ status: 502, body: "<html>bad gateway</html>" }, "Unavailable"],
        [{ status: 403, body: "<html>no</html>" }, "Refused"],
        [error(403, 10_000, "Authentication error"), "Refused"],
        [{ status: 200, body: { success: true, result: { unexpected: true } } }, "Refused"],
        ["network", "Unavailable"],
      ];
      for (const [answer, reason] of cases) {
        const { layer } = cloudflare(() => answer);
        const exit = yield* Effect.exit(
          Effect.flatMap(D1Api, (api) => api.create("x")).pipe(Effect.provide(layer)),
        );
        expect([answer, reasonOf(exit)]).toEqual([answer, reason]);
      }
    }),
  );

  it.effect(
    "creates, finds by the whole name, gets and deletes, and a database gone is no error",
    () =>
      Effect.gen(function* () {
        const { seen, layer } = cloudflare(({ method, url }) => {
          if (method === "POST") {
            return ok({ uuid: "u1", name: "drill-r1", version: "production" });
          }
          if (url.includes("?")) {
            return ok([
              { uuid: "u2", name: "drill-r1-x" },
              { uuid: "u1", name: "drill-r1" },
            ]);
          }
          if (url.endsWith("/gone")) {
            return error(404, 7404);
          }
          if (method === "GET") {
            return ok({ uuid: "u1", name: "drill-r1", num_tables: 2 });
          }
          return ok(null);
        });
        yield* Effect.gen(function* () {
          const api = yield* D1Api;
          expect(yield* api.create("drill-r1")).toEqual({ id: "u1", name: "drill-r1" });
          expect(yield* api.findByName("drill-r1")).toEqual(
            Option.some({ id: "u1", name: "drill-r1" }),
          );
          expect(yield* api.findByName("drill")).toEqual(Option.none());
          expect(yield* api.get("u1")).toEqual(Option.some({ id: "u1", name: "drill-r1" }));
          expect(yield* api.get("gone")).toEqual(Option.none());
          yield* api.delete("u1");
          yield* api.delete("gone");
        }).pipe(Effect.provide(layer));
        expect(seen.map((each) => `${each.method} ${each.url.replace(base, "")}`)).toEqual([
          "POST ",
          "GET ?name=drill-r1&per_page=100",
          "GET ?name=drill&per_page=100",
          "GET /u1",
          "GET /gone",
          "DELETE /u1",
          "DELETE /gone",
        ]);
      }),
  );

  it.effect("exports, asking again with the bookmark until the link is ready", () =>
    Effect.gen(function* () {
      let asked = 0;
      const { seen, layer } = cloudflare(() => {
        asked += 1;
        return asked < 3
          ? ok({ at_bookmark: `b${asked}`, status: "active", success: true, type: "export" })
          : ok({
              at_bookmark: "b3",
              status: "complete",
              result: { filename: "f.sql", signed_url: "https://r2/f.sql" },
            });
      });
      const exit = yield* withTime(
        Effect.flatMap(D1Api, (api) => api.exportDatabase("db1")).pipe(Effect.provide(layer)),
      );
      expect(exit).toEqual(Exit.succeed({ url: "https://r2/f.sql" }));
      expect(seen.map((each) => each.body)).toEqual([
        { output_format: "polling" },
        { output_format: "polling", current_bookmark: "b1" },
        { output_format: "polling", current_bookmark: "b2" },
      ]);
    }),
  );

  it.effect("does not start an export over when Cloudflare gives no bookmark to ask after", () =>
    Effect.gen(function* () {
      const { seen, layer } = cloudflare(() => ok({ status: "active", at_bookmark: null }));
      const exit = yield* withTime(
        Effect.flatMap(D1Api, (api) => api.exportDatabase("db1")).pipe(Effect.provide(layer)),
      );
      expect(reasonOf(exit)).toBe("Failed");
      expect(seen).toHaveLength(1);
    }),
  );

  it.effect("keeps a database id inside its own path", () =>
    Effect.gen(function* () {
      const { seen, layer } = cloudflare(() => ok([{ results: [] }]));
      yield* Effect.flatMap(D1Api, (api) => api.query("x/../other?y#z", "SELECT 1")).pipe(
        Effect.provide(layer),
      );
      expect(seen[0]?.url).toBe(`${base}/x%2F..%2Fother%3Fy%23z/query`);
    }),
  );

  it.effect("fails an export Cloudflare reports as failed, or that never finishes", () =>
    Effect.gen(function* () {
      const broken = cloudflare(() => ok({ status: "error", error: "too big" }));
      const failed = yield* withTime(
        Effect.flatMap(D1Api, (api) => api.exportDatabase("db1")).pipe(
          Effect.provide(broken.layer),
        ),
      );
      expect(reasonOf(failed)).toBe("Failed");
      const slow = cloudflare(() => ok({ status: "active", at_bookmark: "b" }));
      const never = yield* withTime(
        Effect.flatMap(D1Api, (api) => api.exportDatabase("db1")).pipe(Effect.provide(slow.layer)),
      );
      expect(reasonOf(never)).toBe("Unavailable");
    }),
  );

  it.effect("imports: downloads, uploads under the file's MD5, ingests and waits", () =>
    Effect.gen(function* () {
      const dump = "CREATE TABLE t (a);\nINSERT INTO t VALUES(1);";
      let polls = 0;
      const { seen, layer } = cloudflare(({ method, url, body }) => {
        if (url === "https://r2/f.sql") {
          return { status: 200, body: dump };
        }
        if (method === "PUT") {
          return { status: 200, body: "" };
        }
        const action =
          typeof body === "object" && body !== null && "action" in body ? body.action : undefined;
        if (action === "init") {
          return ok({ upload_url: "https://upload/u", filename: "f-up.sql" });
        }
        if (action === "ingest") {
          return ok({ at_bookmark: "b1", status: "active" });
        }
        polls += 1;
        return ok({ at_bookmark: "b2", status: polls < 2 ? "active" : "complete" });
      });
      const exit = yield* withTime(
        Effect.flatMap(D1Api, (api) => api.importExport("db2", "https://r2/f.sql")).pipe(
          Effect.provide(layer),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      const etag = yield* Effect.flatMap(Digest.Digest, (digest) =>
        digest.digestHex(Digest.md5, new TextEncoder().encode(dump)),
      ).pipe(Effect.provide(Digest.layerWebCrypto));
      expect(seen.map((each) => [each.method, each.url.replace(base, ""), each.body])).toEqual([
        ["GET", "https://r2/f.sql", undefined],
        ["POST", "/db2/import", { action: "init", etag }],
        ["PUT", "https://upload/u", dump],
        ["POST", "/db2/import", { action: "ingest", etag, filename: "f-up.sql" }],
        ["POST", "/db2/import", { action: "poll", current_bookmark: "b1" }],
        ["POST", "/db2/import", { action: "poll", current_bookmark: "b2" }],
      ]);
      // The download is not sent the engine's token.
      expect(seen[0]?.auth).toBe("");
    }),
  );

  it.effect("imports a file Cloudflare already has without uploading it again", () =>
    Effect.gen(function* () {
      const { seen, layer } = cloudflare(({ url }) =>
        url === "https://r2/f.sql" ? { status: 200, body: "x" } : ok({ status: "complete" }),
      );
      const exit = yield* withTime(
        Effect.flatMap(D1Api, (api) => api.importExport("db2", "https://r2/f.sql")).pipe(
          Effect.provide(layer),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(seen.map((each) => each.method)).toEqual(["GET", "POST"]);
    }),
  );

  it.effect("fails an import whose link has expired, for good", () =>
    Effect.gen(function* () {
      for (const [status, reason] of [
        [403, "ExportExpired"],
        [404, "ExportExpired"],
        [503, "Unavailable"],
      ] as const) {
        const { seen, layer } = cloudflare(() => ({ status, body: "<Error/>" }));
        const exit = yield* withTime(
          Effect.flatMap(D1Api, (api) => api.importExport("db2", "https://r2/f.sql")).pipe(
            Effect.provide(layer),
          ),
        );
        expect([status, reasonOf(exit)]).toEqual([status, reason]);
        expect(seen).toHaveLength(1);
      }
    }),
  );
});
