import type { StepId } from "../ids";
import type { Recipe } from "../Recipe";
import type { Limits, SizeError } from "./model";

/**
 * The size stage of validation: the recipe is within the node cap and the cap on edges into one
 * node. It runs first, before anything is looked up, so that no later stage does work on a
 * document larger than the caps. An edge is counted by the step it names, whether or not that
 * step exists.
 */
export const checkSize = (recipe: Recipe, limits: Limits): ReadonlyArray<SizeError> => {
  const errors: Array<SizeError> = [];
  if (recipe.nodes.length > limits.nodes) {
    errors.push({ _tag: "TooManyNodes", count: recipe.nodes.length, cap: limits.nodes });
  }
  // One pass over the edges, so an oversized document costs no more than reading it.
  const into = new Map<StepId, number>();
  for (const edge of recipe.edges) {
    if (edge.to._tag === "Step") {
      into.set(edge.to.id, (into.get(edge.to.id) ?? 0) + 1);
    }
  }
  for (const [step, count] of into) {
    if (count > limits.edgesIntoNode) {
      errors.push({ _tag: "TooManyEdgesInto", step, count, cap: limits.edgesIntoNode });
    }
  }
  return errors;
};
