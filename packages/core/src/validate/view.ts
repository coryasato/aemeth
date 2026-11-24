import { Option } from "effect";
import type { BlockSpec, Lifetime } from "../BlockSpec";
import type { Name, StepId } from "../ids";
import { own } from "../ids";
import type { Created, ResolvedBinding, ResolvedStep, ResolvedUndo } from "./model";
import { createdAs } from "./model";
import type { Path, PathEntry, WalkedEntry, WalkedPath } from "./paths";
import { toPath } from "./paths";

// What an invariant sees. The rules in `../invariants/` are written against these types, so a
// rule reads as its sentence in the spec and never looks anything up in the recipe.

/** Where the value a block touches came from, traced through the recipe's wiring. */
export type Origin =
  | { readonly _tag: "RecipeInput"; readonly name: Name }
  | {
      readonly _tag: "StepOutput";
      readonly step: StepId;
      readonly output: Name;
      readonly created: Created;
    }
  /** One item of a list, in a for-each. */
  | { readonly _tag: "ItemOf"; readonly list: Origin }
  | { readonly _tag: "Literal" }
  /** An optional input that was left unbound: the block is given `None` and touches nothing. */
  | { readonly _tag: "Nothing" };

/** One declared effect of the block that ran, on the value that reached that input. */
export type Touch = {
  readonly effect: "Reads" | "Writes" | "Destroys";
  readonly input: Name;
  readonly origin: Origin;
};

export type EntryView = {
  readonly entry: PathEntry;
  /** The block that ran: the step's own block, or its undo block for an `Undo` entry. */
  readonly block: BlockSpec;
  readonly touches: ReadonlyArray<Touch>;
  readonly creates: ReadonlyArray<{ readonly output: Name; readonly lifetime: Lifetime }>;
};

export type PathView = { readonly path: Path; readonly entries: ReadonlyArray<EntryView> };

/** A rule holds on a path when it returns no message. */
export type Rule<Args> = (view: PathView, args: Args) => ReadonlyArray<string>;

const nothing: Origin = { _tag: "Nothing" };

const originOf = (step: ResolvedStep, binding: ResolvedBinding): Origin => {
  switch (binding._tag) {
    case "RecipeInput": {
      return { _tag: "RecipeInput", name: binding.name };
    }
    case "StepOutput":
    case "OptionalStepOutput": {
      return {
        _tag: "StepOutput",
        step: binding.step,
        output: binding.output,
        created: binding.created,
      };
    }
    case "Literal": {
      return { _tag: "Literal" };
    }
    case "ForEachItem": {
      return Option.match(step.forEach, {
        onNone: () => nothing,
        onSome: (forEach): Origin => ({ _tag: "ItemOf", list: originOf(step, forEach.over) }),
      });
    }
  }
};

const forwardOrigin = (step: ResolvedStep, input: Name): Origin => {
  const bound = step.inputs.find((candidate) => candidate.input === input);
  return bound === undefined ? nothing : originOf(step, bound.binding);
};

const undoOrigin = (step: ResolvedStep, undo: ResolvedUndo, input: Name): Origin => {
  const source = own(undo.inputs, input);
  if (source === undefined) {
    return nothing;
  }
  if (source._tag === "FromInput") {
    return forwardOrigin(step, source.name);
  }
  const output: Origin = {
    _tag: "StepOutput",
    step: step.step.id,
    output: source.name,
    created: createdAs(step.block, source.name),
  };
  // Undo is per item: a for-each step's undo is given one item's output.
  return Option.isSome(step.forEach) ? { _tag: "ItemOf", list: output } : output;
};

const viewOfBlock = (
  entry: PathEntry,
  block: BlockSpec,
  origin: (input: Name) => Origin,
): EntryView => ({
  entry,
  block,
  touches: block.effects.flatMap((effect) =>
    effect._tag === "Creates"
      ? []
      : [{ effect: effect._tag, input: effect.input, origin: origin(effect.input) }],
  ),
  creates: block.effects.flatMap((effect) =>
    effect._tag === "Creates" ? [{ output: effect.output, lifetime: effect.lifetime }] : [],
  ),
});

const viewOfEntry = (walked: WalkedEntry, entry: PathEntry): ReadonlyArray<EntryView> => {
  const step = walked.node;
  if (walked.phase !== "Undo") {
    return [viewOfBlock(entry, step.block, (input) => forwardOrigin(step, input))];
  }
  // An `Undo` entry exists only for a step with an undo block.
  return Option.match(step.undo, {
    onNone: () => [],
    onSome: (undo) => [viewOfBlock(entry, undo.block, (input) => undoOrigin(step, undo, input))],
  });
};

/** A path as the invariants see it. */
export const viewOf = (walked: WalkedPath): PathView => {
  const path = toPath(walked);
  return {
    path,
    entries: walked.entries.flatMap((entry, index) => {
      const data = path.entries[index];
      return data === undefined ? [] : viewOfEntry(entry, data);
    }),
  };
};

/** Whether the touch changes what it touches. */
export const isChange = (touch: Touch): boolean => touch.effect !== "Reads";

/** Whether a value is the recipe input, or an item of it. */
export const isFromRecipeInput = (origin: Origin, name: Name): boolean =>
  origin._tag === "ItemOf"
    ? isFromRecipeInput(origin.list, name)
    : origin._tag === "RecipeInput" && origin.name === name;

/** Whether a value is an output of the step (the named one, if given), or an item of it. */
export const isFromStep = (origin: Origin, step: StepId, output?: Name): boolean =>
  origin._tag === "ItemOf"
    ? isFromStep(origin.list, step, output)
    : origin._tag === "StepOutput" &&
      origin.step === step &&
      (output === undefined || origin.output === output);

/** "undo of deploy", "finally step record", "step verify": how a message names an entry. */
export const describeEntry = (entry: PathEntry): string => {
  switch (entry.phase) {
    case "Main": {
      return `step ${entry.step}`;
    }
    case "Undo": {
      return `the undo of ${entry.step}`;
    }
    case "Finally": {
      return `finally step ${entry.step}`;
    }
  }
};
