import type { BlockSpec, DataType } from "@aemeth/core";

/** A block declaration as it is written: plain data, decoded by `BlockSpec` before use. */
export type Declaration = typeof BlockSpec.Encoded;
type Type = typeof DataType.Encoded;

export const text: Type = { _tag: "Text" };
export const integer: Type = { _tag: "Integer" };
export const duration: Type = { _tag: "Duration" };
export const resource = (kind: string): Type => ({ _tag: "Resource", kind });
export const list = (item: Type): Type => ({ _tag: "List", item });

export const required = (type: Type) => ({ _tag: "Required", type }) as const;
export const optional = (type: Type) => ({ _tag: "Optional", type }) as const;

export const reads = (input: string) => ({ _tag: "Reads", input }) as const;
export const writes = (input: string) => ({ _tag: "Writes", input }) as const;
export const destroys = (input: string) => ({ _tag: "Destroys", input }) as const;
export const creates = (output: string, lifetime: "Temporary" | "Durable") =>
  ({ _tag: "Creates", output, lifetime }) as const;

export const undoWith = (block: string, version: number) =>
  ({ _tag: "Undo", block, version }) as const;
export const noUndo = (reason: string) => ({ _tag: "NoUndo", reason }) as const;
export const nothingToUndo = { _tag: "NothingToUndo" } as const;

/** The one re-run policy a block can declare (M1 decision 9). */
export const rerun = "SafeWithIdempotencyKey";
