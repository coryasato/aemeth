import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { limits, Recipe, validate, validateDocument } from "../index";
import { checkStructure } from "./structure";
import {
  block,
  chain,
  database,
  edge,
  fromRecipe,
  literal,
  noUndo,
  recipe,
  required,
  step,
  writes,
} from "../testing/build";

const catalog = [
  block("t.act"),
  block("t.write", {
    inputs: { target: required(database) },
    effects: [writes("target")],
    undo: noUndo,
  }),
];

const encode = Schema.encodeSync(Recipe);
const tagOf = (result: ReturnType<typeof validate>) =>
  Result.isFailure(result) ? result.failure._tag : "Valid";

describe("validate", () => {
  it("returns the recipe and every path of a recipe that passes", () => {
    const document = recipe({ nodes: [step("first", "t.act")] });
    const result = validate(document, catalog);
    expect(result).toEqual(
      Result.succeed({
        recipe: document,
        resolved: Result.getOrThrow(checkStructure(document, catalog)),
        paths: [
          { entries: [], main: { result: "Cancelled" }, result: "Cancelled" },
          {
            entries: [{ phase: "Main", step: "first", outcome: "Succeeded" }],
            main: { result: "Succeeded" },
            result: "Succeeded",
          },
          {
            entries: [{ phase: "Main", step: "first", outcome: "Failed" }],
            main: { result: "Failed", undo: "Run" },
            result: "Failed",
          },
        ],
      }),
    );
  });

  // One recipe that is wrong at every stage. Repairing the earliest fault each time shows the
  // order of the stages, and that a later stage does not run until the earlier ones pass.
  const nodes = [
    // Wiring: a literal for a resource. Invariants: a write with no undo and no approval.
    step("first", "t.write", { target: literal("production") }),
    step("second", "t.act"),
    step("third", "t.act"),
  ];
  const cycle = [...chain("first", "second", "third"), edge("third", "Failed", "second")];
  const broken = {
    inputs: { production: { type: database } },
    nodes,
    // Structure: `second` is used twice as an edge's source on one outcome. Size: three steps.
    edges: [...cycle, edge("second", "Succeeded", "third")],
  };
  const tight = { nodes: 2, edgesIntoNode: 8, paths: 2 };

  it.each([
    ["Size", broken, tight],
    ["Structure", broken, { ...tight, nodes: 3 }],
    ["Cycle", { ...broken, edges: cycle }, { ...tight, nodes: 3 }],
    ["Wiring", { ...broken, edges: chain("first", "second", "third") }, { ...tight, nodes: 3 }],
  ])("stops at %s when that is the earliest stage to fail", (stage, parts, caps) => {
    expect(tagOf(validate(recipe(parts), catalog, caps))).toBe(stage);
  });

  const wired = {
    ...broken,
    nodes: [step("first", "t.write", { target: fromRecipe("production") }), ...nodes.slice(1)],
    edges: chain("first", "second", "third"),
  };

  it("stops at the path cap before any invariant is checked", () => {
    expect(tagOf(validate(recipe(wired), catalog, { ...tight, nodes: 3 }))).toBe("TooManyPaths");
  });

  it("checks the invariants last, with the default caps when none are given", () => {
    expect(tagOf(validate(recipe(wired), catalog))).toBe("Invariants");
    expect(tagOf(validate(recipe(wired), catalog, limits))).toBe("Invariants");
  });
});

describe("validateDocument", () => {
  const document = encode(recipe({ nodes: [step("first", "t.act")] }));

  it("decodes and validates a recipe document", () => {
    expect(validateDocument(document, catalog)).toEqual(
      validate(recipe({ nodes: [step("first", "t.act")] }), catalog),
    );
    expect(Result.isSuccess(validateDocument(document, catalog))).toBe(true);
  });

  it("reports a document that is not a recipe, with the decoder's message", () => {
    const result = validateDocument({ ...document, version: 0 }, catalog);
    const failure = Result.isFailure(result) ? result.failure : undefined;
    expect(failure?._tag).toBe("Decode");
    expect(failure?._tag === "Decode" ? failure.message : "").toContain('["version"]');
  });

  it("rejects a field the Schema does not have", () => {
    const result = validateDocument({ ...document, owner: "me" }, catalog);
    expect(Result.isFailure(result) && result.failure._tag).toBe("Decode");
  });

  it("goes on to the later stages, with the caps it is given", () => {
    const unknownBlock = { ...document, nodes: [step("first", "t.unknown")] };
    expect(validateDocument(unknownBlock, catalog)).toEqual(
      Result.fail({
        _tag: "Structure",
        errors: [{ _tag: "UnknownBlock", step: "first", block: "t.unknown", version: 1 }],
      }),
    );
    expect(validateDocument(document, catalog, { ...limits, paths: 2 })).toEqual(
      Result.fail({ _tag: "TooManyPaths", cap: 2 }),
    );
  });
});
