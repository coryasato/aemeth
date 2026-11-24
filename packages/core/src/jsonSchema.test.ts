import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { BlockSpec, Recipe } from "./index";

// An `identifier` annotation is what turns a Schema into a named `$defs` entry.
const definitions = (schema: Schema.Constraint): ReadonlyArray<string> =>
  Object.keys(
    Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }).definitions,
  ).toSorted();

describe("generated JSON Schema", () => {
  it("names every part of a recipe", () => {
    expect(definitions(Recipe)).toEqual([
      "Binding",
      "BlockId",
      "DataType",
      "Edge",
      "EdgeTarget",
      "ForEach",
      "InvariantRef",
      "LiteralValue",
      "Name",
      "Outcome",
      "Prose",
      "Recipe",
      "RecipeId",
      "RecipeInput",
      "ResourceKind",
      "Step",
      "StepId",
      "Version",
    ]);
  });

  it("names every part of a block declaration", () => {
    expect(definitions(BlockSpec)).toEqual([
      "BlockEffect",
      "BlockId",
      "BlockInput",
      "BlockKind",
      "BlockSpec",
      "BlockUndo",
      "DataType",
      "Lifetime",
      "Name",
      "Prose",
      "ResourceKind",
      "Version",
    ]);
  });

  it("keeps the pattern that stops a title of spaces", () => {
    expect(Schema.toJsonSchemaDocument(Recipe).definitions["Prose"]).toEqual({
      type: "string",
      pattern: String.raw`\S`,
      maxLength: 2000,
    });
  });

  it("keeps every id pattern", () => {
    const { definitions: defs } = Schema.toJsonSchemaDocument(Recipe);
    expect(["StepId", "Name", "BlockId", "ResourceKind", "RecipeId"].map((id) => defs[id])).toEqual(
      [
        { type: "string", pattern: "^[a-z][a-zA-Z0-9]*$", maxLength: 64 },
        { type: "string", pattern: "^[a-z][a-zA-Z0-9]*$", maxLength: 64 },
        {
          type: "string",
          pattern: String.raw`^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$`,
          maxLength: 64,
        },
        {
          type: "string",
          pattern: String.raw`^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$`,
          maxLength: 64,
        },
        { type: "string", pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", maxLength: 64 },
      ],
    );
  });
});
