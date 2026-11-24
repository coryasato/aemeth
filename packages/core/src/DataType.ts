import { Schema } from "effect";
import { Name, namesOf, own, ResourceKind } from "./ids";

/**
 * The type of a value that moves between a recipe's inputs, its steps and their blocks.
 * Closed and recursive. A `Resource` is a reference to something outside Aemeth.
 * Two types fit when they are structurally equal; there is no subtyping (M1 decision 8).
 */
export type DataType =
  | { readonly _tag: "Text" }
  | { readonly _tag: "Integer" }
  | { readonly _tag: "Boolean" }
  | { readonly _tag: "Duration" }
  | { readonly _tag: "Timestamp" }
  | { readonly _tag: "Resource"; readonly kind: ResourceKind }
  | { readonly _tag: "List"; readonly item: DataType }
  | { readonly _tag: "Struct"; readonly fields: { readonly [name: Name]: DataType } };

type DataTypeEncoded =
  | { readonly _tag: "Text" }
  | { readonly _tag: "Integer" }
  | { readonly _tag: "Boolean" }
  | { readonly _tag: "Duration" }
  | { readonly _tag: "Timestamp" }
  | { readonly _tag: "Resource"; readonly kind: string }
  | { readonly _tag: "List"; readonly item: DataTypeEncoded }
  | { readonly _tag: "Struct"; readonly fields: { readonly [name: string]: DataTypeEncoded } };

const self = Schema.suspend((): Schema.Codec<DataType, DataTypeEncoded> => DataType);

export const DataType = Schema.TaggedUnion({
  Text: {},
  Integer: {},
  Boolean: {},
  Duration: {},
  Timestamp: {},
  Resource: { kind: ResourceKind },
  List: { item: self },
  Struct: { fields: Schema.Record(Name, self) },
}).annotate({ identifier: "DataType" });

/** Whether two types are structurally equal. There is no subtyping (M1 decision 8). */
export const sameType = (a: DataType, b: DataType): boolean => {
  switch (a._tag) {
    case "Text":
    case "Integer":
    case "Boolean":
    case "Duration":
    case "Timestamp": {
      return b._tag === a._tag;
    }
    case "Resource": {
      return b._tag === "Resource" && b.kind === a.kind;
    }
    case "List": {
      return b._tag === "List" && sameType(a.item, b.item);
    }
    case "Struct": {
      if (b._tag !== "Struct") {
        return false;
      }
      const fields = namesOf(a.fields);
      return (
        fields.length === Object.keys(b.fields).length &&
        fields.every(([name, type]) => {
          const other = own(b.fields, name);
          return other !== undefined && sameType(type, other);
        })
      );
    }
  }
};
