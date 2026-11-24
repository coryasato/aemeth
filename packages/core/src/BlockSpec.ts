import { Schema } from "effect";
import { DataType } from "./DataType";
import { BlockId, Name, Prose, Version } from "./ids";

/** What a block is. Its outcomes follow: an action or check succeeds or fails, a gate is approved or denied. */
export const BlockKind = Schema.Literals(["Action", "Check", "Gate"]).annotate({
  identifier: "BlockKind",
});
export type BlockKind = typeof BlockKind.Type;

/** An `Optional` input receives an `Option`: the block must handle `None`. */
export const BlockInput = Schema.TaggedUnion({
  Required: { type: DataType },
  Optional: { type: DataType },
}).annotate({ identifier: "BlockInput" });
export type BlockInput = typeof BlockInput.Type;

/** A resource created as `Temporary` is tagged with its run's id and is meant to be destroyed by that run. */
export const Lifetime = Schema.Literals(["Temporary", "Durable"]).annotate({
  identifier: "Lifetime",
});
export type Lifetime = typeof Lifetime.Type;

/** What a block touches. An effect names the block's own inputs and outputs, never a concrete resource. */
export const BlockEffect = Schema.TaggedUnion({
  Reads: { input: Name },
  Writes: { input: Name },
  Creates: { output: Name, lifetime: Lifetime },
  Destroys: { input: Name },
}).annotate({ identifier: "BlockEffect" });
export type BlockEffect = typeof BlockEffect.Type;

/**
 * How a block's work is taken back. `Undo` names a compensating block that is given this step's
 * inputs and outputs. A block that writes and cannot be undone says so with `NoUndo` and a reason.
 * `NothingToUndo` is only for a block that changes nothing.
 */
export const BlockUndo = Schema.TaggedUnion({
  Undo: { block: BlockId, version: Version },
  NoUndo: { reason: Prose },
  NothingToUndo: {},
}).annotate({ identifier: "BlockUndo" });
export type BlockUndo = typeof BlockUndo.Type;

/**
 * A block's declaration: data only, no implementation.
 *
 * `rerun` has one value, so a block that is not safe to re-run after a crash cannot be declared
 * (M1 decision 9). A `BlockSpec` has no field for a target: targets reach a block only through
 * its inputs.
 */
export const BlockSpec = Schema.Struct({
  id: BlockId,
  version: Version,
  title: Prose,
  kind: BlockKind,
  inputs: Schema.Record(Name, BlockInput),
  outputs: Schema.Record(Name, DataType),
  effects: Schema.Array(BlockEffect),
  undo: BlockUndo,
  rerun: Schema.Literal("SafeWithIdempotencyKey"),
}).annotate({ identifier: "BlockSpec" });
export type BlockSpec = typeof BlockSpec.Type;

/** What is wrong inside one block declaration, beyond what the Schema can say. */
export type BlockSpecProblem =
  | { readonly _tag: "EffectNamesUnknownInput"; readonly effect: BlockEffect; readonly input: Name }
  | {
      readonly _tag: "EffectNamesUnknownOutput";
      readonly effect: BlockEffect;
      readonly output: Name;
    }
  | { readonly _tag: "NothingToUndoButChanges"; readonly effect: BlockEffect }
  | { readonly _tag: "GateChanges"; readonly effect: BlockEffect };

const effectProblems = (spec: BlockSpec, effect: BlockEffect): ReadonlyArray<BlockSpecProblem> => {
  const problems: Array<BlockSpecProblem> = [];
  if (effect._tag === "Creates") {
    if (!Object.hasOwn(spec.outputs, effect.output)) {
      problems.push({ _tag: "EffectNamesUnknownOutput", effect, output: effect.output });
    }
  } else if (!Object.hasOwn(spec.inputs, effect.input)) {
    problems.push({ _tag: "EffectNamesUnknownInput", effect, input: effect.input });
  }
  if (spec.undo._tag === "NothingToUndo" && effect._tag !== "Reads") {
    problems.push({ _tag: "NothingToUndoButChanges", effect });
  }
  if (spec.kind === "Gate" && effect._tag !== "Reads") {
    problems.push({ _tag: "GateChanges", effect });
  }
  return problems;
};

/**
 * Checks one declaration against itself: every effect names a declared input or output,
 * `NothingToUndo` is claimed only by a block with no `Writes`, `Creates` or `Destroys`, and a
 * gate has none of those either: it shows its inputs and waits, so it cannot be the write it guards.
 * Returns every problem; an empty list means the declaration is consistent.
 */
export const blockSpecProblems = (spec: BlockSpec): ReadonlyArray<BlockSpecProblem> =>
  spec.effects.flatMap((effect) => effectProblems(spec, effect));
