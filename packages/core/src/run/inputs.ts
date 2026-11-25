import type { Schema } from "effect";
import type { DataType } from "../DataType";
import type { Name } from "../ids";
import { namesOf, own } from "../ids";
import type { Recipe } from "../Recipe";
import { valueFits } from "../Value";

/** What is wrong with the values a run was asked to start with. */
export type InputProblem =
  | { readonly _tag: "InputMissing"; readonly name: Name }
  | { readonly _tag: "InputUnknown"; readonly name: string }
  | { readonly _tag: "InputDoesNotFit"; readonly name: Name; readonly expected: DataType };

/**
 * Checks the values a run is started with against the recipe's inputs: every input is given, each
 * value fits its type, and nothing else is given. Returns every problem; an empty list means the
 * run may start with them.
 */
export const inputProblems = (
  recipe: Recipe,
  inputs: { readonly [name: string]: Schema.Json },
): ReadonlyArray<InputProblem> => [
  ...namesOf(recipe.inputs).flatMap(([name, { type }]): Array<InputProblem> => {
    const given = own(inputs, name);
    if (given === undefined) {
      return [{ _tag: "InputMissing", name }];
    }
    return valueFits(type, given) ? [] : [{ _tag: "InputDoesNotFit", name, expected: type }];
  }),
  ...Object.keys(inputs).flatMap((name): Array<InputProblem> =>
    Object.hasOwn(recipe.inputs, name) ? [] : [{ _tag: "InputUnknown", name }],
  ),
];
