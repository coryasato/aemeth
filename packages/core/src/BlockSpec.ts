import { Schema } from "effect";
import { DataType } from "./DataType";
import { BlockId, Name, namesOf, Prose, Version } from "./ids";

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

/**
 * How long a created resource lasts. `Temporary` is tagged with its run's id and must be destroyed
 * by that run (the always-on `TemporaryCleanedUp` invariant). `Expiring` goes away by itself, such
 * as a download link, so nothing has to destroy it. `Durable` is meant to stay.
 */
export const Lifetime = Schema.Literals(["Temporary", "Expiring", "Durable"]).annotate({
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

/** Where one input of an undo block comes from: an input or an output of the step being undone. */
export const UndoSource = Schema.TaggedUnion({
  FromInput: { name: Name },
  FromOutput: { name: Name },
}).annotate({ identifier: "UndoSource" });
export type UndoSource = typeof UndoSource.Type;

/**
 * How a block's work is taken back. `Undo` names a compensating block and says, input by input,
 * which of this block's inputs or outputs feeds it (M1 decision 21). A block that writes and
 * cannot be undone says so with `NoUndo` and a reason. `NothingToUndo` is only for a block that
 * changes nothing.
 */
export const BlockUndo = Schema.TaggedUnion({
  Undo: { block: BlockId, version: Version, inputs: Schema.Record(Name, UndoSource) },
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
  | { readonly _tag: "GateChanges"; readonly effect: BlockEffect }
  | { readonly _tag: "GateHasUndo" }
  | { readonly _tag: "UndoFedFromUnknownInput"; readonly undoInput: Name; readonly input: Name }
  | { readonly _tag: "UndoFedFromUnknownOutput"; readonly undoInput: Name; readonly output: Name };

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

const undoProblems = (spec: BlockSpec): ReadonlyArray<BlockSpecProblem> => {
  if (spec.undo._tag !== "Undo") {
    return [];
  }
  return namesOf(spec.undo.inputs).flatMap(([undoInput, source]): Array<BlockSpecProblem> => {
    if (source._tag === "FromInput") {
      return Object.hasOwn(spec.inputs, source.name)
        ? []
        : [{ _tag: "UndoFedFromUnknownInput", undoInput, input: source.name }];
    }
    return Object.hasOwn(spec.outputs, source.name)
      ? []
      : [{ _tag: "UndoFedFromUnknownOutput", undoInput, output: source.name }];
  });
};

// A gate ends `Approved` or `Denied`, never `Succeeded`, and it changes nothing, so an undo
// declared on one would never run.
const gateUndoProblems = (spec: BlockSpec): ReadonlyArray<BlockSpecProblem> =>
  spec.kind === "Gate" && spec.undo._tag === "Undo" ? [{ _tag: "GateHasUndo" }] : [];

/**
 * Checks one declaration against itself: every effect names a declared input or output,
 * `NothingToUndo` is claimed only by a block with no `Writes`, `Creates` or `Destroys`, a gate has
 * none of those either (it shows its inputs and waits, so it cannot be the write it guards) and
 * no undo block, and an undo is fed only from inputs and outputs the block declares.
 * Returns every problem; an empty list means the declaration is consistent.
 */
export const blockSpecProblems = (spec: BlockSpec): ReadonlyArray<BlockSpecProblem> => [
  ...spec.effects.flatMap((effect) => effectProblems(spec, effect)),
  ...gateUndoProblems(spec),
  ...undoProblems(spec),
];
