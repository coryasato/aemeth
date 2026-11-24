import { describe, expect, it } from "@effect/vitest";
import { Option, Result } from "effect";
import type { BlockSpec, Path, Recipe } from "../index";
import { limits, validate } from "../index";
import {
  block,
  chain,
  database,
  each,
  edge,
  failed,
  fromInput,
  fromRecipe,
  item,
  list,
  noUndo,
  recipe,
  required,
  show,
  step,
  succeeded,
  undoWith,
  writes,
} from "../testing/build";
import type { Generated } from "../testing/generate";
import { generate, generatedCatalog, Picks } from "../testing/generate";
import type { CleanupOutcomes } from "./paths";
import { enumeratePaths, toPath } from "./paths";
import { checkInvariants } from "./rules";
import { checkStructure } from "./structure";
import { viewOf } from "./view";
import { guaranteedBefore } from "./wiring";

const catalog = [
  block("t.act"),
  block("t.gate", { kind: "Gate" }),
  block("t.undoable", { undo: undoWith("t.act") }),
  block("t.each", {
    inputs: { thing: required(database) },
    effects: [writes("thing")],
    undo: undoWith("t.uneach", { thing: fromInput("thing") }),
  }),
  block("t.uneach", {
    inputs: { thing: required(database) },
    effects: [writes("thing")],
    undo: noUndo,
  }),
  block("t.eachPlain", { inputs: { thing: required(database) } }),
];

const roomy = { ...limits, paths: 1_000_000 };

const pathsOf = (
  document: Recipe,
  blocks: ReadonlyArray<BlockSpec> = catalog,
): ReadonlyArray<Path> => Result.getOrThrow(validate(document, blocks, roomy)).paths;

/** The paths of a recipe whatever its invariants say, straight from stages 2 and 6. */
const walkedOf = (document: Recipe, outcomes: CleanupOutcomes = "OneFailure", cap = roomy.paths) =>
  enumeratePaths(Result.getOrThrow(checkStructure(document, generatedCatalog)), cap, outcomes);
const generatedPaths = (document: Recipe): ReadonlyArray<Path> =>
  Result.getOrThrow(walkedOf(document)).map(toPath);
const shown = (document: Recipe) => pathsOf(document).map(show);

const things = { things: { type: list(database) } };
const forEach = (id: string, blockId: string, policy = "Continue") =>
  step(id, blockId, { thing: item }, each(fromRecipe("things"), policy));

describe("paths (stage 6)", () => {
  it("gives one step a path for a cancel before it, for success and for failure", () => {
    const document = recipe({ nodes: [step("first", "t.act")] });
    expect(pathsOf(document)).toEqual([
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
    ]);
  });

  it("gives a gate a cancellation point while it waits, and ends a denial as a failure", () => {
    const document = recipe({ nodes: [step("first", "t.gate")] });
    expect(shown(document)).toEqual([
      "=> Cancelled",
      "first:CancelledWaiting => Cancelled",
      "first:Approved => Succeeded",
      "first:Denied => Failed",
    ]);
  });

  it("gives a for-each one entry, a cancellation point partway, and an undo of its succeeded items", () => {
    const document = recipe({ inputs: things, nodes: [forEach("first", "t.each")] });
    expect(shown(document)).toEqual([
      "=> Cancelled",
      "first:CancelledPartway undo first:Succeeded => Cancelled",
      "first:CancelledPartway undo first:Failed => NeedsAttention",
      "first:Succeeded => Succeeded",
      "first:Failed undo first:Succeeded => Failed",
      "first:Failed undo first:Failed => NeedsAttention",
    ]);
  });

  it.each(["Stop", "Continue"])("walks a for-each the same way under %s", (policy) => {
    const document = recipe({ inputs: things, nodes: [forEach("first", "t.eachPlain", policy)] });
    expect(shown(document)).toEqual([
      "=> Cancelled",
      "first:CancelledPartway => Cancelled",
      "first:Succeeded => Succeeded",
      "first:Failed => Failed",
    ]);
  });

  it("does not undo a step that failed or was not reached, unless it is a for-each", () => {
    const document = recipe({ nodes: [step("first", "t.undoable")] });
    expect(shown(document)).toEqual([
      "=> Cancelled",
      "first:Succeeded => Succeeded",
      "first:Failed => Failed",
    ]);
  });

  it("undoes what succeeded in reverse order, after a failure and after a cancel", () => {
    const document = recipe({
      start: "a",
      nodes: [
        step("a", "t.undoable"),
        step("plain", "t.act"),
        step("b", "t.undoable"),
        step("c", "t.act"),
      ],
      edges: chain("a", "plain", "b", "c"),
    });
    expect(shown(document)).toEqual([
      "=> Cancelled",
      "a:Succeeded undo a:Succeeded => Cancelled",
      "a:Succeeded undo a:Failed => NeedsAttention",
      "a:Succeeded plain:Succeeded undo a:Succeeded => Cancelled",
      "a:Succeeded plain:Succeeded undo a:Failed => NeedsAttention",
      "a:Succeeded plain:Succeeded b:Succeeded undo b:Succeeded undo a:Succeeded => Cancelled",
      "a:Succeeded plain:Succeeded b:Succeeded undo b:Failed undo a:Succeeded => NeedsAttention",
      "a:Succeeded plain:Succeeded b:Succeeded undo b:Succeeded undo a:Failed => NeedsAttention",
      "a:Succeeded plain:Succeeded b:Succeeded c:Succeeded => Succeeded",
      "a:Succeeded plain:Succeeded b:Succeeded c:Failed undo b:Succeeded undo a:Succeeded => Failed",
      "a:Succeeded plain:Succeeded b:Succeeded c:Failed undo b:Failed undo a:Succeeded => NeedsAttention",
      "a:Succeeded plain:Succeeded b:Succeeded c:Failed undo b:Succeeded undo a:Failed => NeedsAttention",
      "a:Succeeded plain:Succeeded b:Failed undo a:Succeeded => Failed",
      "a:Succeeded plain:Succeeded b:Failed undo a:Failed => NeedsAttention",
      "a:Succeeded plain:Failed undo a:Succeeded => Failed",
      "a:Succeeded plain:Failed undo a:Failed => NeedsAttention",
      "a:Failed => Failed",
    ]);
  });

  it("runs every finally step on every path, in order, and goes on after one fails", () => {
    const document = recipe({
      nodes: [step("first", "t.act"), step("x", "t.act"), step("y", "t.act")],
      finally: ["y", "x"],
    });
    // One path where both succeed, and one for each failing alone: the other still runs.
    const clean = "finally y:Succeeded finally x:Succeeded";
    const needAttention = [
      "finally y:Failed finally x:Succeeded => NeedsAttention",
      "finally y:Succeeded finally x:Failed => NeedsAttention",
    ];
    expect(shown(document)).toEqual([
      `${clean} => Cancelled`,
      ...needAttention,
      `first:Succeeded ${clean} => Succeeded`,
      ...needAttention.map((ending) => `first:Succeeded ${ending}`),
      `first:Failed ${clean} => Failed`,
      ...needAttention.map((ending) => `first:Failed ${ending}`),
    ]);
  });

  it("fails one cleanup at a time across undo and finally together", () => {
    const document = recipe({
      start: "a",
      nodes: [
        step("a", "t.undoable"),
        step("b", "t.undoable"),
        step("c", "t.act"),
        step("last", "t.act"),
      ],
      edges: [...chain("a", "b", "c"), edge("c", "Succeeded", failed("Run"))],
      finally: ["last"],
    });
    expect(shown(document).filter((line) => line.includes("c:Succeeded"))).toEqual([
      "a:Succeeded b:Succeeded c:Succeeded undo b:Succeeded undo a:Succeeded finally last:Succeeded => Failed",
      "a:Succeeded b:Succeeded c:Succeeded undo b:Failed undo a:Succeeded finally last:Succeeded => NeedsAttention",
      "a:Succeeded b:Succeeded c:Succeeded undo b:Succeeded undo a:Failed finally last:Succeeded => NeedsAttention",
      "a:Succeeded b:Succeeded c:Succeeded undo b:Succeeded undo a:Succeeded finally last:Failed => NeedsAttention",
    ]);
  });

  it("runs undo before finally", () => {
    const document = recipe({
      start: "a",
      nodes: [step("a", "t.undoable"), step("b", "t.act"), step("last", "t.act")],
      edges: chain("a", "b"),
      finally: ["last"],
    });
    expect(shown(document)).toContain(
      "a:Succeeded b:Failed undo a:Failed finally last:Succeeded => NeedsAttention",
    );
    expect(shown(document)).toContain(
      "a:Succeeded b:Failed undo a:Succeeded finally last:Succeeded => Failed",
    );
  });

  it("has no cancellation point inside a failure handler, and skips undo at an end that says so", () => {
    const document = recipe({
      start: "a",
      nodes: [
        step("a", "t.undoable"),
        step("b", "t.act"),
        step("handle", "t.gate"),
        step("after", "t.undoable"),
      ],
      edges: [
        edge("a", "Succeeded", "b"),
        edge("b", "Failed", "handle"),
        edge("handle", "Approved", "after"),
        edge("after", "Succeeded", failed("Skip")),
      ],
    });
    expect(shown(document)).toEqual([
      "=> Cancelled",
      "a:Succeeded undo a:Succeeded => Cancelled",
      "a:Succeeded undo a:Failed => NeedsAttention",
      "a:Succeeded b:Succeeded => Succeeded",
      // From here the run is being handled: no cancel before `handle`, none while it waits.
      "a:Succeeded b:Failed handle:Approved after:Succeeded => Failed",
      "a:Succeeded b:Failed handle:Approved after:Failed undo a:Succeeded => Failed",
      "a:Succeeded b:Failed handle:Approved after:Failed undo a:Failed => NeedsAttention",
      "a:Succeeded b:Failed handle:Denied undo a:Succeeded => Failed",
      "a:Succeeded b:Failed handle:Denied undo a:Failed => NeedsAttention",
      "a:Failed => Failed",
    ]);
  });

  it("stays in the handler after a denied gate, and through a for-each", () => {
    const document = recipe({
      inputs: things,
      start: "gate",
      nodes: [step("gate", "t.gate"), forEach("handle", "t.eachPlain")],
      edges: [edge("gate", "Denied", "handle")],
    });
    expect(shown(document)).toEqual([
      "=> Cancelled",
      "gate:CancelledWaiting => Cancelled",
      "gate:Approved => Succeeded",
      // A handler that runs off its end without an explicit `End` ends by the default.
      "gate:Denied handle:Succeeded => Succeeded",
      "gate:Denied handle:Failed => Failed",
    ]);
  });

  it("undoes the handler's own steps at an end that says to run undo", () => {
    const document = recipe({
      start: "a",
      nodes: [step("a", "t.act"), step("handle", "t.undoable")],
      edges: [edge("a", "Failed", "handle"), edge("handle", "Succeeded", failed("Run"))],
    });
    expect(shown(document)).toEqual([
      "=> Cancelled",
      "a:Succeeded => Succeeded",
      "a:Failed handle:Succeeded undo handle:Succeeded => Failed",
      "a:Failed handle:Succeeded undo handle:Failed => NeedsAttention",
      "a:Failed handle:Failed => Failed",
    ]);
  });

  it("takes the result from an explicit end, whatever the outcome that led to it", () => {
    const document = recipe({
      start: "a",
      nodes: [step("a", "t.undoable"), step("b", "t.act")],
      edges: [
        edge("a", "Succeeded", "b"),
        edge("b", "Succeeded", failed("Run")),
        edge("b", "Failed", succeeded),
      ],
    });
    expect(pathsOf(document).slice(3)).toEqual([
      {
        entries: [
          { phase: "Main", step: "a", outcome: "Succeeded" },
          { phase: "Main", step: "b", outcome: "Succeeded" },
          { phase: "Undo", step: "a", outcome: "Succeeded" },
        ],
        main: { result: "Failed", undo: "Run" },
        result: "Failed",
      },
      {
        entries: [
          { phase: "Main", step: "a", outcome: "Succeeded" },
          { phase: "Main", step: "b", outcome: "Succeeded" },
          { phase: "Undo", step: "a", outcome: "Failed" },
        ],
        main: { result: "Failed", undo: "Run" },
        result: "NeedsAttention",
      },
      {
        entries: [
          { phase: "Main", step: "a", outcome: "Succeeded" },
          { phase: "Main", step: "b", outcome: "Failed" },
        ],
        main: { result: "Succeeded" },
        result: "Succeeded",
      },
      {
        entries: [{ phase: "Main", step: "a", outcome: "Failed" }],
        main: { result: "Failed", undo: "Run" },
        result: "Failed",
      },
    ]);
  });

  it("records an end that skips undo", () => {
    const document = recipe({
      nodes: [step("first", "t.act")],
      edges: [edge("first", "Failed", failed("Skip"))],
    });
    expect(pathsOf(document).at(-1)).toEqual({
      entries: [{ phase: "Main", step: "first", outcome: "Failed" }],
      main: { result: "Failed", undo: "Skip" },
      result: "Failed",
    });
  });

  it("stops at the path cap, and not one path before it", () => {
    const document = recipe({ nodes: [step("first", "t.gate")] });
    expect(Result.isSuccess(validate(document, catalog, { ...limits, paths: 4 }))).toBe(true);
    expect(validate(document, catalog, { ...limits, paths: 3 })).toEqual(
      Result.fail({ _tag: "TooManyPaths", cap: 3 }),
    );
  });

  it("stops a recipe with far more paths than the default cap", () => {
    // 16 steps that each go on to the next whether they succeed or fail: 2^16 main paths.
    const ids = Array.from({ length: 16 }, (_, index) => `s${index}`);
    const document = recipe({
      start: "s0",
      nodes: ids.map((id) => step(id, "t.act")),
      edges: [
        ...chain(...ids),
        ...ids.slice(1).map((id, index) => edge(`s${index}`, "Failed", id)),
      ],
    });
    expect(validate(document, catalog)).toEqual(Result.fail({ _tag: "TooManyPaths", cap: 10_000 }));
  });

  it("keeps a long recipe of undoable steps well within the cap", () => {
    // Cleanups fail one at a time (decision 25), so 40 undoable steps and two finally steps
    // give a few thousand paths, where every combination would give more than 2^40.
    const ids = Array.from({ length: 40 }, (_, index) => `s${index}`);
    const document = recipe({
      start: "s0",
      nodes: [...ids.map((id) => step(id, "t.undoable")), step("x", "t.act"), step("y", "t.act")],
      edges: chain(...ids),
      finally: ["x", "y"],
    });
    // Cancelled before step k, or failed at it: k undos and two finally steps owed, so k + 3
    // paths each way. Succeeded: the two finally steps, so three paths.
    const cancelled = ids.reduce((sum, _, index) => sum + index + 3, 0);
    const failedAt = ids.reduce((sum, _, index) => sum + index + 3, 0);
    expect(pathsOf(document)).toHaveLength(cancelled + failedAt + 3);
  });
});

// The properties below read a path against the recipe it came from.

const isSuccess = (outcome: string) => outcome === "Succeeded" || outcome === "Approved";
const mainOf = (path: Path) => path.entries.filter((entry) => entry.phase === "Main");
const key = (path: Path) => JSON.stringify([path.entries, path.main]);

const seen = {
  cancelled: 0,
  cancelledWaiting: 0,
  cancelledPartway: 0,
  needsAttention: 0,
  skippedUndo: 0,
  undoneForEachAfterFailure: 0,
  undoOfTwo: 0,
  handled: 0,
  joined: 0,
  overCap: 0,
  fewerPaths: 0,
};
/** The rules that some generated recipe broke, so the comparison of the two walks is not vacuous. */
const brokenRules = new Set<string>();

const edgeFrom = ({ recipe: document }: Generated, from: string, on: string) =>
  document.edges.find((candidate) => candidate.from === from && candidate.on === on);

/** What the main entries of a path must be followed by, given the recipe's edges and defaults. */
const expectedEnd = (generated: Generated, path: Path) => {
  const last = mainOf(path).at(-1);
  if (last === undefined || !["Succeeded", "Failed", "Approved", "Denied"].includes(last.outcome)) {
    return { result: "Cancelled" };
  }
  const to = edgeFrom(generated, last.step, last.outcome)?.to;
  if (to?._tag === "Step") {
    // The main entries stop before a step only when the run was cancelled there.
    return { result: "Cancelled" };
  }
  if (to?._tag === "End") {
    return to.result === "Succeeded"
      ? { result: "Succeeded" }
      : { result: "Failed", undo: to.undo };
  }
  return isSuccess(last.outcome) ? { result: "Succeeded" } : { result: "Failed", undo: "Run" };
};

const checkPaths = (generated: Generated, paths: ReadonlyArray<Path>): void => {
  const steps = new Map(generated.main.map((generatedStep) => [generatedStep.id, generatedStep]));
  const keys = new Set(paths.map(key));
  // No path is listed twice.
  expect(keys.size).toBe(paths.length);
  const hasMain = (entries: ReadonlyArray<unknown>) =>
    keys.has(JSON.stringify([entries, { result: "Cancelled" }])) ||
    paths.some(
      (candidate) =>
        candidate.main.result === "Cancelled" &&
        JSON.stringify(mainOf(candidate)) === JSON.stringify(entries),
    );

  for (const path of paths) {
    const main = mainOf(path);
    const undo = path.entries.filter((entry) => entry.phase === "Undo");
    const last = path.entries.filter((entry) => entry.phase === "Finally");

    // The three phases come in order.
    expect(path.entries).toEqual([...main, ...undo, ...last]);

    // The main entries follow the recipe's edges from `start`, and end as the last edge says.
    expect(main[0]?.step ?? "n0").toBe("n0");
    for (const [index, entry] of main.slice(0, -1).entries()) {
      const to = edgeFrom(generated, entry.step, entry.outcome)?.to;
      expect(to).toEqual({ _tag: "Step", id: main[index + 1]?.step });
    }
    expect(path.main).toEqual(expectedEnd(generated, path));

    // Undo: what completed and has an undo, in reverse; nothing after success or `Skip`.
    const undoRuns =
      path.main.result === "Cancelled" ||
      (path.main.result === "Failed" && path.main.undo === "Run");
    const owed = main
      .filter((entry) => {
        const generatedStep = steps.get(entry.step);
        return (
          generatedStep?.hasUndo === true &&
          (entry.outcome === "Succeeded" ||
            (generatedStep.isForEach &&
              (entry.outcome === "Failed" || entry.outcome === "CancelledPartway")))
        );
      })
      .map((entry) => entry.step)
      .toReversed();
    expect(undo.map((entry) => entry.step)).toEqual(undoRuns ? owed : []);

    // Every `finally` step, in order, on every path.
    expect(last.map((entry) => entry.step)).toEqual(generated.finally);

    // The result is the main result unless a cleanup failed, and at most one fails on a path.
    const failures = [...undo, ...last].filter((entry) => entry.outcome === "Failed");
    expect(failures.length).toBeLessThanOrEqual(1);
    expect(path.result).toBe(failures.length === 1 ? "NeedsAttention" : path.main.result);
    // Each cleanup of this main phase fails on exactly one path, and on one path none does.
    const siblings = paths.filter(
      (candidate) =>
        JSON.stringify(mainOf(candidate)) === JSON.stringify(main) &&
        candidate.main.result === path.main.result,
    );
    expect(siblings).toHaveLength(undo.length + last.length + 1);
    expect(
      siblings
        .map((candidate) =>
          candidate.entries.findIndex(
            (entry) => entry.phase !== "Main" && entry.outcome === "Failed",
          ),
        )
        .toSorted((a, b) => a - b),
    ).toEqual([-1, ...[...undo, ...last].map((_, index) => main.length + index)]);

    // A cancelled path never followed a `Failed` or `Denied` edge.
    const failedAt = main.findIndex(
      (entry) => entry.outcome === "Failed" || entry.outcome === "Denied",
    );
    if (path.main.result === "Cancelled") {
      expect(failedAt).toBe(-1);
    }

    // On the normal track there is a cancelled path before each step, at each gate and partway
    // through each for-each.
    const normal = failedAt === -1 ? main.length : failedAt + 1;
    for (const [index, entry] of main.slice(0, normal).entries()) {
      const before = main.slice(0, index);
      const generatedStep = steps.get(entry.step);
      expect(hasMain(before)).toBe(true);
      if (generatedStep?.isGate === true) {
        expect(hasMain([...before, { ...entry, outcome: "CancelledWaiting" }])).toBe(true);
      }
      if (generatedStep?.isForEach === true) {
        expect(hasMain([...before, { ...entry, outcome: "CancelledPartway" }])).toBe(true);
      }
    }
    // Inside a handler there is none.
    for (const index of main.slice(normal).keys()) {
      expect(hasMain(main.slice(0, normal + index))).toBe(false);
    }

    seen.cancelled += path.main.result === "Cancelled" ? 1 : 0;
    seen.cancelledWaiting += main.at(-1)?.outcome === "CancelledWaiting" ? 1 : 0;
    seen.cancelledPartway += main.at(-1)?.outcome === "CancelledPartway" ? 1 : 0;
    seen.needsAttention += path.result === "NeedsAttention" ? 1 : 0;
    seen.skippedUndo +=
      path.main.result === "Failed" && path.main.undo === "Skip" && owed.length > 0 ? 1 : 0;
    seen.undoOfTwo += undo.length > 1 ? 1 : 0;
    seen.handled += main.length > normal ? 1 : 0;
    seen.undoneForEachAfterFailure += undo.some((entry) =>
      main.some((candidate) => candidate.step === entry.step && candidate.outcome !== "Succeeded"),
    )
      ? 1
      : 0;
  }
};

describe("paths of generated recipes", () => {
  const runs = { arbitrary: { runs: 300 } };

  it.prop(
    "have the shape the spec gives a path",
    [Picks],
    ([picks]) => {
      const generated = generate(picks, { cycle: false, maxNodes: 5 });
      checkPaths(generated, generatedPaths(generated.recipe));
    },
    runs,
  );

  it.prop(
    "are cut off exactly at the cap, and are the same under any cap that fits them",
    [Picks],
    ([picks]) => {
      const { recipe: document } = generate(picks, { cycle: false, maxNodes: 5 });
      const paths = generatedPaths(document);
      const withCap = (cap: number) =>
        Result.map(walkedOf(document, "OneFailure", cap), (walked) => walked.map(toPath));
      expect(withCap(paths.length)).toEqual(Result.succeed(paths));
      expect(withCap(paths.length - 1)).toEqual(
        Result.fail({ _tag: "TooManyPaths", cap: paths.length - 1 }),
      );
      // More than 20 paths, reached about 80 times in 300 runs. At more than 50 it was reached
      // about 4 times, and not at all one run in fifty, which failed the coverage test by chance.
      seen.overCap += paths.length > 20 ? 1 : 0;
    },
    runs,
  );

  it.prop(
    "break the same rules whether cleanups fail one at a time or in every combination",
    [Picks],
    ([picks]) => {
      const { recipe: document } = generate(picks, { cycle: false, maxNodes: 5 });
      const broken = (outcomes: CleanupOutcomes) => {
        const walked = Result.getOrThrow(walkedOf(document, outcomes));
        const violations = checkInvariants(document.invariants, walked.map(viewOf));
        return {
          paths: walked.length,
          rules: [
            ...new Set(violations.map(({ message, rule }) => `${rule}: ${message}`)),
          ].toSorted(),
        };
      };
      const one = broken("OneFailure");
      const every = broken("EveryCombination");
      expect(one.rules).toEqual(every.rules);
      expect(one.paths).toBeLessThanOrEqual(every.paths);
      seen.fewerPaths += one.paths < every.paths ? 1 : 0;
      for (const line of one.rules) {
        brokenRules.add(line.split(":")[0] ?? "");
      }
    },
    runs,
  );

  it.prop(
    "agree with stage 5 on which steps have succeeded before each step",
    [Picks],
    ([picks]) => {
      const generated = generate(picks, { cycle: false, maxNodes: 5 });
      const paths = generatedPaths(generated.recipe);
      const resolved = Result.getOrThrow(checkStructure(generated.recipe, generatedCatalog));
      const { guaranteed, pathWithout } = guaranteedBefore(resolved);
      const ids = new Set(generated.main.map(({ id }) => id));
      const into = new Map<string, number>();
      for (const candidate of generated.recipe.edges) {
        if (candidate.to._tag === "Step") {
          into.set(candidate.to.id, (into.get(candidate.to.id) ?? 0) + 1);
        }
      }
      seen.joined += [...into.values()].some((count) => count > 1) ? 1 : 0;

      for (const user of generated.recipe.nodes.filter(({ id }) => ids.has(id))) {
        // Every way a path can arrive at this step: the main entries before it.
        const arrivals = paths.flatMap((path) => {
          const main = mainOf(path);
          const at = main.findIndex((entry) => entry.step === user.id);
          return at === -1 ? [] : [main.slice(0, at)];
        });
        expect(arrivals.length).toBeGreaterThan(0);
        for (const producer of generated.recipe.nodes.filter(({ id }) => ids.has(id))) {
          const onEveryPath = arrivals.every((before) =>
            before.some((entry) => entry.step === producer.id && isSuccess(entry.outcome)),
          );
          expect(guaranteed.get(user.id)?.has(producer.id) ?? false).toBe(onEveryPath);

          // When it is not guaranteed, the counterexample is one of those arrivals.
          const counterexample = pathWithout(user.id, producer.id);
          expect(Option.isNone(counterexample)).toBe(onEveryPath);
          if (Option.isSome(counterexample)) {
            const hops = counterexample.value.map(({ outcome, step: hop }) => `${hop}:${outcome}`);
            expect(hops.some((hop) => hop.startsWith(`${producer.id}:Succeeded`))).toBe(false);
            expect(hops.some((hop) => hop.startsWith(`${producer.id}:Approved`))).toBe(false);
            expect(
              arrivals.map((before) => before.map((entry) => `${entry.step}:${entry.outcome}`)),
            ).toContainEqual(hops);
          }
        }
      }
    },
    runs,
  );

  it("reached every shape the properties are about", () => {
    for (const [shape, count] of Object.entries(seen)) {
      expect(count, shape).toBeGreaterThan(0);
    }
  });

  it("generated recipes that break every rule", () => {
    expect([...brokenRules].toSorted()).toEqual([
      "AfterFailure",
      "CleanedUp",
      "IrreversibleOnlyAfterApproval",
      "NeverWritten",
      "NoWriteBeforeApproval",
      "OnlyAfter",
      "RequiredForSuccess",
      "TemporaryCleanedUp",
    ]);
  });
});
