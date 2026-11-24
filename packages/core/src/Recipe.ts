import { Schema } from "effect";
import { DataType } from "./DataType";
import { BlockId, Name, Prose, RecipeId, StepId, Version } from "./ids";

/** A value written into the recipe itself. Whether it fits the input it binds is checked by the validator. */
export type LiteralValue =
  | string
  | number
  | boolean
  | ReadonlyArray<LiteralValue>
  | { readonly [field: string]: LiteralValue };

const literalValue = Schema.suspend((): Schema.Codec<LiteralValue> => LiteralValue);

export const LiteralValue = Schema.Union([
  Schema.String,
  // `Finite`, not `Number`: `Number` also admits the strings "NaN" and "Infinity" in a document.
  Schema.Finite,
  Schema.Boolean,
  Schema.Array(literalValue),
  Schema.Record(Schema.String, literalValue),
]).annotate({ identifier: "LiteralValue" });

/**
 * Where a step input's value comes from. Data travels on bindings, not on edges (M1 decision 6).
 *
 * - `StepOutput` is valid only where its step has succeeded on every path to the step that uses it.
 * - `OptionalStepOutput` is for `finally` steps: it resolves to `Some` output or `None`.
 * - `ForEachItem` is the current item of the step's own `forEach`.
 */
export const Binding = Schema.TaggedUnion({
  RecipeInput: { name: Name },
  StepOutput: { step: StepId, output: Name },
  OptionalStepOutput: { step: StepId, output: Name },
  ForEachItem: {},
  Literal: { value: LiteralValue },
}).annotate({ identifier: "Binding" });
export type Binding = typeof Binding.Type;

/** Runs a step once per item of a `List`. `Stop` starts no further item after one fails; `Continue` runs them all. */
export const ForEach = Schema.Struct({
  over: Binding,
  onItemFailure: Schema.Literals(["Stop", "Continue"]),
}).annotate({ identifier: "ForEach" });
export type ForEach = typeof ForEach.Type;

/** A node of the recipe graph: one use of a block. */
export const Step = Schema.TaggedStruct("Step", {
  id: StepId,
  block: BlockId,
  version: Version,
  inputs: Schema.Record(Name, Binding),
  forEach: Schema.optionalKey(ForEach),
}).annotate({ identifier: "Step" });
export type Step = typeof Step.Type;

/** How a step ended, as far as control flow is concerned. Which outcomes a step has follows from its block's kind. */
export const Outcome = Schema.Literals(["Succeeded", "Failed", "Approved", "Denied"]).annotate({
  identifier: "Outcome",
});
export type Outcome = typeof Outcome.Type;

/**
 * Where an edge leads. An explicit `End` states the main path's result. Only a failed end says
 * whether the undo phase runs: `undo: "Skip"` means the recipe's own steps already put things
 * right (M1 decision 15). A successful end never undoes, so it has no `undo` to set.
 */
export const EdgeTarget = Schema.Union([
  Schema.TaggedStruct("Step", { id: StepId }),
  Schema.TaggedStruct("End", { result: Schema.Literal("Succeeded") }),
  Schema.TaggedStruct("End", {
    result: Schema.Literal("Failed"),
    undo: Schema.Literals(["Run", "Skip"]),
  }),
]).annotate({ identifier: "EdgeTarget" });
export type EdgeTarget = typeof EdgeTarget.Type;

/** Control only: after `from` ends with outcome `on`, the run goes to `to`. */
export const Edge = Schema.Struct({
  from: StepId,
  on: Outcome,
  to: EdgeTarget,
}).annotate({ identifier: "Edge" });
export type Edge = typeof Edge.Type;

/**
 * A rule from `packages/core/src/invariants/` that a recipe asserts, with its arguments.
 * `IrreversibleOnlyAfterApproval` applies to every recipe and is not listed here.
 */
export const InvariantRef = Schema.Union([
  Schema.Struct({ rule: Schema.Literal("NeverWritten"), input: Name }),
  Schema.Struct({ rule: Schema.Literal("CleanedUp"), step: StepId, output: Name }),
  Schema.Struct({ rule: Schema.Literal("RequiredForSuccess"), step: StepId }),
  Schema.Struct({ rule: Schema.Literal("NoWriteBeforeApproval"), input: Name }),
  Schema.Struct({ rule: Schema.Literal("AfterFailure"), step: StepId, then: StepId }),
  Schema.Struct({ rule: Schema.Literal("DestroysOnlyApproved"), gate: StepId }),
  Schema.Struct({
    rule: Schema.Literal("OnlyAfter"),
    step: StepId,
    requires: Schema.NonEmptyArray(StepId),
  }),
]).annotate({ identifier: "InvariantRef" });
export type InvariantRef = typeof InvariantRef.Type;

/** A recipe input, supplied when a run starts. */
export const RecipeInput = Schema.Struct({ type: DataType }).annotate({
  identifier: "RecipeInput",
});
export type RecipeInput = typeof RecipeInput.Type;

/**
 * A recipe document: blocks arranged into a graph (decision 0002).
 *
 * The Schema checks only the shape. Everything that relates one part to another (ids exist,
 * types fit, no cycles, every path, the invariants) is the validator's work.
 */
export const Recipe = Schema.Struct({
  /** Lets an editor find the generated JSON Schema. Carries no meaning. */
  $schema: Schema.optionalKey(Schema.String),
  format: Schema.Literal(1),
  id: RecipeId,
  version: Version,
  title: Prose,
  description: Prose,
  /** The first main-path step. */
  start: StepId,
  inputs: Schema.Record(Name, RecipeInput),
  nodes: Schema.Array(Step),
  edges: Schema.Array(Edge),
  /** Steps that run after the main path ends, whatever its result, in this order. */
  finally: Schema.Array(StepId),
  invariants: Schema.Array(InvariantRef),
}).annotate({ identifier: "Recipe" });
export type Recipe = typeof Recipe.Type;

/**
 * Decodes a recipe document, rejecting unknown fields, so that the decoder and the generated
 * JSON Schema agree on them.
 */
export const decodeRecipe = Schema.decodeUnknownResult(Recipe, { onExcessProperty: "error" });
