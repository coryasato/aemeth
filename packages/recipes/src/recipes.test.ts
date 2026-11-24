import { blockSpecs } from "@aemeth/blocks";
import type { Binding, BlockSpec, InvariantRef, Recipe } from "@aemeth/core";
import { decodeRecipe } from "@aemeth/core";
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

const catalog = new Map<string, BlockSpec>(
  Result.getOrThrow(blockSpecs).map((spec) => [`${spec.id}@${spec.version}`, spec]),
);

/**
 * What the recipe gets wrong about the blocks it uses and about its own names: step ids, recipe
 * inputs, and step outputs, wherever a binding, an edge or an invariant mentions one. It does not
 * check types, order or paths. A stand-in for the validator, which replaces it in M1 Part C.
 */
const wiringProblems = (recipe: Recipe): ReadonlyArray<string> => {
  const blockOf = new Map<string, BlockSpec | undefined>(
    recipe.nodes.map((step) => [step.id, catalog.get(`${step.block}@${step.version}`)]),
  );
  const noStep = (id: string) => (blockOf.has(id) ? [] : [`no step ${id}`]);
  const noInput = (name: string) =>
    Object.hasOwn(recipe.inputs, name) ? [] : [`no recipe input ${name}`];
  const noOutput = (step: string, output: string) => {
    const block = blockOf.get(step);
    return block === undefined || Object.hasOwn(block.outputs, output)
      ? noStep(step)
      : [`step ${step} has no output ${output}`];
  };
  const bindingProblems = (binding: Binding): ReadonlyArray<string> => {
    switch (binding._tag) {
      case "RecipeInput": {
        return noInput(binding.name);
      }
      case "StepOutput":
      case "OptionalStepOutput": {
        return noOutput(binding.step, binding.output);
      }
      case "ForEachItem":
      case "Literal": {
        return [];
      }
    }
  };
  const invariantProblems = (invariant: InvariantRef): ReadonlyArray<string> => {
    switch (invariant.rule) {
      case "NeverWritten":
      case "NoWriteBeforeApproval": {
        return noInput(invariant.input);
      }
      case "CleanedUp": {
        return noOutput(invariant.step, invariant.output);
      }
      case "RequiredForSuccess": {
        return noStep(invariant.step);
      }
      case "AfterFailure": {
        return [...noStep(invariant.step), ...noStep(invariant.then)];
      }
      case "DestroysOnlyApproved": {
        return noStep(invariant.gate);
      }
      case "OnlyAfter": {
        return [invariant.step, ...invariant.requires].flatMap(noStep);
      }
    }
  };
  const stepProblems = recipe.nodes.flatMap((step) => {
    const block = blockOf.get(step.id);
    if (block === undefined) {
      return [`${step.id}: no block ${step.block}@${step.version}`];
    }
    const bound = new Set<string>(Object.keys(step.inputs));
    return [
      ...[...bound].flatMap((name) =>
        Object.hasOwn(block.inputs, name) ? [] : [`${step.id}: no input ${name}`],
      ),
      ...Object.entries(block.inputs).flatMap(([name, input]) =>
        input._tag === "Required" && !bound.has(name) ? [`${step.id}: ${name} is not bound`] : [],
      ),
      ...[...Object.values(step.inputs), ...(step.forEach ? [step.forEach.over] : [])]
        .flatMap(bindingProblems)
        .map((problem) => `${step.id}: ${problem}`),
    ];
  });
  return [
    ...[recipe.start, ...recipe.finally].flatMap(noStep),
    ...recipe.edges.flatMap((edge) => [
      ...noStep(edge.from),
      ...(edge.to._tag === "Step" ? noStep(edge.to.id) : []),
    ]),
    ...stepProblems,
    ...recipe.invariants.flatMap(invariantProblems),
  ];
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

    it("uses declared blocks and names only steps, inputs and outputs that exist", () => {
      expect(wiringProblems(Result.getOrThrow(decodeRecipe(document)))).toEqual([]);
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
    const undoOf = new Set<string>(
      [...catalog.values()].flatMap((spec) =>
        spec.undo._tag === "Undo" ? [`${spec.undo.block}@${spec.undo.version}`] : [],
      ),
    );
    expect([...catalog.keys()].filter((key) => !used.has(key) && !undoOf.has(key))).toEqual([]);
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
