import { blockSpecs } from "@aemeth/blocks";
import type { BlockSpec } from "@aemeth/core";
import { decodeRecipe, validateDocument } from "@aemeth/core";
import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";
import committedJsonSchema from "../recipe.schema.json" with { type: "json" };
import { recipeJsonSchema, recipeJsonSchemaText } from "./index";

// Every recipe file in the package, keyed by its path from this folder.
const files = import.meta.glob<unknown>("../*.recipe.json", { eager: true, import: "default" });
const recipes = Object.entries(files).map(([path, document]) => ({
  name: path.replace("../", ""),
  document,
}));

const blocks = Result.getOrThrow(blockSpecs);

/** What stops a recipe document from being published, as the validator reports it, or nothing. */
const failureOf = (document: unknown): string => {
  const result = validateDocument(document, blocks);
  return Result.isFailure(result) ? JSON.stringify(result.failure, undefined, 2) : "valid";
};

describe("recipe files", () => {
  it("are the six recipes of docs/recipes.md", () => {
    expect(recipes.map((recipe) => recipe.name).toSorted()).toEqual([
      "artifacts-pipeline.recipe.json",
      "environment-cleanup.recipe.json",
      "gradual-release.recipe.json",
      "restore-drill.recipe.json",
      "schema-migration.recipe.json",
      "secret-rotation.recipe.json",
    ]);
  });

  describe.each(recipes)("$name", ({ document, name }) => {
    it("decodes as a Recipe, with no unknown field", () => {
      const result = decodeRecipe(document);
      expect(Result.isSuccess(result) ? "decoded" : String(result.failure)).toBe("decoded");
    });

    it("is named after its id and points at the JSON Schema", () => {
      const recipe = Result.getOrThrow(decodeRecipe(document));
      expect(name).toBe(`${recipe.id}.recipe.json`);
      expect(recipe.$schema).toBe("./recipe.schema.json");
    });

    it("passes the validator: structure, types, every path and every invariant", () => {
      expect(failureOf(document)).toBe("valid");
    });
  });

  it("uses every declared block, directly or as an undo", () => {
    const used = new Set<string>(
      recipes.flatMap(({ document }) =>
        Result.getOrThrow(decodeRecipe(document)).nodes.map(
          (step) => `${step.block}@${step.version}`,
        ),
      ),
    );
    const keyOf = (spec: BlockSpec) => `${spec.id}@${spec.version}`;
    const undoOf = new Set<string>(
      blocks.flatMap((spec) =>
        spec.undo._tag === "Undo" ? [`${spec.undo.block}@${spec.undo.version}`] : [],
      ),
    );
    expect(
      blocks.map(keyOf).filter((blockKey) => !used.has(blockKey) && !undoOf.has(blockKey)),
    ).toEqual([]);
  });
});

describe("recipe.schema.json", () => {
  it("is what the Recipe Schema generates now", () => {
    // If this fails, run `bun run --filter @aemeth/recipes generate`.
    expect(committedJsonSchema).toEqual(recipeJsonSchema());
  });

  it("is a standalone draft 2020-12 document", () => {
    const schema = recipeJsonSchema();
    expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema["$ref"]).toBe("#/$defs/Recipe");
    expect(Object.keys(schema)).toContain("$defs");
  });

  it("is written as indented JSON with a final newline", () => {
    const text = recipeJsonSchemaText();
    expect(JSON.parse(text)).toEqual(recipeJsonSchema());
    expect(text.startsWith('{\n  "$schema"')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
  });
});
