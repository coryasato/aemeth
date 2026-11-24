import { describe, expect, it } from "@effect/vitest";
import { Option, Result } from "effect";
import { limits, validate } from "../index";
import { generate, generatedCatalog, Picks } from "../testing/generate";
import { findCycle, topologicalOrder } from "./graph";

const runs = { arbitrary: { runs: 500 } };

type Graph = Record<string, ReadonlyArray<string>>;
const next = (graph: Graph) => (node: string) => graph[node] ?? [];
const cycleIn = (graph: Graph) => findCycle(Object.keys(graph), next(graph));

describe("findCycle", () => {
  it.each<[string, Graph]>([
    ["no nodes", {}],
    ["one node", { a: [] }],
    ["a chain", { a: ["b"], b: ["c"], c: [] }],
    ["a diamond", { a: ["b", "c"], b: ["d"], c: ["d"], d: [] }],
    ["two separate chains", { a: ["b"], b: [], c: ["d"], d: [] }],
    ["a node reached twice from one node", { a: ["b", "b"], b: [] }],
    ["a later node that leads into an earlier, finished part", { a: ["b"], b: [], c: ["a"] }],
  ])("finds none in %s", (_, graph) => {
    expect(cycleIn(graph)).toEqual(Option.none());
  });

  it.each<[string, Graph, ReadonlyArray<string>]>([
    ["a node with an edge to itself", { a: ["a"] }, ["a"]],
    ["two nodes", { a: ["b"], b: ["a"] }, ["a", "b"]],
    [
      "a cycle behind a chain, without the chain",
      { a: ["b"], b: ["c"], c: ["d"], d: ["b"] },
      ["b", "c", "d"],
    ],
    ["a cycle on the second branch", { a: ["b", "c"], b: [], c: ["d"], d: ["c"] }, ["c", "d"]],
    ["a cycle no earlier node leads to", { a: [], b: ["c"], c: ["b"] }, ["b", "c"]],
    [
      "a cycle among nodes that also reach a finished part",
      { a: [], b: ["a", "c"], c: ["b"] },
      ["b", "c"],
    ],
  ])("finds %s", (_, graph, cycle) => {
    expect(cycleIn(graph)).toEqual(Option.some(cycle));
  });
});

describe("topologicalOrder", () => {
  it.each<[string, Graph, ReadonlyArray<string>]>([
    ["one node", { a: [] }, ["a"]],
    ["a chain", { a: ["b"], b: ["c"], c: [] }, ["a", "b", "c"]],
    ["a diamond", { a: ["b", "c"], b: ["d"], c: ["d"], d: [] }, ["a", "c", "b", "d"]],
    ["a shortcut past a node", { a: ["c", "b"], b: ["c"], c: [] }, ["a", "b", "c"]],
    ["only what start reaches", { a: ["b"], b: [], z: ["a"] }, ["a", "b"]],
  ])("orders %s", (_, graph, order) => {
    expect(topologicalOrder("a", next(graph))).toEqual(order);
  });
});

describe("cycles (stage 4)", () => {
  const edgesOf = (recipe: ReturnType<typeof generate>["recipe"]) =>
    recipe.edges.flatMap((edge) => (edge.to._tag === "Step" ? [`${edge.from}>${edge.to.id}`] : []));
  let withFork = 0;
  let longCycle = 0;
  let selfLoop = 0;

  it.prop(
    "passes every generated acyclic recipe, and orders its steps along its edges",
    [Picks],
    ([picks]) => {
      const { main, recipe } = generate(picks);
      // It passes every stage up to the paths; only an invariant may reject it.
      const result = validate(recipe, generatedCatalog, { ...limits, paths: 1_000_000 });
      expect(["Valid", "Invariants"]).toContain(
        Result.isFailure(result) ? result.failure._tag : "Valid",
      );

      const graph: Graph = Object.fromEntries(
        main.map(({ id }) => [
          id,
          recipe.edges.flatMap((edge) =>
            edge.from === id && edge.to._tag === "Step" ? [edge.to.id] : [],
          ),
        ]),
      );
      const order = topologicalOrder("n0", next(graph));
      expect(order.toSorted()).toEqual(main.map(({ id }) => id).toSorted());
      for (const [from, targets] of Object.entries(graph)) {
        for (const to of targets) {
          expect(order.indexOf(from)).toBeLessThan(order.indexOf(to));
        }
        withFork += targets.length > 1 ? 1 : 0;
      }
    },
    runs,
  );

  it.prop(
    "finds the cycle in every generated recipe that has one, and never walks its paths",
    [Picks],
    ([picks]) => {
      const { recipe } = generate(picks, { cycle: true });
      // With a path cap of zero, a recipe that reached the path stage would be `TooManyPaths`.
      const result = validate(recipe, generatedCatalog, { ...limits, paths: 0 });
      const failure = Result.isFailure(result) ? result.failure : undefined;
      expect(failure?._tag).toBe("Cycle");
      const steps = failure?._tag === "Cycle" ? failure.steps : [];
      expect(steps.length).toBeGreaterThan(0);
      expect(new Set(steps).size).toBe(steps.length);
      // Each step on the cycle has an edge to the next, and the last to the first.
      const edges = new Set(edgesOf(recipe));
      for (const [index, from] of steps.entries()) {
        expect(edges).toContain(`${from}>${steps[(index + 1) % steps.length]}`);
      }
      longCycle += steps.length > 2 ? 1 : 0;
      selfLoop += steps.length === 1 ? 1 : 0;
    },
    runs,
  );

  it("reaches the path stage with the same cap when there is no cycle", () => {
    const { recipe } = generate([0]);
    expect(validate(recipe, generatedCatalog, { ...limits, paths: 0 })).toEqual(
      Result.fail({ _tag: "TooManyPaths", cap: 0 }),
    );
  });

  it("reached forks, cycles of one step and cycles of several", () => {
    expect(withFork).toBeGreaterThan(0);
    expect(selfLoop).toBeGreaterThan(0);
    expect(longCycle).toBeGreaterThan(0);
  });
});
