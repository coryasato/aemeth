import { Effect, Option, Schema } from "effect";
import type { Signature } from "effect/crypto";
import type { Jwks } from "effect/jose";
import { Jwt } from "effect/jose";

/**
 * How the engine knows who sent a request that Access let through (decision 0006, M2 decision 30).
 *
 * - `Verified`: the token Access issued for the request is checked against the keys of the team
 *   that issued it, `https://<team>.cloudflareaccess.com`. Every deployed stage is this.
 * - `Local`: under `alchemy dev` there is no Access and no token; the identity the stack's `dev`
 *   setting gives every request is taken as it is.
 */
export type AccessCheck =
  | { readonly _tag: "Verified"; readonly issuer: string }
  | { readonly _tag: "Local" };

/** What Access says of a request it let through, as the Worker is handed it. */
export type AccessFacts = {
  /** The audience tag of the Access application in front of this Worker. */
  readonly aud: string;
  /** The `Cf-Access-Jwt-Assertion` header: the token Access issued for this request. */
  readonly token: string | undefined;
  /** The email Access's identity lookup gave, which only `Local` reads. */
  readonly email: string | undefined;
};

/** The team's public keys, as Cloudflare publishes them. */
export const certsOf = (issuer: string): string => `${issuer}/cdn-cgi/access/certs`;

/** The setting a stage is deployed with, read: a team domain, or `local` under `alchemy dev`. */
export const accessCheckOf = (setting: string | undefined): Option.Option<AccessCheck> => {
  if (setting === "local") {
    return Option.some({ _tag: "Local" });
  }
  return setting !== undefined && /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u.test(setting)
    ? Option.some({ _tag: "Verified", issuer: setting })
    : Option.none();
};

/** The claims Access puts in a token besides the registered ones. */
const AccessClaims = Schema.Struct({
  common_name: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});

// A token Access issues is about a kilobyte; anything far larger is not one.
const longestToken = 16_384;
// Access and the Worker both run on Cloudflare's clocks; this covers a token issued just now.
const clockTolerance = "10 seconds";

/**
 * Who is calling, as the log will name them (M2, "API"): a person by their email, a service
 * token as `service:<client id>`. `None` is nobody, and the request is refused.
 *
 * With `Verified`, nothing in the token is believed until its RS256 signature is checked against
 * the team's keys (`Jwks`, fetched and cached by the Worker), and its issuer, audience and expiry
 * against what this Worker expects. A token that fails any of them names nobody, whatever
 * `ctx.access` says. A person is named by the `email` claim; a service token, which Access gives
 * no identity to look up, by its client id, the `common_name` claim.
 */
export const callerOf = (
  check: AccessCheck,
  { aud, email, token }: AccessFacts,
): Effect.Effect<Option.Option<string>, never, Jwks.Jwks | Signature.Signature> => {
  if (check._tag === "Local") {
    return Effect.succeed(email !== undefined && email !== "" ? Option.some(email) : Option.none());
  }
  if (token === undefined || token === "" || token.length > longestToken) {
    return Effect.succeedNone;
  }
  return Jwt.verifyWithKeySet(AccessClaims, token, {
    algorithms: ["RS256"],
    issuer: check.issuer,
    audience: aud,
    requiredClaims: ["iss", "aud", "exp"],
    clockTolerance,
  }).pipe(
    Effect.map(({ claims }) => {
      if (claims.email !== undefined && claims.email !== "") {
        return Option.some(claims.email);
      }
      return claims.common_name !== undefined && claims.common_name !== ""
        ? Option.some(`service:${claims.common_name}`)
        : Option.none();
    }),
    Effect.tapError((error) => Effect.logWarning("Access token refused", error.message)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
};
