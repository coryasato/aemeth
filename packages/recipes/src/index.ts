import { Recipe } from "@aemeth/core";
import type { JsonSchema } from "effect";
import { Schema } from "effect";

export { recipeFiles } from "./files";

/**
 * The JSON Schema for a recipe file, generated from the `Recipe` Schema as a standalone
 * draft 2020-12 document. It is for editors and outside tools: the Effect decoder stays the
 * authority on what a recipe is.
 *
 * `onExcessProperty: "error"` matches `decodeRecipe`, so both reject unknown fields.
 */
export const recipeJsonSchema = (): JsonSchema.JsonSchema => {
  const { definitions, schema } = Schema.toJsonSchemaDocument(Recipe, {
    onExcessProperty: "error",
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Aemeth recipe",
    ...schema,
    $defs: definitions,
  };
};

/** The text of `recipe.schema.json`. */
export const recipeJsonSchemaText = (): string =>
  `${JSON.stringify(recipeJsonSchema(), null, 2)}\n`;
