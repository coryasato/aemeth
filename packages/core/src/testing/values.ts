import { Schema } from "effect";
import type { DataType } from "../DataType";
import { DataType as DataTypeSchema } from "../DataType";
import { namesOf } from "../ids";
import type { Value } from "../Value";
import type { Json } from "./build";
import { boolean, duration, integer, list, resource, struct, text, timestamp } from "./build";

// A type and a value of it for property tests, each built from a list of numbers: nothing is
// filtered (M1 Part A findings), and the same numbers always give the same type and value.

/** The numbers a type and its value are built from. */
export const ValuePicks = Schema.Array(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9999 })),
).check(Schema.isMinLength(48), Schema.isMaxLength(48));

type Next = (choices: number) => number;

/** Takes the next number of `picks`, modulo the choices on offer, going round when they run out. */
export const picker = (picks: ReadonlyArray<number>): Next => {
  let cursor = 0;
  return (choices) => {
    const pick = picks[cursor % picks.length] ?? 0;
    cursor += 1;
    return pick % choices;
  };
};

const decodeType = Schema.decodeUnknownSync(DataTypeSchema, { onExcessProperty: "error" });
const fieldNames = ["name", "count", "inner", "kind", "id"];

const typeDocument = (next: Next, depth: number): Json => {
  // Past two levels only the six types with nothing inside them, so the type is finite.
  switch (next(depth >= 2 ? 6 : 8)) {
    case 0: {
      return text;
    }
    case 1: {
      return integer;
    }
    case 2: {
      return boolean;
    }
    case 3: {
      return duration;
    }
    case 4: {
      return timestamp;
    }
    case 5: {
      return resource(next(2) === 0 ? "test.database" : "test.bucket");
    }
    case 6: {
      return list(typeDocument(next, depth + 1));
    }
    default: {
      return struct(
        Object.fromEntries(
          fieldNames.slice(0, next(4)).map((name) => [name, typeDocument(next, depth + 1)]),
        ),
      );
    }
  }
};

/** A type, at most three levels deep. */
export const sampleType = (next: Next): DataType => decodeType(typeDocument(next, 0));

const texts = ["", "a", "restore-drill", "6b1f-42"];

/** A value in the written form of the type. */
export const sampleValue = (type: DataType, next: Next): Value => {
  switch (type._tag) {
    case "Text": {
      return texts[next(texts.length)] ?? "";
    }
    case "Integer": {
      return next(2000) - 1000;
    }
    case "Boolean": {
      return next(2) === 0;
    }
    case "Duration": {
      return next(100_000);
    }
    case "Timestamp": {
      return 1_795_000_000_000 + next(10_000);
    }
    case "Resource": {
      return { kind: type.kind, id: `id-${next(100)}` };
    }
    case "List": {
      return Array.from({ length: next(4) }, () => sampleValue(type.item, next));
    }
    case "Struct": {
      return Object.fromEntries(
        namesOf(type.fields).map(([name, field]) => [name, sampleValue(field, next)]),
      );
    }
  }
};

/** What a value of the type is written as: three types are written as a number. */
export const writtenAs = (type: DataType): "string" | "number" | "boolean" | "array" | "object" => {
  switch (type._tag) {
    case "Text": {
      return "string";
    }
    case "Integer":
    case "Duration":
    case "Timestamp": {
      return "number";
    }
    case "Boolean": {
      return "boolean";
    }
    case "List": {
      return "array";
    }
    case "Resource":
    case "Struct": {
      return "object";
    }
  }
};
