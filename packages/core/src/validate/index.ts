import { Option, Result } from "effect";
import type { BlockSpec } from "../BlockSpec";
import type { StepId } from "../ids";
import type { Recipe } from "../Recipe";
import { decodeRecipe } from "../Recipe";
import { findCycle } from "./graph";
import type {
  Limits,
  ResolvedRecipe,
  ResolvedStep,
  SizeError,
  StructureError,
  WiringError,
} from "./model";
import { limits as defaultLimits } from "./model";
import type { Path } from "./paths";
import { enumeratePaths, toPath } from "./paths";
import type { Violation } from "./rules";
import { checkInvariants } from "./rules";
import { checkSize } from "./size";
import { checkStructure } from "./structure";
import { viewOf } from "./view";
import { checkWiring } from "./wiring";

export type {
  Hop,
  Limits,
  Place,
  ResolvedBinding,
  ResolvedForEach,
  ResolvedInput,
  ResolvedRecipe,
  ResolvedStep,
  ResolvedUndo,
  SizeError,
  StructureError,
  Target,
  WiringError,
} from "./model";
export { limits } from "./model";
export type { CleanupOutcome, MainEnd, MainOutcome, Path, PathEntry, RunResult } from "./paths";
export type { AlwaysOnRule, RuleName, Violation } from "./rules";

/**
 * Why a recipe cannot be published. The stages run in order and each reports everything it
 * found; a later stage runs only when the earlier ones passed.
 */
export type ValidationFailure =
  | { readonly _tag: "Structure"; readonly errors: ReadonlyArray<StructureError> }
  | { readonly _tag: "Size"; readonly errors: ReadonlyArray<SizeError> }
  /** The steps on one cycle, in order. Nothing after this stage runs on a graph with a cycle. */
  | { readonly _tag: "Cycle"; readonly steps: ReadonlyArray<StepId> }
  | { readonly _tag: "Wiring"; readonly errors: ReadonlyArray<WiringError> }
  | { readonly _tag: "TooManyPaths"; readonly cap: number }
  | { readonly _tag: "Invariants"; readonly violations: ReadonlyArray<Violation> };

/**
 * A recipe that passed every stage, with every path a run of it could take. `resolved` is the
 * recipe with every name looked up: its steps hold their blocks, and its edges their targets, so
 * the engine never looks a name up (M2).
 */
export type ValidRecipe = {
  readonly recipe: Recipe;
  readonly resolved: ResolvedRecipe;
  readonly paths: ReadonlyArray<Path>;
};

/**
 * Validates a decoded recipe against the blocks it may use (stages 2 to 7). Checks size,
 * structure, cycles, types and references, then enumerates every path and runs every invariant on
 * each. Never throws.
 */
export const validate = (
  recipe: Recipe,
  blocks: ReadonlyArray<BlockSpec>,
  limits: Limits = defaultLimits,
): Result.Result<ValidRecipe, ValidationFailure> => {
  const sizeErrors = checkSize(recipe, limits);
  if (sizeErrors.length > 0) {
    return Result.fail({ _tag: "Size", errors: sizeErrors });
  }

  const structure = checkStructure(recipe, blocks);
  if (Result.isFailure(structure)) {
    return Result.fail({ _tag: "Structure", errors: structure.failure });
  }
  const resolved = structure.success;

  const successors = (step: ResolvedStep): ReadonlyArray<ResolvedStep> =>
    [...(resolved.edges.get(step.step.id)?.values() ?? [])].flatMap((target) =>
      target._tag === "Step" ? [target.step] : [],
    );
  const cycle = findCycle(resolved.main, successors);
  if (Option.isSome(cycle)) {
    return Result.fail({ _tag: "Cycle", steps: cycle.value.map((step) => step.step.id) });
  }

  const wiringErrors = checkWiring(resolved);
  if (wiringErrors.length > 0) {
    return Result.fail({ _tag: "Wiring", errors: wiringErrors });
  }

  const walked = enumeratePaths(resolved, limits.paths);
  if (Result.isFailure(walked)) {
    return Result.fail(walked.failure);
  }

  const violations = checkInvariants(recipe.invariants, walked.success.map(viewOf));
  if (violations.length > 0) {
    return Result.fail({ _tag: "Invariants", violations });
  }
  return Result.succeed({ recipe, resolved, paths: walked.success.map(toPath) });
};

/** A recipe document that is not a recipe at all (stage 1). */
export type DecodeFailure = { readonly _tag: "Decode"; readonly message: string };

/** Decodes a recipe document, rejecting unknown fields, then validates it (stages 1 to 7). */
export const validateDocument = (
  document: unknown,
  blocks: ReadonlyArray<BlockSpec>,
  limits: Limits = defaultLimits,
): Result.Result<ValidRecipe, DecodeFailure | ValidationFailure> => {
  const decoded = decodeRecipe(document);
  return Result.isFailure(decoded)
    ? Result.fail({ _tag: "Decode", message: String(decoded.failure) })
    : validate(decoded.success, blocks, limits);
};
