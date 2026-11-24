import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { DataType, sameType } from "./index";
import { integer, list, resource, struct, text } from "./testing/build";

const type = Schema.decodeUnknownSync(DataType, { onExcessProperty: "error" });

const database = resource("cloudflare.d1.database");

const samples = [
  text,
  integer,
  { _tag: "Boolean" },
  { _tag: "Duration" },
  { _tag: "Timestamp" },
  database,
  resource("cloudflare.d1.export"),
  list(text),
  list(integer),
  list(list(text)),
  struct({}),
  struct({ name: text }),
  struct({ name: integer }),
  struct({ title: text }),
  struct({ name: text, count: integer }),
  struct({ inner: struct({ name: text }) }),
  struct({ inner: struct({ name: integer }) }),
];

describe("sameType", () => {
  it.each(samples.map((sample, index) => ({ index, sample })))(
    "holds for sample $index only against itself",
    ({ index, sample }) => {
      // A fresh decode each time, so equality is by structure and not by reference.
      expect(samples.map((other) => sameType(type(sample), type(other)))).toEqual(
        samples.map((_, otherIndex) => otherIndex === index),
      );
    },
  );

  it("ignores the order of a struct's fields", () => {
    expect(
      sameType(
        type(struct({ name: text, count: integer })),
        type(struct({ count: integer, name: text })),
      ),
    ).toBe(true);
  });

  it("does not take a struct with extra fields for a smaller one, either way round", () => {
    const small = type(struct({ name: text }));
    const large = type(struct({ name: text, count: integer }));
    expect(sameType(small, large)).toBe(false);
    expect(sameType(large, small)).toBe(false);
  });

  it("does not take an inherited property for a field", () => {
    expect(sameType(type(struct({ toString: text })), type(struct({ name: text })))).toBe(false);
  });
});
