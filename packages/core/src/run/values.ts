import type { Schema } from "effect";
import { Option } from "effect";
import type { StepId } from "../ids";
import { namesOf, own } from "../ids";
import type {
  ResolvedBinding,
  ResolvedRecipe,
  ResolvedStep,
  ResolvedUndo,
} from "../validate/model";
import type { ItemIndex } from "./idempotencyKey";
import type { RunEvent } from "./RunEvent";

type Json = Schema.Json;
type Outputs = { readonly [name: string]: Json };

/**
 * The values a run's log holds: what the run was started with, and what each piece of work that
 * succeeded produced. A gate's outputs are what was approved. An item of a for-each is under its
 * index, and a step that is not a for-each under `undefined`.
 */
export type RunValues = {
  readonly inputs: Outputs;
  readonly outputs: ReadonlyMap<StepId, ReadonlyMap<ItemIndex | undefined, Outputs>>;
};

/** Reads the values out of a log. */
export const valuesOf = (log: Iterable<RunEvent>): RunValues => {
  let inputs: Outputs = {};
  const outputs = new Map<StepId, Map<ItemIndex | undefined, Outputs>>();
  const produced = (step: StepId, item: ItemIndex | undefined, values: Outputs): void => {
    const ofStep = outputs.get(step) ?? new Map<ItemIndex | undefined, Outputs>();
    outputs.set(step, ofStep);
    ofStep.set(item, values);
  };
  for (const event of log) {
    if (event._tag === "RunStarted") {
      ({ inputs } = event);
    } else if (event._tag === "StepSucceeded") {
      produced(event.step, event.item, event.outputs);
    } else if (event._tag === "ApprovalGranted") {
      produced(event.step, undefined, event.outputs);
    }
  }
  return { inputs, outputs };
};

const given = (record: Outputs | undefined, name: string): Option.Option<Json> => {
  const value = record === undefined ? undefined : own(record, name);
  return value === undefined ? Option.none() : Option.some(value);
};

// `Array.isArray` does not narrow a readonly array out of a union.
const isList = (json: Json): json is ReadonlyArray<Json> => Array.isArray(json);

const stepOf = (recipe: ResolvedRecipe, id: StepId): ResolvedStep | undefined =>
  [...recipe.main, ...recipe.finally].find((step) => step.step.id === id);

/**
 * The value of one output of a step, if the step has produced it. A for-each's output is the list
 * of its items' outputs, in item order, and is there only once every item has succeeded.
 */
const outputOf = (
  recipe: ResolvedRecipe,
  values: RunValues,
  id: StepId,
  output: string,
): Option.Option<Json> => {
  const producer = stepOf(recipe, id);
  const produced = values.outputs.get(id);
  if (producer === undefined) {
    return Option.none();
  }
  if (Option.isNone(producer.forEach)) {
    return given(produced?.get(undefined), output);
  }
  return Option.flatMap(itemsOf(recipe, producer, values), (items) =>
    Option.all(items.map((_, index) => given(produced?.get(index), output))),
  );
};

/** The value a binding carries now, or nothing if its source has not produced it. */
const resolve = (
  recipe: ResolvedRecipe,
  values: RunValues,
  binding: ResolvedBinding,
  item: Option.Option<Json>,
): Option.Option<Json> => {
  switch (binding._tag) {
    case "RecipeInput": {
      return given(values.inputs, binding.name);
    }
    case "StepOutput":
    case "OptionalStepOutput": {
      return outputOf(recipe, values, binding.step, binding.output);
    }
    case "ForEachItem": {
      return item;
    }
    case "Literal": {
      return Option.some(binding.value);
    }
  }
};

/**
 * The list a for-each step runs over, once the log holds it. Nothing for a step that is not a
 * for-each, or whose list has not been produced yet.
 */
export const itemsOf = (
  recipe: ResolvedRecipe,
  step: ResolvedStep,
  values: RunValues,
): Option.Option<ReadonlyArray<Json>> =>
  Option.flatMap(step.forEach, ({ over }) =>
    Option.filter(resolve(recipe, values, over, Option.none()), isList),
  );

/** How many items a for-each step has: 0 until its list is known, and for any other step. */
export const sizeOf = (recipe: ResolvedRecipe, step: ResolvedStep, values: RunValues): number =>
  Option.match(itemsOf(recipe, step, values), {
    onNone: () => 0,
    onSome: (items) => items.length,
  });

/** What a block is given: one entry per input it declares, with nothing where no value came. */
export type StepInputs = { readonly [name: string]: Option.Option<Json> };

/**
 * The inputs of a step, or of one item of a for-each, read from the log. An input the step does
 * not bind, or whose source produced nothing, is `None`: the validator allows that only for an
 * `Optional` input.
 */
export const inputsOf = (
  recipe: ResolvedRecipe,
  step: ResolvedStep,
  values: RunValues,
  item: ItemIndex | undefined,
): StepInputs => {
  const current = Option.flatMap(itemsOf(recipe, step, values), (items) =>
    Option.fromUndefinedOr(item === undefined ? undefined : items[item]),
  );
  return Object.fromEntries(
    namesOf(step.block.inputs).map(([name]) => {
      const bound = step.inputs.find((input) => input.input === name);
      return [
        name,
        bound === undefined ? Option.none() : resolve(recipe, values, bound.binding, current),
      ];
    }),
  );
};

/**
 * The inputs of a step's undo block, fed as the block's declaration says: from the inputs the
 * step was given, or from what it (or this item of it) produced.
 */
export const undoInputsOf = (
  recipe: ResolvedRecipe,
  step: ResolvedStep,
  undo: ResolvedUndo,
  values: RunValues,
  item: ItemIndex | undefined,
): StepInputs => {
  const forward = inputsOf(recipe, step, values, item);
  const produced = values.outputs.get(step.step.id)?.get(item);
  return Object.fromEntries(
    namesOf(undo.block.inputs).map(([name]) => {
      const source = own(undo.inputs, name);
      if (source === undefined) {
        return [name, Option.none()];
      }
      return [
        name,
        source._tag === "FromInput"
          ? (own(forward, source.name) ?? Option.none())
          : given(produced, source.name),
      ];
    }),
  );
};
