import { Schema } from "effect";
import { BlockSpec } from "../BlockSpec";
import { Recipe } from "../Recipe";
import type { Path } from "../validate/index";

// Small builders for the validator's tests: a block or a recipe is written as the parts that
// matter to the test, and decoded by the real Schemas so a test cannot use a shape that a
// document could not have.

const strict = { onExcessProperty: "error" } as const;
const decodeBlock = Schema.decodeUnknownSync(BlockSpec, strict);
const decodeRecipe = Schema.decodeUnknownSync(Recipe, strict);

/** Anything a document can hold. */
export type Json =
  | string
  | number
  | boolean
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };
/** The fields of a document, or of part of one. */
export type Parts = { readonly [key: string]: Json };

export const text = { _tag: "Text" };
export const integer = { _tag: "Integer" };
export const boolean = { _tag: "Boolean" };
export const duration = { _tag: "Duration" };
export const timestamp = { _tag: "Timestamp" };
export const resource = (kind: string) => ({ _tag: "Resource", kind });
export const list = (item: Json) => ({ _tag: "List", item });
export const struct = (fields: Parts) => ({ _tag: "Struct", fields });
export const database = resource("test.database");

export const required = (type: Json) => ({ _tag: "Required", type });
export const optional = (type: Json) => ({ _tag: "Optional", type });

export const reads = (input: string) => ({ _tag: "Reads", input });
export const writes = (input: string) => ({ _tag: "Writes", input });
export const destroys = (input: string) => ({ _tag: "Destroys", input });
export const creates = (output: string, lifetime: string) => ({
  _tag: "Creates",
  output,
  lifetime,
});

export const noUndo = { _tag: "NoUndo", reason: "It cannot be taken back." };
export const fromInput = (name: string) => ({ _tag: "FromInput", name });
export const fromOutput = (name: string) => ({ _tag: "FromOutput", name });
export const undoWith = (block: string, inputs: Parts = {}, version = 1) => ({
  _tag: "Undo",
  block,
  version,
  inputs,
});

/** A block declaration: an action with no inputs, outputs or effects unless `parts` says otherwise. */
export const block = (id: string, parts: Parts = {}): BlockSpec =>
  decodeBlock({
    id,
    version: 1,
    title: id,
    kind: "Action",
    inputs: {},
    outputs: {},
    effects: [],
    undo: { _tag: "NothingToUndo" },
    rerun: "SafeWithIdempotencyKey",
    ...parts,
  });

export const fromRecipe = (name: string) => ({ _tag: "RecipeInput", name });
export const fromStep = (step: string, output: string) => ({ _tag: "StepOutput", step, output });
export const maybeFromStep = (step: string, output: string) => ({
  _tag: "OptionalStepOutput",
  step,
  output,
});
export const item = { _tag: "ForEachItem" };
export const literal = (value: Json) => ({ _tag: "Literal", value });

export const step = (id: string, blockId: string, inputs: Parts = {}, parts: Parts = {}) => ({
  _tag: "Step",
  id,
  block: blockId,
  version: 1,
  inputs,
  ...parts,
});
export const each = (over: Json, onItemFailure = "Continue") => ({
  forEach: { over, onItemFailure },
});

export const succeeded = { _tag: "End", result: "Succeeded" };
export const failed = (undo: "Run" | "Skip") => ({ _tag: "End", result: "Failed", undo });
/** An edge to a step, named by its id, or to an end. */
export const edge = (from: string, on: string, to: string | Parts) => ({
  from,
  on,
  to: typeof to === "string" ? { _tag: "Step", id: to } : to,
});
/** `chain("a", "b", "c")`: each step goes to the next when it succeeds. */
export const chain = (...steps: ReadonlyArray<string>) =>
  steps.slice(1).map((to, index) => edge(steps[index] ?? to, "Succeeded", to));

/** A recipe document: empty unless `parts` says otherwise. */
export const recipe = (parts: Parts): Recipe =>
  decodeRecipe({
    format: 1,
    id: "test",
    version: 1,
    title: "A test recipe",
    description: "Written for one test.",
    start: "first",
    inputs: {},
    nodes: [],
    edges: [],
    finally: [],
    invariants: [],
    ...parts,
  });

const marks = { Main: "", Undo: "undo ", Finally: "finally " } as const;

/** `"create:Succeeded write:Failed undo create:Succeeded finally record:Failed => NeedsAttention"` */
export const show = (path: Path): string =>
  [
    ...path.entries.map((entry) => `${marks[entry.phase]}${entry.step}:${entry.outcome}`),
    `=> ${path.result}`,
  ].join(" ");
