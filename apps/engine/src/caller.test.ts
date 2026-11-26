import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Layer, Option, Redacted, Schema } from "effect";
import { SecureRandom, Signature } from "effect/crypto";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Jwk, Jwks, Jwt } from "effect/jose";
import type { AccessCheck } from "./caller";
import { accessCheckOf, callerOf, certsOf } from "./caller";

const issuer = "https://aemeth.cloudflareaccess.com";
const check: AccessCheck = { _tag: "Verified", issuer };
const aud = "4f6d9c0e1a2b";

const crypto = Signature.layerWebCrypto.pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

const Claims = Schema.Record(Schema.String, Schema.Json);
type Claims = typeof Claims.Type;

/** A key pair as Access holds one: RS256, named by `kid`. */
const keyPair = (kid: string) =>
  Effect.gen(function* () {
    const pair = yield* Jwk.generateKeyPair({ algorithm: "RS256", kid });
    const signing = yield* Jwk.importPrivate(pair.privateKey, "RS256");
    return { publicKey: pair.publicKey, signing };
  });

/** Seconds since the epoch on the test clock. */
const now = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000));

/** A token as Access issues it for a service token, with `changes` made to its claims. */
const serviceClaims = (at: number, changes: Claims = {}): Claims => ({
  type: "app",
  aud: [aud],
  iss: issuer,
  common_name: "8f2c.access",
  sub: "",
  iat: at,
  exp: at + 3600,
  ...changes,
});

/** The same claims without one of them. */
const without = (claims: Claims, name: string): Claims =>
  Object.fromEntries(Object.entries(claims).filter(([key]) => key !== name));

const sign = (key: Jwk.PrivateKey, claims: Claims, kid = key.kid) =>
  Effect.map(
    Jwt.sign(Claims, claims, key, kid === undefined ? {} : { kid, typ: "JWT" }),
    Redacted.value,
  );

const facts = (token: string | undefined) => ({ aud, token, email: undefined });

describe("who is calling", () => {
  it.effect("is a service token's client id, from a token signed by the team's key", () =>
    Effect.gen(function* () {
      const key = yield* keyPair("k1");
      const at = yield* now;
      const token = yield* sign(key.signing, serviceClaims(at));
      const caller = yield* callerOf(check, facts(token)).pipe(
        Effect.provide(Jwks.layerLocal({ keys: [key.publicKey] })),
      );
      expect(caller).toEqual(Option.some("service:8f2c.access"));
    }).pipe(Effect.provide(crypto)),
  );

  it.effect("is a person's email, from their token", () =>
    Effect.gen(function* () {
      const key = yield* keyPair("k1");
      const at = yield* now;
      const claims = without(
        serviceClaims(at, { email: "ada@example.com", sub: "7d1", nbf: at }),
        "common_name",
      );
      const token = yield* sign(key.signing, claims);
      const caller = yield* callerOf(check, facts(token)).pipe(
        Effect.provide(Jwks.layerLocal({ keys: [key.publicKey] })),
      );
      expect(caller).toEqual(Option.some("ada@example.com"));
    }).pipe(Effect.provide(crypto)),
  );

  it.effect("is nobody when the token does not verify", () =>
    Effect.gen(function* () {
      const key = yield* keyPair("k1");
      const stranger = yield* keyPair("k1");
      const at = yield* now;
      const good = yield* sign(key.signing, serviceClaims(at));
      const [header, payload] = good.split(".");
      const otherPayload = yield* Schema.encodeEffect(Schema.StringFromBase64Url)(
        JSON.stringify(serviceClaims(at, { common_name: "someone.else" })),
      );
      const refused: ReadonlyArray<readonly [string, string | undefined]> = [
        ["no token", undefined],
        ["an empty token", ""],
        ["not a token", "abc"],
        ["a token far too long", `${good}${"a".repeat(20_000)}`],
        ["signed by another key", yield* sign(stranger.signing, serviceClaims(at))],
        ["its claims changed after signing", `${header}.${otherPayload}.${good.split(".")[2]}`],
        ["no signature", `${header}.${payload}.`],
        [
          "unsigned",
          `${yield* Schema.encodeEffect(Schema.StringFromBase64Url)('{"alg":"none"}')}.${payload}.`,
        ],
        [
          "another issuer",
          yield* sign(key.signing, serviceClaims(at, { iss: "https://evil.cloudflareaccess.com" })),
        ],
        ["no issuer", yield* sign(key.signing, without(serviceClaims(at), "iss"))],
        ["another audience", yield* sign(key.signing, serviceClaims(at, { aud: ["another"] }))],
        ["expired", yield* sign(key.signing, serviceClaims(at, { exp: at - 60 }))],
        ["no expiry", yield* sign(key.signing, without(serviceClaims(at), "exp"))],
        ["not valid yet", yield* sign(key.signing, serviceClaims(at, { nbf: at + 600 }))],
        ["an unknown key id", yield* sign(key.signing, serviceClaims(at), "k2")],
        ["naming nobody", yield* sign(key.signing, serviceClaims(at, { common_name: "" }))],
      ];
      for (const [what, token] of refused) {
        const caller = yield* callerOf(check, facts(token)).pipe(
          Effect.provide(Jwks.layerLocal({ keys: [key.publicKey] })),
        );
        expect([what, caller]).toEqual([what, Option.none()]);
      }
    }).pipe(Effect.provide(crypto)),
  );

  it.effect("is found with a key the team rotated in, by fetching the keys again", () =>
    Effect.gen(function* () {
      const first = yield* keyPair("k1");
      const second = yield* keyPair("k2");
      let published = [first.publicKey];
      let fetches = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          fetches += 1;
          expect(request.url).toBe(certsOf(issuer));
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ keys: published }), { status: 200 }),
          );
        }),
      );
      const keys = Jwks.layerRemote({ url: certsOf(issuer), cooldown: 0 }).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      );
      yield* Effect.gen(function* () {
        const at = yield* now;
        const old = yield* sign(first.signing, serviceClaims(at));
        expect(yield* callerOf(check, facts(old))).toEqual(Option.some("service:8f2c.access"));
        expect(yield* callerOf(check, facts(old))).toEqual(Option.some("service:8f2c.access"));
        expect(fetches).toBe(1);
        published = [first.publicKey, second.publicKey];
        const rotated = yield* sign(second.signing, serviceClaims(at));
        expect(yield* callerOf(check, facts(rotated))).toEqual(Option.some("service:8f2c.access"));
        expect(fetches).toBe(2);
      }).pipe(Effect.provide(keys));
    }).pipe(Effect.provide(crypto)),
  );

  it.effect("under alchemy dev, is the identity the stack gives every request", () =>
    Effect.gen(function* () {
      const local = { _tag: "Local" } as const;
      expect(yield* callerOf(local, { aud: "dev", token: undefined, email: "a@b.c" })).toEqual(
        Option.some("a@b.c"),
      );
      expect(yield* callerOf(local, { aud: "dev", token: undefined, email: undefined })).toEqual(
        Option.none(),
      );
    }).pipe(Effect.provide(Layer.merge(Jwks.layerLocal({ keys: [] }), crypto))),
  );
});

describe("the Access setting a stage is deployed with", () => {
  it("is a team domain or local", () => {
    expect(accessCheckOf(issuer)).toEqual(Option.some(check));
    expect(accessCheckOf("local")).toEqual(Option.some({ _tag: "Local" }));
    for (const setting of [
      undefined,
      "",
      "aemeth.cloudflareaccess.com",
      "http://aemeth.cloudflareaccess.com",
      `${issuer}/`,
      "https://aemeth.example.com",
      "https://a.b.cloudflareaccess.com",
    ]) {
      expect([setting, accessCheckOf(setting)]).toEqual([setting, Option.none()]);
    }
  });
});
