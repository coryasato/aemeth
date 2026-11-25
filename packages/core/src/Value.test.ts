import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import type { Recipe } from "./index";
import { DataType, inputProblems, ItemIndex, maxListLength, Value, valueFits } from "./index";
import type { Json } from "./testing/build";
import {
  boolean,
  duration,
  integer,
  list,
  recipe,
  resource,
  struct,
  text,
  timestamp,
} from "./testing/build";
import { picker, sampleType, sampleValue, ValuePicks, writtenAs } from "./testing/values";

const type = Schema.decodeUnknownSync(DataType, { onExcessProperty: "error" });
const database = resource("cloudflare.d1.database");
const fits = (of: Json, json: Schema.Json): boolean => valueFits(type(of), json);

describe("valueFits", () => {
  it.each<[string, Json, ReadonlyArray<Schema.Json>, ReadonlyArray<Schema.Json>]>([
    ["Text", text, ["", "a"], [1, true, null, ["a"], { a: "a" }]],
    [
      "Integer",
      integer,
      [0, -3, 12, Number.MAX_SAFE_INTEGER],
      [1.5, "1", true, null, [1], {}, Number.MAX_SAFE_INTEGER + 1],
    ],
    ["Boolean", boolean, [true, false], [0, 1, "true", null, [], {}]],
    [
      "Duration",
      duration,
      [0, 1, 300_000, Number.MAX_SAFE_INTEGER],
      [-1, 0.5, "5s", null, [5], { ms: 5 }],
    ],
    [
      "Timestamp",
      timestamp,
      [0, 1_795_000_000_000, 8_640_000_000_000_000],
      [-1, 0.5, 8_640_000_000_000_001, "2026-11-24", null, [0], {}],
    ],
    [
      "Resource",
      database,
      [{ kind: "cloudflare.d1.database", id: "6b1f" }],
      [
        "6b1f",
        null,
        [],
        {},
        { kind: "cloudflare.d1.database" },
        { id: "6b1f" },
        { kind: "cloudflare.d1.export", id: "6b1f" },
        { kind: "cloudflare.d1.database", id: "" },
        { kind: "cloudflare.d1.database", id: 7 },
        { kind: "cloudflare.d1.database", id: "6b1f", name: "x" },
        { kind: "cloudflare.d1.database", name: "x" },
        ["cloudflare.d1.database", "6b1f"],
      ],
    ],
    [
      "List",
      list(integer),
      [[], [1], [1, 2, 3]],
      [1, "1", null, {}, [1, "2"], [[1]], { 0: 1, length: 1 }],
    ],
    [
      "Struct",
      struct({ name: text, count: integer }),
      [
        { name: "a", count: 1 },
        { count: 1, name: "a" },
      ],
      [
        "a",
        null,
        [],
        ["a", 1],
        {},
        { name: "a" },
        { name: "a", count: "1" },
        { name: "a", count: 1, extra: true },
        { name: "a", toString: 1 },
      ],
    ],
  ])("takes the written form of %s and nothing else", (_, of, good, bad) => {
    expect(good.map((json) => fits(of, json))).toEqual(good.map(() => true));
    expect(bad.map((json) => fits(of, json))).toEqual(bad.map(() => false));
  });

  it("looks inside lists and structs", () => {
    const nested = struct({ items: list(struct({ target: database })) });
    const target = { kind: "cloudflare.d1.database", id: "6b1f" };
    expect(fits(nested, { items: [{ target }, { target }] })).toBe(true);
    expect(fits(nested, { items: [{ target }, { target: { ...target, id: "" } }] })).toBe(false);
    expect(fits(struct({}), {})).toBe(true);
    expect(fits(struct({}), { a: 1 })).toBe(false);
  });

  it("does not take an inherited property for a field", () => {
    expect(fits(struct({ toString: text }), {})).toBe(false);
  });

  it("takes a list of as many items as a for-each can number, and no more", () => {
    // An item's index is at most 1,000,000, so the longest list a for-each can run over has
    // one more item than that.
    expect(Schema.is(ItemIndex)(maxListLength - 1)).toBe(true);
    expect(Schema.is(ItemIndex)(maxListLength)).toBe(false);
    // Lists of that length with nothing in them yet: `every` passes over the gaps, so the check
    // of the length is tested without a million checks of an item.
    expect(fits(list(boolean), Array.from<boolean>({ length: 0 }))).toBe(true);
    expect(fits(list(boolean), new Array<boolean>(maxListLength))).toBe(true);
    expect(fits(list(boolean), new Array<boolean>(maxListLength + 1))).toBe(false);
  });

  const seen = { fitted: new Set<string>(), refused: new Set<string>() };

  it.prop(
    "takes a generated value of a generated type",
    [ValuePicks],
    ([picks]) => {
      const next = picker(picks);
      const generated = sampleType(next);
      const value = sampleValue(generated, next);
      expect(valueFits(generated, value), JSON.stringify([generated, value])).toBe(true);
      // The written form survives a trip through JSON text, and it is a `Value`.
      const written = JSON.stringify(value);
      const read: unknown = JSON.parse(written);
      expect(read).toEqual(value);
      expect(Result.isSuccess(Schema.decodeResult(Value)(value))).toBe(true);
      seen.fitted.add(generated._tag);
    },
    { arbitrary: { runs: 500 } },
  );

  it.prop(
    "refuses a value whose written form is of another kind",
    [ValuePicks, ValuePicks],
    ([picks, otherPicks]) => {
      const generated = sampleType(picker(picks));
      const nextOther = picker(otherPicks);
      const other = sampleType(nextOther);
      const value = sampleValue(other, nextOther);
      if (writtenAs(generated) !== writtenAs(other)) {
        expect(valueFits(generated, value), JSON.stringify([generated, value])).toBe(false);
        seen.refused.add(`${writtenAs(other)} for ${writtenAs(generated)}`);
      }
    },
    { arbitrary: { runs: 1000 } },
  );

  it("reached every type, and every pair of different written forms", () => {
    expect([...seen.fitted].toSorted()).toEqual(Object.keys(DataType.cases).toSorted());
    const forms = ["string", "number", "boolean", "array", "object"];
    expect([...seen.refused].toSorted()).toEqual(
      forms
        .flatMap((given) =>
          forms.flatMap((wanted) => (wanted === given ? [] : [`${given} for ${wanted}`])),
        )
        .toSorted(),
    );
  });
});

describe("Value", () => {
  const accepts = (json: unknown): boolean =>
    Result.isSuccess(Schema.decodeUnknownResult(Value)(json));

  it("is text, whole numbers, booleans, and lists and objects of those", () => {
    expect(
      ["a", 3, -3, true, [], [1, "a", [false]], {}, { kind: "k", id: "i", n: [1] }].map(accepts),
    ).toEqual([true, true, true, true, true, true, true, true]);
    expect([1.5, null, undefined, [null], { a: 0.5 }, Number.NaN].map(accepts)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("inputProblems", () => {
  const drill: Recipe = recipe({
    inputs: { production: { type: database }, keep: { type: duration } },
  });
  const production = { kind: "cloudflare.d1.database", id: "6b1f" };

  it("finds nothing wrong with a value of the right type for every input", () => {
    expect(inputProblems(drill, { production, keep: 60_000 })).toEqual([]);
    expect(inputProblems(recipe({}), {})).toEqual([]);
  });

  it("reports every input that is missing, does not fit or is not an input", () => {
    expect(inputProblems(drill, { production: "6b1f", extra: 1, toString: 2 })).toEqual([
      { _tag: "InputDoesNotFit", name: "production", expected: type(database) },
      { _tag: "InputMissing", name: "keep" },
      { _tag: "InputUnknown", name: "extra" },
      { _tag: "InputUnknown", name: "toString" },
    ]);
  });

  it("does not take an inherited property for an input that was given", () => {
    expect(inputProblems(recipe({ inputs: { toString: { type: text } } }), {})).toEqual([
      { _tag: "InputMissing", name: "toString" },
    ]);
  });
});
