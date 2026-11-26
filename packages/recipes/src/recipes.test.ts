import { blockSpecs } from "@aemeth/blocks";
import type { BlockSpec } from "@aemeth/core";
import { decodeRecipe, followsRecipe, validateDocument } from "@aemeth/core";
import { play, scriptOf } from "@aemeth/core/testing";
import { describe, expect, it } from "@effect/vitest";
import { Option, Result } from "effect";
import committedJsonSchema from "../recipe.schema.json" with { type: "json" };
import { recipeFiles, recipeJsonSchema, recipeJsonSchemaText } from "./index";

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
  // The six of docs/recipes.md, and the restore drill as it runs against Aemeth itself, with
  // the check on the run archive (M2 decision 13).
  it("are the six recipes of docs/recipes.md and the drill of Aemeth's own index", () => {
    expect(recipes.map((recipe) => recipe.name).toSorted()).toEqual([
      "aemeth-restore-drill.recipe.json",
      "artifacts-pipeline.recipe.json",
      "environment-cleanup.recipe.json",
      "gradual-release.recipe.json",
      "restore-drill.recipe.json",
      "schema-migration.recipe.json",
      "secret-rotation.recipe.json",
    ]);
  });

  // The engine's Worker is bundled with `recipeFiles`, which names each file: a recipe added to
  // the folder and not to that list would never reach the engine.
  it("are all in the list the engine is bundled with, and nothing else is", () => {
    // Both sides by file name: a recipe file is named after its id.
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect(
      recipeFiles.toSorted((a, b) => byName(`${a.id}.recipe.json`, `${b.id}.recipe.json`)),
    ).toEqual(recipes.toSorted((a, b) => byName(a.name, b.name)).map((recipe) => recipe.document));
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

    // The engine's half of the same claim (M2 B2): `decide`, told how each step of a path turns
    // out, takes that path and no other, and the run ends in the path's result.
    it("is run by `decide` along every path the validator enumerates", () => {
      const valid = Result.getOrThrow(validateDocument(document, blocks));
      expect(valid.paths.length).toBeGreaterThan(0);
      for (const path of valid.paths) {
        const played = play(valid, scriptOf(valid, path));
        expect(played._tag === "Stuck" ? played.why : played.state._tag).toBe(path.result);
        expect(followsRecipe(valid, played.log)).toEqual(Result.succeed(Option.some(path)));
      }
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
