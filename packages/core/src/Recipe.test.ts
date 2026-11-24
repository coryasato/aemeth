import { describe, expect, it } from "@effect/vitest";
import type { Schema } from "effect";
import { Result } from "effect";
import { decodeRecipe } from "./index";

const accepts = (value: unknown): boolean => Result.isSuccess(decodeRecipe(value));

const database = { _tag: "Resource", kind: "cloudflare.d1.database" };

/** Uses every binding, edge target, outcome, for-each policy and invariant rule. */
const recipe = {
  $schema: "./recipe.schema.json",
  format: 1,
  id: "restore-drill",
  version: 1,
  title: "Restore drill",
  description: "Proves that a backup can be restored.",
  start: "export",
  inputs: {
    production: { type: database },
    tables: { type: { _tag: "List", item: { _tag: "Text" } } },
  },
  nodes: [
    {
      _tag: "Step",
      id: "export",
      block: "d1.exportDatabase",
      version: 1,
      inputs: {
        database: { _tag: "RecipeInput", name: "production" },
        label: { _tag: "Literal", value: "drill" },
        limit: { _tag: "Literal", value: 10 },
        strict: { _tag: "Literal", value: true },
        tables: { _tag: "Literal", value: ["a", ["b"]] },
        options: { _tag: "Literal", value: { depth: 1.5, nested: { on: false } } },
      },
    },
    {
      _tag: "Step",
      id: "approve",
      block: "gate.approve",
      version: 2,
      inputs: { export: { _tag: "StepOutput", step: "export", output: "export" } },
    },
    {
      _tag: "Step",
      id: "check",
      block: "d1.checkTable",
      version: 1,
      inputs: { table: { _tag: "ForEachItem" } },
      forEach: { over: { _tag: "RecipeInput", name: "tables" }, onItemFailure: "Continue" },
    },
    {
      _tag: "Step",
      id: "checkAgain",
      block: "d1.checkTable",
      version: 1,
      inputs: { table: { _tag: "ForEachItem" } },
      forEach: { over: { _tag: "RecipeInput", name: "tables" }, onItemFailure: "Stop" },
    },
    {
      _tag: "Step",
      id: "record",
      block: "record.result",
      version: 1,
      inputs: { export: { _tag: "OptionalStepOutput", step: "export", output: "export" } },
    },
  ],
  edges: [
    { from: "export", on: "Succeeded", to: { _tag: "Step", id: "approve" } },
    { from: "export", on: "Failed", to: { _tag: "End", result: "Failed", undo: "Skip" } },
    { from: "approve", on: "Approved", to: { _tag: "Step", id: "check" } },
    { from: "approve", on: "Denied", to: { _tag: "End", result: "Succeeded" } },
    { from: "check", on: "Failed", to: { _tag: "End", result: "Failed", undo: "Run" } },
  ],
  finally: ["record"],
  invariants: [
    { rule: "NeverWritten", input: "production" },
    { rule: "CleanedUp", step: "export", output: "export" },
    { rule: "RequiredForSuccess", step: "check" },
    { rule: "NoWriteBeforeApproval", input: "production" },
    { rule: "AfterFailure", step: "check", then: "record" },
    { rule: "DestroysOnlyApproved", gate: "approve" },
    { rule: "OnlyAfter", step: "check", requires: ["export", "approve"] },
  ],
};

type Fields = { readonly [field: string]: Schema.Json };
const [exportStep] = recipe.nodes;
const withStep = (step: Fields) => ({ ...recipe, nodes: [{ ...exportStep, ...step }] });
const withEdge = (edge: Fields) => ({ ...recipe, edges: [{ ...recipe.edges[0], ...edge }] });
const withInvariant = (invariant: Fields) => ({ ...recipe, invariants: [invariant] });
const without = (key: keyof typeof recipe) =>
  Object.fromEntries(Object.entries(recipe).filter(([name]) => name !== key));

describe("decodeRecipe", () => {
  it("decodes a recipe unchanged", () => {
    expect(Result.getOrThrow(decodeRecipe(recipe))).toEqual(recipe);
  });

  it("does not need $schema", () => {
    expect(accepts(without("$schema"))).toBe(true);
  });

  it.each([
    "format",
    "id",
    "version",
    "title",
    "description",
    "start",
    "inputs",
    "nodes",
    "edges",
    "finally",
    "invariants",
  ] as const)("rejects a recipe with no %s", (key) => {
    expect(accepts(without(key))).toBe(false);
  });

  it.each([
    ["an unknown field", { ...recipe, owner: "someone" }],
    ["a $schema that is not text", { ...recipe, $schema: 1 }],
    ["another format", { ...recipe, format: 2 }],
    ["a bad id", { ...recipe, id: "Restore Drill" }],
    ["version 0", { ...recipe, version: 0 }],
    ["an empty title", { ...recipe, title: "" }],
    ["an empty description", { ...recipe, description: "" }],
    ["a bad start", { ...recipe, start: "Export" }],
    [
      "an input name that is not camel case",
      { ...recipe, inputs: { "The DB": { type: database } } },
    ],
    [
      "an input with an unknown field",
      { ...recipe, inputs: { db: { type: database, secret: true } } },
    ],
    ["an input with an unknown type", { ...recipe, inputs: { db: { type: { _tag: "Float" } } } }],
    ["a node that is not a step", withStep({ _tag: "Note" })],
    ["a step with an unknown field", withStep({ retries: 3 })],
    ["a step with a bad id", withStep({ id: "Bad Id" })],
    ["a step with a bad block", withStep({ block: "export" })],
    ["a step with version 0", withStep({ version: 0 })],
    [
      "a step input name that is not camel case",
      withStep({ inputs: { "a b": { _tag: "ForEachItem" } } }),
    ],
    ["an unknown binding", withStep({ inputs: { database: { _tag: "Environment", name: "DB" } } })],
    [
      "a binding with an unknown field",
      withStep({ inputs: { database: { _tag: "ForEachItem", index: 0 } } }),
    ],
    ["a literal of null", withStep({ inputs: { database: { _tag: "Literal", value: null } } })],
    [
      "a literal holding null",
      withStep({ inputs: { database: { _tag: "Literal", value: [null] } } }),
    ],
    [
      "a for-each with an unknown policy",
      withStep({ forEach: { over: { _tag: "ForEachItem" }, onItemFailure: "Retry" } }),
    ],
    ["a for-each with no list", withStep({ forEach: { onItemFailure: "Stop" } })],
    [
      "a for-each with an unknown field",
      withStep({ forEach: { over: { _tag: "ForEachItem" }, onItemFailure: "Stop", parallel: 2 } }),
    ],
    ["an edge on an unknown outcome", withEdge({ on: "Skipped" })],
    ["an edge from a bad id", withEdge({ from: "Bad Id" })],
    ["an edge with an unknown field", withEdge({ label: "next" })],
    ["an edge to an unknown target", withEdge({ to: { _tag: "Start" } })],
    ["an edge to a bad id", withEdge({ to: { _tag: "Step", id: "Bad Id" } })],
    [
      "an end with an unknown result",
      withEdge({ to: { _tag: "End", result: "Cancelled", undo: "Run" } }),
    ],
    [
      "an end with an unknown undo",
      withEdge({ to: { _tag: "End", result: "Failed", undo: "Maybe" } }),
    ],
    [
      "an end that does not say whether undo runs",
      withEdge({ to: { _tag: "End", result: "Failed" } }),
    ],
    [
      "a successful end that skips undo",
      withEdge({ to: { _tag: "End", result: "Succeeded", undo: "Skip" } }),
    ],
    [
      "a successful end that runs undo",
      withEdge({ to: { _tag: "End", result: "Succeeded", undo: "Run" } }),
    ],
    ["an empty title of spaces", { ...recipe, title: "   " }],
    ["a finally entry that is not a step id", { ...recipe, finally: ["Bad Id"] }],
    ["an unknown rule", withInvariant({ rule: "AlwaysFine" })],
    [
      "a rule with an unknown field",
      withInvariant({ rule: "RequiredForSuccess", step: "check", strict: true }),
    ],
    ["a rule with a missing argument", withInvariant({ rule: "CleanedUp", step: "export" })],
    [
      "OnlyAfter that requires nothing",
      withInvariant({ rule: "OnlyAfter", step: "check", requires: [] }),
    ],
  ])("rejects %s", (_, document) => {
    expect(accepts(document)).toBe(false);
  });
});
