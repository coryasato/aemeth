import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { callerOf } from "./caller";

const encode = Schema.encodeSync(Schema.StringFromBase64Url);
const aud = "4f6d9c0e1a2b";

/** A token as Access issues it, with these claims. Nothing here reads the signature. */
const tokenOf = (claims: unknown): string =>
  [encode('{"alg":"RS256"}'), encode(JSON.stringify(claims)), "signature"].join(".");

describe("who is calling", () => {
  it("is a person's email", () => {
    expect(callerOf({ aud, email: "ada@example.com", token: undefined })).toEqual(
      Option.some("ada@example.com"),
    );
  });

  it("is a service token's client id, read from the token Access issued", () => {
    const token = tokenOf({ aud: [aud], common_name: "8f2c.access", sub: "", type: "app" });
    expect(callerOf({ aud, email: undefined, token })).toEqual(Option.some("service:8f2c.access"));
    expect(callerOf({ aud, email: "", token })).toEqual(Option.some("service:8f2c.access"));
    // The audience may also be written as one string.
    expect(
      callerOf({ aud, email: undefined, token: tokenOf({ aud, common_name: "8f2c.access" }) }),
    ).toEqual(Option.some("service:8f2c.access"));
  });

  it("is a person's email from their token, when Access could not look them up", () => {
    const token = tokenOf({ aud: [aud], email: "ada@example.com", sub: "7d1" });
    expect(callerOf({ aud, email: undefined, token })).toEqual(Option.some("ada@example.com"));
    const elsewhere = tokenOf({ aud: ["another"], email: "ada@example.com" });
    expect(callerOf({ aud, email: undefined, token: elsewhere })).toEqual(Option.none());
  });

  it("is nobody when the token was issued for another application", () => {
    const token = tokenOf({ aud: ["another"], common_name: "8f2c.access" });
    expect(callerOf({ aud, email: undefined, token })).toEqual(Option.none());
  });

  it("is nobody when the token names no client", () => {
    for (const claims of [{ aud: [aud] }, { aud: [aud], common_name: "" }, { common_name: "x" }]) {
      expect(callerOf({ aud, email: undefined, token: tokenOf(claims) })).toEqual(Option.none());
    }
  });

  it("is nobody when there is no token, or it is not one", () => {
    const good = tokenOf({ aud: [aud], common_name: "8f2c.access" });
    const tokens = [
      undefined,
      "",
      "abc",
      "a.b",
      `${good}.more`,
      `x.${encode("not json")}.y`,
      "x.!!!.y",
    ];
    for (const token of tokens) {
      expect([token, callerOf({ aud, email: undefined, token })]).toEqual([token, Option.none()]);
    }
  });
});
