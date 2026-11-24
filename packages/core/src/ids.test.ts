import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { BlockId, Name, Prose, RecipeId, ResourceKind, StepId, Version } from "./index";

const accepts = (schema: Schema.Codec<unknown, unknown>, value: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(value));

const camelCase = {
  good: ["a", "export", "createTemp", "shift10", "a".repeat(64)],
  bad: ["", "A", "Export", "1a", "a b", "a-b", "a.b", "a_b", "aé", " a", "a ", "a".repeat(65), 1],
};
const dotted = {
  good: ["a.b", "d1.exportDatabase", "cloudflare.d1.database", "a1.bC2.d", `a.${"b".repeat(62)}`],
  bad: [
    "",
    "a",
    "exportDatabase",
    "a.",
    ".a",
    "a..b",
    "a.B",
    "A.b",
    "a.1",
    "1.a",
    "a b.c",
    "a.b c",
    "a.b!",
    "a-b.c",
    "a.b.",
    `a.${"b".repeat(63)}`,
    1,
  ],
};
const kebabCase = {
  good: ["a", "a1", "restore-drill", "a-1-b", "a".repeat(64)],
  bad: ["", "-a", "a-", "a--b", "A", "a-B", "a_b", "1a", "a b", "a.b", "aB", "a".repeat(65), 1],
};

describe.each([
  { name: "StepId", schema: StepId, cases: camelCase },
  { name: "Name", schema: Name, cases: camelCase },
  { name: "BlockId", schema: BlockId, cases: dotted },
  { name: "ResourceKind", schema: ResourceKind, cases: dotted },
  { name: "RecipeId", schema: RecipeId, cases: kebabCase },
])("$name", ({ schema, cases }) => {
  it.each(cases.good)("accepts %j", (value) => {
    expect(accepts(schema, value)).toBe(true);
  });
  it.each(cases.bad)("rejects %j", (value) => {
    expect(accepts(schema, value)).toBe(false);
  });
});

describe("Version", () => {
  it.each([1, 2, 1_000_000])("accepts %j", (value) => {
    expect(accepts(Version, value)).toBe(true);
  });
  it.each([0, -1, 1.5, 1_000_001, "1", Number.NaN])("rejects %j", (value) => {
    expect(accepts(Version, value)).toBe(false);
  });
});

describe("Prose", () => {
  it.each(["a", "Restore drill", " a ", "x".repeat(2000)])("accepts %j", (value) => {
    expect(accepts(Prose, value)).toBe(true);
  });
  it.each(["", " ", " \n\t ", "x".repeat(2001), 1])("rejects %j", (value) => {
    expect(accepts(Prose, value)).toBe(false);
  });
});
