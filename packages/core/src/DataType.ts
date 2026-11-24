import { Schema } from "effect";
import { Name, ResourceKind } from "./ids";

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
