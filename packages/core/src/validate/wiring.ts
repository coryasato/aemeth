import { Option } from "effect";
import type { BlockSpec } from "../BlockSpec";
import type { DataType } from "../DataType";
import { sameType } from "../DataType";
import type { Name, StepId } from "../ids";
import { namesOf, own } from "../ids";
import type { LiteralValue, Outcome } from "../Recipe";
import { topologicalOrder } from "./graph";
import type { Hop, Place, ResolvedRecipe, ResolvedStep, ResolvedUndo, WiringError } from "./model";
import { isSuccess } from "./model";

type Errors = Array<WiringError>;

// `Array.isArray` does not narrow a readonly array out of a union.
const isList = (value: LiteralValue): value is ReadonlyArray<LiteralValue> => Array.isArray(value);

/**
 * Whether a value written in the recipe fits a type (M1 decision 23). Text, integers, booleans,
 * and lists and structs of those can be written. A duration, a timestamp and a resource cannot:
 * a recipe takes them as inputs, so no block's target is ever named in a recipe.
 */
export const literalFits = (type: DataType, value: LiteralValue): boolean => {
  switch (type._tag) {
    case "Text": {
      return typeof value === "string";
    }
    case "Integer": {
      return Number.isSafeInteger(value);
    }
    case "Boolean": {
      return typeof value === "boolean";
    }
    case "List": {
      return isList(value) && value.every((item) => literalFits(type.item, item));
    }
    case "Struct": {
      if (typeof value !== "object" || isList(value)) {
        return false;
      }
      const record = value;
      const fields = namesOf(type.fields);
      return (
        fields.length === Object.keys(record).length &&
        fields.every(([name, fieldType]) => {
          const field = own(record, name);
          return field !== undefined && literalFits(fieldType, field);
        })
      );
    }
    case "Duration":
    case "Timestamp":
    case "Resource": {
      return false;
    }
  }
};

type Incoming = { readonly from: ResolvedStep; readonly on: Outcome };

export type Guarantees = {
  readonly guaranteed: ReadonlyMap<StepId, ReadonlySet<StepId>>;
  /** A way from `start` to `step` on which `producer` has not succeeded, if there is one. */
  readonly pathWithout: (step: StepId, producer: StepId) => Option.Option<ReadonlyArray<Hop>>;
};

/**
 * For each main-path step, the steps that have succeeded on every path that reaches it. One pass
 * in topological order: a step's set is the intersection, over the edges into it, of the source's
 * set plus the source itself when the edge is taken on success. No path is enumerated.
 */
export const guaranteedBefore = (resolved: ResolvedRecipe): Guarantees => {
  const successors = (step: ResolvedStep): ReadonlyArray<ResolvedStep> =>
    [...(resolved.edges.get(step.step.id)?.values() ?? [])].flatMap((target) =>
      target._tag === "Step" ? [target.step] : [],
    );
  const incoming = new Map<StepId, Array<Incoming>>();
  for (const from of resolved.main) {
    for (const [on, target] of resolved.edges.get(from.step.id) ?? []) {
      if (target._tag === "Step") {
        incoming.set(target.step.step.id, [
          ...(incoming.get(target.step.step.id) ?? []),
          { from, on },
        ]);
      }
    }
  }

  const guaranteed = new Map<StepId, ReadonlySet<StepId>>();
  const after = (edge: Incoming): ReadonlySet<StepId> => {
    const before = guaranteed.get(edge.from.step.id) ?? new Set<StepId>();
    return isSuccess(edge.on) ? new Set([...before, edge.from.step.id]) : before;
  };
  for (const step of topologicalOrder(resolved.start, successors)) {
    const sets = (incoming.get(step.step.id) ?? []).map(after);
    const [first, ...rest] = sets;
    guaranteed.set(
      step.step.id,
      first === undefined
        ? new Set()
        : new Set([...first].filter((id) => rest.every((set) => set.has(id)))),
    );
  }

  const pathWithout = (step: StepId, producer: StepId): Option.Option<ReadonlyArray<Hop>> => {
    if (guaranteed.get(step)?.has(producer) === true) {
      return Option.none();
    }
    const edge = (incoming.get(step) ?? []).find((candidate) => !after(candidate).has(producer));
    if (edge === undefined) {
      return Option.some([]);
    }
    return Option.map(pathWithout(edge.from.step.id, producer), (hops) => [
      ...hops,
      { step: edge.from.step.id, outcome: edge.on },
    ]);
  };

  return { guaranteed, pathWithout };
};

const changes = (block: BlockSpec, tag: "Writes" | "Creates", name: Name): boolean =>
  block.effects.some(
    (effect) =>
      effect._tag === tag && (effect._tag === "Creates" ? effect.output : effect.input) === name,
  );

/** An undo block is fed, input by input, from the step it undoes, and changes only what that step changed. */
const undoErrors = (step: ResolvedStep, undo: ResolvedUndo): Errors => {
  const id = step.step.id;
  const errors: Errors = [];
  for (const [input, source] of namesOf(undo.inputs)) {
    const spec = own(undo.block.inputs, input);
    if (spec === undefined) {
      errors.push({ _tag: "UndoInputUnknown", step: id, input });
    } else if (source._tag === "FromInput") {
      const from = own(step.block.inputs, source.name);
      if (from !== undefined) {
        if (from._tag === "Optional" && spec._tag === "Required") {
          errors.push({ _tag: "UndoOptionalIntoRequired", step: id, input });
        }
        if (!sameType(spec.type, from.type)) {
          errors.push({
            _tag: "UndoTypeMismatch",
            step: id,
            input,
            expected: spec.type,
            actual: from.type,
          });
        }
      }
    } else {
      // Undo is per item, so a for-each step's undo sees one item's output, not the list.
      const from = own(step.block.outputs, source.name);
      if (from !== undefined && !sameType(spec.type, from)) {
        errors.push({
          _tag: "UndoTypeMismatch",
          step: id,
          input,
          expected: spec.type,
          actual: from,
        });
      }
    }
  }
  for (const [input, spec] of namesOf(undo.block.inputs)) {
    if (spec._tag === "Required" && own(undo.inputs, input) === undefined) {
      errors.push({ _tag: "UndoInputNotFed", step: id, input });
    }
  }
  for (const effect of undo.block.effects) {
    if (effect._tag === "Writes" || effect._tag === "Destroys") {
      // An undo may write what its step wrote or created, and destroy only what its step
      // created: destroying something the step merely wrote is not taking the write back.
      const source = own(undo.inputs, effect.input);
      const allowed =
        source === undefined ||
        (source._tag === "FromOutput"
          ? changes(step.block, "Creates", source.name)
          : effect._tag === "Writes" && changes(step.block, "Writes", source.name));
      if (!allowed) {
        errors.push({ _tag: "UndoChangesUntouched", step: id, input: effect.input });
      }
    }
  }
  return errors;
};

const mismatch = (expected: DataType, actual: DataType, at: Place): Errors =>
  sameType(expected, actual) ? [] : [{ _tag: "TypeMismatch", at, expected, actual }];

/**
 * Stage 5 of validation: every required input is bound, every value fits where it is sent, every
 * step output is read only where its step is known to have succeeded, and every undo block is fed
 * by its step. Paths are not enumerated here.
 */
export const checkWiring = (resolved: ResolvedRecipe): ReadonlyArray<WiringError> => {
  const { pathWithout } = guaranteedBefore(resolved);
  const errors: Errors = [];

  const notGuaranteed = (user: StepId, producer: StepId, at: Place): Errors =>
    Option.match(pathWithout(user, producer), {
      onNone: () => [],
      onSome: (path) => [{ _tag: "OutputNotGuaranteed", at, producer, path }],
    });
  for (const step of [...resolved.main, ...resolved.finally]) {
    const id = step.step.id;

    let item: Option.Option<DataType> = Option.none();
    if (Option.isSome(step.forEach)) {
      const { over } = step.forEach.value;
      if (over._tag === "Literal" || over._tag === "OptionalStepOutput") {
        errors.push({ _tag: "ForEachOverNotAllowed", step: id, binding: over._tag });
      } else {
        if (over._tag === "StepOutput") {
          errors.push(...notGuaranteed(id, over.step, { _tag: "ForEachOver", step: id }));
        }
        if (over.type._tag === "List") {
          item = Option.some(over.type.item);
        } else {
          errors.push({ _tag: "ForEachOverNotList", step: id, actual: over.type });
        }
      }
    }

    for (const [input, spec] of namesOf(step.block.inputs)) {
      if (spec._tag === "Required" && own(step.step.inputs, input) === undefined) {
        errors.push({ _tag: "RequiredInputNotBound", step: id, input });
      }
    }

    for (const { binding, input, spec } of step.inputs) {
      const at: Place = { _tag: "Input", step: id, input };
      switch (binding._tag) {
        case "RecipeInput": {
          errors.push(...mismatch(spec.type, binding.type, at));
          break;
        }
        case "StepOutput": {
          errors.push(
            ...mismatch(spec.type, binding.type, at),
            ...notGuaranteed(id, binding.step, at),
          );
          break;
        }
        case "OptionalStepOutput": {
          if (step.track === "Main") {
            errors.push({ _tag: "OptionalOutputOutsideFinally", step: id, input });
          }
          if (spec._tag === "Required") {
            errors.push({ _tag: "OptionalOutputIntoRequired", step: id, input });
          }
          errors.push(...mismatch(spec.type, binding.type, at));
          break;
        }
        case "ForEachItem": {
          // With no item type, the for-each itself was already reported.
          if (Option.isSome(item)) {
            errors.push(...mismatch(spec.type, item.value, at));
          }
          break;
        }
        case "Literal": {
          if (!literalFits(spec.type, binding.value)) {
            errors.push({ _tag: "LiteralDoesNotFit", step: id, input, expected: spec.type });
          }
          break;
        }
      }
    }

    if (Option.isSome(step.undo)) {
      errors.push(...undoErrors(step, step.undo.value));
    }
  }
  return errors;
};
