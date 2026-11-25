import { Option, Schema } from "effect";

/** What Access says of a request it let through, as the Worker is handed it. */
export type AccessFacts = {
  /** The audience tag of the Access application in front of this Worker. */
  readonly aud: string;
  /** The email of the person who signed in. A service token has none. */
  readonly email: string | undefined;
  /** The `Cf-Access-Jwt-Assertion` header: the token Access issued for this request. */
  readonly token: string | undefined;
};

const Claims = Schema.Struct({
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  common_name: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});
const decodeText = Schema.decodeUnknownOption(Schema.StringFromBase64Url);
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims));

/**
 * Who is calling, as the log will name them (M2, "API"): a person by their email, a service
 * token as `service:<client id>`.
 *
 * Access has no identity to look up for a service token, so its client id is read from the token
 * Access issued, where it is the `common_name` claim. The same token names a person by `email`,
 * which is what is used when the lookup of their identity fails for a moment. The token's signature is not checked here:
 * Cloudflare checked it before it handed the Worker `ctx.access`, without which this is never
 * asked. The audience is still compared, so a token issued for another application names nobody.
 */
export const callerOf = ({ aud, email, token }: AccessFacts): Option.Option<string> => {
  if (email !== undefined && email !== "") {
    return Option.some(email);
  }
  const [, payload, signature, ...rest] = (token ?? "").split(".");
  if (payload === undefined || signature === undefined || rest.length > 0) {
    return Option.none();
  }
  return Option.flatMap(Option.flatMap(decodeText(payload), decodeClaims), (claims) => {
    const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
    if (!audiences.includes(aud)) {
      return Option.none();
    }
    // A person whose identity Access could not look up just now is still named in their token.
    if (claims.email !== undefined && claims.email !== "") {
      return Option.some(claims.email);
    }
    return claims.common_name !== undefined && claims.common_name !== ""
      ? Option.some(`service:${claims.common_name}`)
      : Option.none();
  });
};
