import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { BlockSpec, DataType, Recipe } from "./index";

/**
 * Every Schema survives a trip through JSON text: encode, stringify, parse, decode.
 *
 * A property over a generator can pass without ever producing the interesting shapes
 * (M1 Part A findings), so each test records the tags it saw, and a test after it
 * fails if a required one was never reached.
 */

const strict = { onExcessProperty: "error" } as const;
const runs = { arbitrary: { runs: 300 } };
// The generator gives a Struct at most `size` properties, and `Recipe` has 11 required ones, so
// at the default size its optional `$schema` is never generated. The coverage test caught this.
const recipeRuns = { arbitrary: { runs: 300, size: 16 } };

/** Records `key=value` for every text-valued property in a value, at any depth. */
const record = (seen: Set<string>, value: unknown, key = ""): void => {
  if (typeof value === "string") {
    seen.add(`${key}=${value}`);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      record(seen, item, key);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [name, inner] of Object.entries(value)) {
      record(seen, inner, name);
    }
  }
};

// JSON text has no `-0`: `JSON.stringify(-0)` is `"0"`. A literal `-0` therefore comes back as
// `0`, which is the only change the trip makes, so numbers are compared with `===` here.
expect.addEqualityTesters([
  (a: unknown, b: unknown) =>
    typeof a === "number" && typeof b === "number" ? a === b : undefined,
]);

const roundTrips = <S extends Schema.Codec<unknown, unknown>>(schema: S, seen: Set<string>) => {
  const codec = Schema.toCodecJson(schema);
  const encode = Schema.encodeSync(codec);
  const decode = Schema.decodeUnknownSync(codec, strict);
  return (value: S["Type"]): void => {
    const text = JSON.stringify(encode(value));
    const decoded = decode(JSON.parse(text));
    expect(decoded).toEqual(value);
    expect(JSON.stringify(encode(decoded))).toBe(text);
    record(seen, value);
  };
};

const dataTypeTags = [
  "Text",
  "Integer",
  "Boolean",
  "Duration",
  "Timestamp",
  "Resource",
  "List",
  "Struct",
].map((tag) => `_tag=${tag}`);

describe("DataType", () => {
  const seen = new Set<string>();
  const check = roundTrips(DataType, seen);

  it.prop("round-trips through JSON", [DataType], ([type]) => check(type), runs);

  it("reached every tag", () => {
    expect([...seen]).toEqual(expect.arrayContaining(dataTypeTags));
  });
});

describe("BlockSpec", () => {
  const seen = new Set<string>();
  const check = roundTrips(BlockSpec, seen);

  it.prop("round-trips through JSON", [BlockSpec], ([spec]) => check(spec), runs);

  it("reached every tag", () => {
    expect([...seen]).toEqual(
      expect.arrayContaining([
        ...dataTypeTags,
        "kind=Action",
        "kind=Check",
        "kind=Gate",
        "_tag=Required",
        "_tag=Optional",
        "_tag=Reads",
        "_tag=Writes",
        "_tag=Creates",
        "_tag=Destroys",
        "lifetime=Temporary",
        "lifetime=Expiring",
        "_tag=FromInput",
        "_tag=FromOutput",
        "lifetime=Durable",
        "_tag=Undo",
        "_tag=NoUndo",
        "_tag=NothingToUndo",
        "rerun=SafeWithIdempotencyKey",
      ]),
    );
  });
});

describe("Recipe", () => {
  const seen = new Set<string>();
  const check = roundTrips(Recipe, seen);
  let withForEach = 0;
  let withoutForEach = 0;
  let withSchemaField = 0;
  const literals = new Set<string>();

  it.prop(
    "round-trips through JSON",
    [Recipe],
    ([recipe]) => {
      check(recipe);
      withSchemaField += recipe.$schema === undefined ? 0 : 1;
      for (const step of recipe.nodes) {
        withForEach += step.forEach === undefined ? 0 : 1;
        withoutForEach += step.forEach === undefined ? 1 : 0;
        for (const binding of Object.values(step.inputs)) {
          if (binding._tag === "Literal") {
            literals.add(Array.isArray(binding.value) ? "array" : typeof binding.value);
          }
        }
      }
    },
    recipeRuns,
  );

  it("reached every tag", () => {
    expect([...seen]).toEqual(
      expect.arrayContaining([
        ...dataTypeTags,
        "_tag=Step",
        "_tag=RecipeInput",
        "_tag=StepOutput",
        "_tag=OptionalStepOutput",
        "_tag=ForEachItem",
        "_tag=Literal",
        "onItemFailure=Stop",
        "onItemFailure=Continue",
        "on=Succeeded",
        "on=Failed",
        "on=Approved",
        "on=Denied",
        "_tag=End",
        "result=Succeeded",
        "result=Failed",
        "undo=Run",
        "undo=Skip",
        "rule=NeverWritten",
        "rule=CleanedUp",
        "rule=RequiredForSuccess",
        "rule=NoWriteBeforeApproval",
        "rule=AfterFailure",
        "rule=DestroysOnlyApproved",
        "rule=OnlyAfter",
      ]),
    );
  });

  it("reached steps with and without a for-each, and every kind of literal", () => {
    expect(withForEach).toBeGreaterThan(0);
    expect(withoutForEach).toBeGreaterThan(0);
    expect(withSchemaField).toBeGreaterThan(0);
    expect([...literals].toSorted()).toEqual(["array", "boolean", "number", "object", "string"]);
  });
});
