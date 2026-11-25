import { Schema } from "effect";
import type { DataType } from "./DataType";
import { namesOf, own } from "./ids";

/**
 * The written form of a value: what a run's inputs and a step's outputs hold, as JSON.
 *
 * `Text` is a string, `Integer` a whole number, `Boolean` a boolean, `Duration` and `Timestamp`
 * whole milliseconds, `List` an array, `Struct` an object with exactly its fields, and `Resource`
 * `{ kind, id }`, where `id` is the provider's own identifier or, for a resource that is itself a
 * secret, the name of a secret the engine holds for the run (M2 decision 16).
 */
export type Value =
  | string
  | number
  | boolean
  | ReadonlyArray<Value>
  | { readonly [field: string]: Value };

const value = Schema.suspend((): Schema.Codec<Value> => Value);

export const Value = Schema.Union([
  Schema.String,
  Schema.Int,
  Schema.Boolean,
  Schema.Array(value),
  Schema.Record(Schema.String, value),
]).annotate({ identifier: "Value" });

/**
 * The most items a `List` value holds: as many as a for-each can number, since an item's index
 * is at most 1,000,000 (`ItemIndex`). A longer list is not a value.
 */
export const maxListLength = 1_000_001;

/** The latest time a `Timestamp` can name: what a JavaScript `Date` can hold. */
const maxTimestamp = 8_640_000_000_000_000;

// `Array.isArray` does not narrow a readonly array out of a union.
const isList = (json: Schema.Json): json is ReadonlyArray<Schema.Json> => Array.isArray(json);

const isRecord = (json: Schema.Json): json is Schema.JsonObject =>
  typeof json === "object" && json !== null && !isList(json);

const isWhole = (json: Schema.Json): json is number => Number.isSafeInteger(json);

/**
 * Whether a JSON value is the written form of a value of this type. `Integer`, `Duration` and
 * `Timestamp` share a written form, so a value alone does not say which of them it is; a
 * `Duration` is not negative, a `Timestamp` is a time a `Date` can hold, and a `List` has no more
 * items than a for-each can run over.
 */
export const valueFits = (type: DataType, json: Schema.Json): boolean => {
  switch (type._tag) {
    case "Text": {
      return typeof json === "string";
    }
    case "Integer": {
      return isWhole(json);
    }
    case "Boolean": {
      return typeof json === "boolean";
    }
    case "Duration": {
      return isWhole(json) && json >= 0;
    }
    case "Timestamp": {
      return isWhole(json) && json >= 0 && json <= maxTimestamp;
    }
    case "Resource": {
      return (
        isRecord(json) &&
        Object.keys(json).length === 2 &&
        own(json, "kind") === type.kind &&
        typeof own(json, "id") === "string" &&
        own(json, "id") !== ""
      );
    }
    case "List": {
      return (
        isList(json) &&
        json.length <= maxListLength &&
        json.every((item) => valueFits(type.item, item))
      );
    }
    case "Struct": {
      if (!isRecord(json)) {
        return false;
      }
      const fields = namesOf(type.fields);
      return (
        fields.length === Object.keys(json).length &&
        fields.every(([name, fieldType]) => {
          const field = own(json, name);
          return field !== undefined && valueFits(fieldType, field);
        })
      );
    }
  }
};
