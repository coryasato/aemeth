import { Option, Result } from "effect";
import type { BlockSpec } from "../BlockSpec";
import { blockSpecProblems } from "../BlockSpec";
import type { BlockId, Name, StepId, Version } from "../ids";
import { namesOf, own } from "../ids";
import type { Binding, Edge, InvariantRef, Outcome, Recipe, Step } from "../Recipe";
import type {
  Place,
  ResolvedBinding,
  ResolvedForEach,
  ResolvedInput,
  ResolvedRecipe,
  ResolvedStep,
  ResolvedUndo,
  StructureError,
  Target,
} from "./model";
import { createdAs, outcomesOf } from "./model";

type Errors = Array<StructureError>;
type Catalog = ReadonlyMap<string, BlockSpec>;

const blockKey = (block: BlockId, version: Version): string => `${block}@${version}`;

/**
 * Stage 2 of validation: every name in the recipe refers to something, and the graph has the
 * shape the later stages rely on. Returns every error, or the recipe with its names looked up.
 */
export const checkStructure = (
  recipe: Recipe,
  blocks: ReadonlyArray<BlockSpec>,
): Result.Result<ResolvedRecipe, ReadonlyArray<StructureError>> => {
  const errors: Errors = [];
  const declared = new Map<string, BlockSpec>();
  for (const block of blocks) {
    const key = blockKey(block.id, block.version);
    if (declared.has(key)) {
      // Which of the two a recipe means cannot be known, so neither is silently preferred.
      errors.push({ _tag: "DuplicateBlock", block: block.id, version: block.version });
    }
    declared.set(key, block);
  }
  const catalog: Catalog = declared;

  // A block that contradicts itself is reported once, by block, at its first use.
  const checked = new Map<string, boolean>();
  const isInconsistent = (block: BlockSpec): boolean => {
    const key = blockKey(block.id, block.version);
    const known = checked.get(key);
    if (known !== undefined) {
      return known;
    }
    const problems = blockSpecProblems(block);
    errors.push(
      ...problems.map((problem): StructureError => ({
        _tag: "BlockInconsistent",
        block: block.id,
        version: block.version,
        problem,
      })),
    );
    checked.set(key, problems.length > 0);
    return problems.length > 0;
  };
  const nodes = new Map<StepId, Step>(recipe.nodes.map((node) => [node.id, node]));
  const finallyIds = new Set<StepId>(recipe.finally);
  const blockOf = (node: Step) => catalog.get(blockKey(node.block, node.version));

  const unknownStep = (step: StepId, at: Place): Errors =>
    nodes.has(step) ? [] : [{ _tag: "UnknownStep", step, at }];
  const unknownInput = (name: Name, at: Place): Errors =>
    own(recipe.inputs, name) === undefined ? [{ _tag: "UnknownRecipeInput", name, at }] : [];
  const unknownOutput = (step: StepId, output: Name, at: Place): Errors => {
    const node = nodes.get(step);
    if (node === undefined) {
      return [{ _tag: "UnknownStep", step, at }];
    }
    const block = blockOf(node);
    // A step whose block is unknown is reported once, at the step.
    return block === undefined || own(block.outputs, output) !== undefined
      ? []
      : [{ _tag: "UnknownStepOutput", step, output, at }];
  };

  /** The binding with its target's type, or nothing when its target was reported missing. */
  const resolveBinding = (binding: Binding): Option.Option<ResolvedBinding> => {
    switch (binding._tag) {
      case "RecipeInput": {
        const input = own(recipe.inputs, binding.name);
        return input === undefined
          ? Option.none()
          : Option.some({ _tag: "RecipeInput", name: binding.name, type: input.type });
      }
      case "StepOutput":
      case "OptionalStepOutput": {
        const producer = nodes.get(binding.step);
        const block = producer === undefined ? undefined : blockOf(producer);
        const type = block === undefined ? undefined : own(block.outputs, binding.output);
        if (producer === undefined || block === undefined || type === undefined) {
          return Option.none();
        }
        return Option.some({
          _tag: binding._tag,
          step: binding.step,
          output: binding.output,
          type: producer.forEach === undefined ? type : { _tag: "List", item: type },
          created: createdAs(block, binding.output),
        });
      }
      case "ForEachItem":
      case "Literal": {
        return Option.some(binding);
      }
    }
  };

  const bindingErrors = (binding: Binding, at: Place): Errors => {
    switch (binding._tag) {
      case "RecipeInput": {
        return unknownInput(binding.name, at);
      }
      case "StepOutput":
      case "OptionalStepOutput": {
        return unknownOutput(binding.step, binding.output, at);
      }
      case "ForEachItem":
      case "Literal": {
        return [];
      }
    }
  };

  const resolved = new Map<StepId, ResolvedStep>();

  const seen = new Set<StepId>();
  for (const node of recipe.nodes) {
    if (seen.has(node.id)) {
      errors.push({ _tag: "DuplicateStepId", step: node.id });
    }
    seen.add(node.id);
  }

  for (const node of recipe.nodes) {
    const step = node.id;
    const stepErrors: Errors = [];
    const track = finallyIds.has(step) ? "Finally" : "Main";
    const block = blockOf(node);
    let undo: Option.Option<ResolvedUndo> = Option.none();
    let unresolved = false;

    if (block === undefined) {
      stepErrors.push({ _tag: "UnknownBlock", step, block: node.block, version: node.version });
    } else {
      unresolved = isInconsistent(block);
      if (block.kind === "Gate" && track === "Finally") {
        stepErrors.push({ _tag: "FinallyStepIsGate", step });
      }
      if (block.kind === "Gate" && node.forEach !== undefined) {
        stepErrors.push({ _tag: "ForEachGate", step });
      }
      if (block.undo._tag === "Undo") {
        const undoBlock = catalog.get(blockKey(block.undo.block, block.undo.version));
        const named = { step, block: block.undo.block, version: block.undo.version };
        if (undoBlock === undefined) {
          stepErrors.push({ _tag: "UnknownUndoBlock", ...named });
        } else {
          unresolved = isInconsistent(undoBlock) || unresolved;
          if (undoBlock.kind === "Gate") {
            stepErrors.push({ _tag: "UndoBlockIsGate", ...named });
          }
          undo = Option.some({ block: undoBlock, inputs: block.undo.inputs });
        }
      }
    }

    const inputs: Array<ResolvedInput> = [];
    for (const [input, binding] of namesOf(node.inputs)) {
      const at: Place = { _tag: "Input", step, input };
      const spec = block === undefined ? undefined : own(block.inputs, input);
      if (block !== undefined && spec === undefined) {
        stepErrors.push({ _tag: "UnknownBlockInput", step, input });
      }
      if (binding._tag === "ForEachItem" && node.forEach === undefined) {
        stepErrors.push({ _tag: "ForEachItemOutsideForEach", at });
      }
      if (binding._tag === "StepOutput" && track === "Finally") {
        stepErrors.push({ _tag: "FinallyStepUsesStepOutput", step, at });
      }
      stepErrors.push(...bindingErrors(binding, at));
      const target = resolveBinding(binding);
      if (spec !== undefined && Option.isSome(target)) {
        inputs.push({ input, spec, binding: target.value });
      } else {
        unresolved = true;
      }
    }

    let forEach: Option.Option<ResolvedForEach> = Option.none();
    if (node.forEach !== undefined) {
      const at: Place = { _tag: "ForEachOver", step };
      const { onItemFailure, over } = node.forEach;
      if (over._tag === "ForEachItem") {
        stepErrors.push({ _tag: "ForEachItemOutsideForEach", at });
      }
      if (over._tag === "StepOutput" && track === "Finally") {
        stepErrors.push({ _tag: "FinallyStepUsesStepOutput", step, at });
      }
      stepErrors.push(...bindingErrors(over, at));
      const target = resolveBinding(over);
      if (Option.isSome(target) && target.value._tag !== "ForEachItem") {
        forEach = Option.some({ over: target.value, onItemFailure });
      } else {
        unresolved = true;
      }
    }

    errors.push(...stepErrors);
    if (block !== undefined && stepErrors.length === 0 && !unresolved) {
      resolved.set(step, { step: node, track, block, undo, inputs, forEach });
    }
  }

  errors.push(...unknownStep(recipe.start, { _tag: "Start" }));
  if (finallyIds.has(recipe.start)) {
    errors.push({ _tag: "StartIsFinally", step: recipe.start });
  }

  const listed = new Set<StepId>();
  for (const step of recipe.finally) {
    errors.push(...unknownStep(step, { _tag: "Finally" }));
    if (listed.has(step)) {
      errors.push({ _tag: "FinallyStepRepeated", step });
    }
    listed.add(step);
  }

  const edges = new Map<StepId, Map<Outcome, Target>>();
  const targetOf = (edge: Edge): Target | undefined => {
    if (edge.to._tag === "End") {
      return edge.to;
    }
    const step = resolved.get(edge.to.id);
    return step === undefined ? undefined : { _tag: "Step", step };
  };
  for (const edge of recipe.edges) {
    const at: Place = { _tag: "Edge", from: edge.from, on: edge.on };
    errors.push(...unknownStep(edge.from, at));
    if (finallyIds.has(edge.from)) {
      errors.push({ _tag: "FinallyStepHasEdge", step: edge.from });
    }
    if (edge.to._tag === "Step") {
      errors.push(...unknownStep(edge.to.id, at));
      if (finallyIds.has(edge.to.id)) {
        errors.push({ _tag: "FinallyStepHasEdge", step: edge.to.id });
      }
    }
    const from = nodes.get(edge.from);
    const block = from === undefined ? undefined : blockOf(from);
    if (block !== undefined && !outcomesOf(block.kind).includes(edge.on)) {
      errors.push({
        _tag: "OutcomeDoesNotFitKind",
        from: edge.from,
        on: edge.on,
        kind: block.kind,
      });
    }
    const outgoing = edges.get(edge.from) ?? new Map<Outcome, Target>();
    edges.set(edge.from, outgoing);
    if (outgoing.has(edge.on)) {
      errors.push({ _tag: "DuplicateEdge", from: edge.from, on: edge.on });
    }
    const target = targetOf(edge);
    if (target !== undefined) {
      outgoing.set(edge.on, target);
    }
  }

  // Every step that is not a `finally` step is reached from `start`, following the edges.
  const reached = new Set<StepId>();
  const queue = nodes.has(recipe.start) ? [recipe.start] : [];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (!reached.has(next)) {
      reached.add(next);
      const from = next;
      queue.push(
        ...recipe.edges.flatMap((edge) =>
          edge.from === from && edge.to._tag === "Step" && nodes.has(edge.to.id)
            ? [edge.to.id]
            : [],
        ),
      );
    }
  }
  if (nodes.has(recipe.start)) {
    for (const node of recipe.nodes) {
      if (!reached.has(node.id) && !finallyIds.has(node.id)) {
        errors.push({ _tag: "Unreachable", step: node.id });
      }
    }
  }

  const invariantErrors = (invariant: InvariantRef, index: number): Errors => {
    const at: Place = { _tag: "Invariant", index, rule: invariant.rule };
    switch (invariant.rule) {
      case "NeverWritten":
      case "NoWriteBeforeApproval": {
        return unknownInput(invariant.input, at);
      }
      case "CleanedUp": {
        return unknownOutput(invariant.step, invariant.output, at);
      }
      case "RequiredForSuccess": {
        return unknownStep(invariant.step, at);
      }
      case "AfterFailure": {
        return [...unknownStep(invariant.step, at), ...unknownStep(invariant.then, at)];
      }
      case "DestroysOnlyApproved": {
        const gate = nodes.get(invariant.gate);
        const block = gate === undefined ? undefined : blockOf(gate);
        // Only a gate shows a person what will be destroyed.
        return block !== undefined && block.kind !== "Gate"
          ? [{ _tag: "InvariantGateIsNotGate", step: invariant.gate, at }]
          : unknownStep(invariant.gate, at);
      }
      case "OnlyAfter": {
        return [invariant.step, ...invariant.requires].flatMap((step) => unknownStep(step, at));
      }
    }
  };
  errors.push(...recipe.invariants.flatMap(invariantErrors));

  const start = resolved.get(recipe.start);
  if (errors.length > 0 || start === undefined) {
    return Result.fail(errors);
  }
  const steps = [...resolved.values()];
  return Result.succeed({
    recipe,
    start,
    main: steps.filter((step) => step.track === "Main"),
    finally: recipe.finally.flatMap((id) => {
      const step = resolved.get(id);
      return step === undefined ? [] : [step];
    }),
    edges,
  });
};
