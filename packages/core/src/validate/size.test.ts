import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";
import { limits, validate } from "../index";
import { block, edge, recipe, step } from "../testing/build";

const catalog = [block("t.act")];

const names = (count: number) => Array.from({ length: count }, (_, index) => `s${index}`);

/** A chain of `count` steps, each going to the next on success. */
const chainOf = (count: number) => {
  const ids = names(count);
  return recipe({
    start: "s0",
    nodes: ids.map((id) => step(id, "t.act")),
    edges: ids.slice(1).map((id, index) => edge(`s${index}`, "Succeeded", id)),
  });
};

/** `sources` steps in a chain, each also going to one `sink` when it fails. */
const fanIn = (sources: number) => {
  const ids = names(sources);
  return recipe({
    start: "s0",
    nodes: [...ids.map((id) => step(id, "t.act")), step("sink", "t.act")],
    edges: [
      ...ids.slice(1).map((id, index) => edge(`s${index}`, "Succeeded", id)),
      ...ids.map((id) => edge(id, "Failed", "sink")),
    ],
  });
};

// The path cap is lifted so that only the size stage can reject these.
const roomy = { ...limits, paths: 1_000_000 };

describe("size (stage 3)", () => {
  it("has the caps of decision 11", () => {
    expect(limits).toEqual({ nodes: 64, edgesIntoNode: 8, paths: 10_000 });
  });

  it("accepts a recipe of exactly the node cap", () => {
    expect(Result.isSuccess(validate(chainOf(64), catalog, roomy))).toBe(true);
  });

  it("reports a recipe one node over the cap", () => {
    expect(validate(chainOf(65), catalog, roomy)).toEqual(
      Result.fail({ _tag: "Size", errors: [{ _tag: "TooManyNodes", count: 65, cap: 64 }] }),
    );
  });

  it("accepts exactly the cap of edges into one node", () => {
    expect(Result.isSuccess(validate(fanIn(8), catalog, roomy))).toBe(true);
  });

  it("reports a node with one edge too many into it", () => {
    expect(validate(fanIn(9), catalog, roomy)).toEqual(
      Result.fail({
        _tag: "Size",
        errors: [{ _tag: "TooManyEdgesInto", step: "sink", count: 9, cap: 8 }],
      }),
    );
  });

  it("takes its caps from the limits it is given, and reports every error", () => {
    expect(validate(fanIn(3), catalog, { nodes: 2, edgesIntoNode: 2, paths: 100 })).toEqual(
      Result.fail({
        _tag: "Size",
        errors: [
          { _tag: "TooManyNodes", count: 4, cap: 2 },
          { _tag: "TooManyEdgesInto", step: "sink", count: 3, cap: 2 },
        ],
      }),
    );
  });

  it("does not count an edge to an end as an edge into a step", () => {
    const document = recipe({
      start: "s0",
      nodes: [step("s0", "t.act")],
      edges: [
        edge("s0", "Succeeded", { _tag: "End", result: "Succeeded" }),
        edge("s0", "Failed", { _tag: "End", result: "Failed", undo: "Run" }),
      ],
    });
    expect(Result.isSuccess(validate(document, catalog, { ...limits, edgesIntoNode: 0 }))).toBe(
      true,
    );
  });
});
