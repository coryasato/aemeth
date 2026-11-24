import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";
import type { Recipe } from "../index";
import type { Json, Parts } from "../testing/build";
import { validate } from "../index";
import {
  block,
  chain,
  creates,
  database,
  destroys,
  each,
  edge,
  failed,
  fromInput,
  fromOutput,
  fromRecipe,
  fromStep,
  item,
  list,
  maybeFromStep,
  noUndo,
  optional,
  reads,
  recipe,
  required,
  show,
  step,
  succeeded,
  undoWith,
  writes,
} from "../testing/build";

const target = { target: required(database) };
const makes = (lifetime: string, undo: Json = noUndo) => ({
  outputs: { database, spare: database },
  effects: [creates("database", lifetime)],
  undo,
});

const catalog = [
  block("t.act"),
  block("t.check", { kind: "Check" }),
  block("t.gate", { kind: "Gate" }),
  block("t.gateList", {
    kind: "Gate",
    inputs: { items: required(list(database)) },
    outputs: { approved: list(database), one: database },
  }),
  block("t.list", { outputs: { found: list(database) } }),
  block("t.open", { outputs: { database, spare: database } }),
  block("t.make", makes("Temporary")),
  block("t.makeExpiring", makes("Expiring")),
  block("t.makeDurable", makes("Durable")),
  block(
    "t.makeDurableUndoable",
    makes("Durable", undoWith("t.drop", { database: fromOutput("database") })),
  ),
  block(
    "t.makeUndoable",
    makes("Temporary", undoWith("t.drop", { database: fromOutput("database") })),
  ),
  block("t.copy", {
    inputs: { source: required(database) },
    outputs: { copy: database },
    effects: [reads("source"), creates("copy", "Temporary")],
    undo: noUndo,
  }),
  block("t.read", { inputs: target, effects: [reads("target")], undo: noUndo }),
  block("t.write", { inputs: target, effects: [writes("target")], undo: noUndo }),
  block("t.writeOptional", {
    inputs: { target: optional(database) },
    effects: [writes("target")],
    undo: noUndo,
  }),
  block("t.writeUndoable", {
    inputs: target,
    effects: [writes("target")],
    undo: undoWith("t.write", { target: fromInput("target") }),
  }),
  block("t.drop", {
    inputs: { database: optional(database) },
    effects: [destroys("database")],
    undo: noUndo,
  }),
  block("t.dropRequired", {
    inputs: { database: required(database) },
    effects: [destroys("database")],
    undo: noUndo,
  }),
  block("t.copyUndoable", {
    inputs: { source: required(database) },
    outputs: { copy: database },
    effects: [reads("source"), creates("copy", "Temporary")],
    undo: undoWith("t.drop", { database: fromOutput("copy") }),
  }),
  block("t.copyInto", {
    inputs: { source: required(database), target: required(database) },
    effects: [reads("source"), writes("target")],
    undo: undoWith("t.write", { target: fromInput("target") }),
  }),
  // Its undo block is given nothing: the optional input it writes is left unfed.
  block("t.writeLoose", {
    inputs: target,
    effects: [writes("target")],
    undo: undoWith("t.writeOptional"),
  }),
  block("t.snapshot", makes("Temporary")),
  block("t.snapshotUndoable", { undo: undoWith("t.snapshot") }),
  block("t.dropUndoable", {
    inputs: { database: required(database) },
    effects: [destroys("database")],
    undo: undoWith("t.act"),
  }),
];

/** Each violation as `rule: message @ path`, or the failure itself if another stage rejected the recipe. */
const violations = (document: Recipe, only?: string): ReadonlyArray<string> => {
  const result = validate(document, catalog);
  if (Result.isSuccess(result)) {
    return [];
  }
  return result.failure._tag === "Invariants"
    ? result.failure.violations
        .filter((violation) => only === undefined || violation.rule === only)
        .map((violation) => `${violation.rule}: ${violation.message} @ ${show(violation.path)}`)
    : [`stopped before the invariants: ${JSON.stringify(result.failure)}`];
};

const inputs = {
  production: { type: database },
  staging: { type: database },
  all: { type: list(database) },
};
const production = fromRecipe("production");
const write = (id: string, to: Json = production) => step(id, "t.write", { target: to });

describe("a violation", () => {
  it("carries the rule, a message and the path it was found on", () => {
    const document = recipe({ inputs, nodes: [write("first")] });
    expect(validate(document, catalog)).toEqual(
      Result.fail({
        _tag: "Invariants",
        violations: [
          {
            rule: "IrreversibleOnlyAfterApproval",
            message: "step first cannot be undone and runs before any approval",
            path: {
              entries: [{ phase: "Main", step: "first", outcome: "Succeeded" }],
              main: { result: "Succeeded" },
              result: "Succeeded",
            },
          },
          {
            rule: "IrreversibleOnlyAfterApproval",
            message: "step first cannot be undone and runs before any approval",
            path: {
              entries: [{ phase: "Main", step: "first", outcome: "Failed" }],
              main: { result: "Failed", undo: "Run" },
              result: "Failed",
            },
          },
        ],
      }),
    );
  });

  it("is reported for the always-on rules first, then the recipe's own in the order it lists them", () => {
    const document = recipe({
      inputs,
      nodes: [step("first", "t.make"), step("check", "t.check")],
      edges: [edge("first", "Succeeded", "check"), edge("check", "Failed", succeeded)],
      invariants: [
        { rule: "RequiredForSuccess", step: "check" },
        { rule: "AfterFailure", step: "check", then: "first" },
      ],
    });
    const rules = violations(document).map((line) => line.split(":")[0]);
    expect([...new Set(rules)]).toEqual([
      "TemporaryCleanedUp",
      "RequiredForSuccess",
      "AfterFailure",
    ]);
  });
});

describe("IrreversibleOnlyAfterApproval", () => {
  const rule = "IrreversibleOnlyAfterApproval";
  const before = (what: string, path: string) =>
    `${rule}: ${what} cannot be undone and runs before any approval @ ${path}`;

  it("names every path on which a write with no undo runs with no approval", () => {
    const document = recipe({
      inputs,
      start: "approve",
      nodes: [step("approve", "t.gate"), write("first"), write("denied")],
      edges: [edge("approve", "Approved", "first"), edge("approve", "Denied", "denied")],
    });
    expect(violations(document, "IrreversibleOnlyAfterApproval")).toEqual([
      before("step denied", "approve:Denied denied:Succeeded => Succeeded"),
      before("step denied", "approve:Denied denied:Failed => Failed"),
    ]);
  });

  it("does not count an approval that comes after the step", () => {
    const document = recipe({
      inputs,
      nodes: [write("first"), step("approve", "t.gate")],
      edges: chain("first", "approve"),
    });
    expect(violations(document, "IrreversibleOnlyAfterApproval")).toEqual([
      before("step first", "first:Succeeded => Cancelled"),
      before("step first", "first:Succeeded approve:CancelledWaiting => Cancelled"),
      before("step first", "first:Succeeded approve:Approved => Succeeded"),
      before("step first", "first:Succeeded approve:Denied => Failed"),
      before("step first", "first:Failed => Failed"),
    ]);
  });

  it.each([
    ["a destroy", step("first", "t.dropRequired", { database: production })],
    ["creating a durable resource", step("first", "t.makeDurable")],
    ["a write to an expiring output", write("first", fromStep("made", "database"))],
    ["a write to an output nothing declares as created", write("first", fromStep("made", "spare"))],
  ])("covers %s", (_, node) => {
    const document = recipe({
      inputs,
      start: "made",
      nodes: [step("made", "t.makeExpiring"), node],
      edges: chain("made", "first"),
    });
    expect(violations(document, "IrreversibleOnlyAfterApproval")).toEqual([
      before("step first", "made:Succeeded first:Succeeded => Succeeded"),
      before("step first", "made:Succeeded first:Failed => Failed"),
    ]);
  });

  it("covers a write to an output its block does not create, though it creates another as temporary", () => {
    const document = recipe({
      start: "made",
      nodes: [step("made", "t.make"), write("first", fromStep("made", "spare"))],
      edges: chain("made", "first"),
    });
    expect(violations(document, rule)).toEqual([
      before("step first", "made:Succeeded first:Succeeded => Succeeded"),
      before("step first", "made:Succeeded first:Failed => Failed"),
    ]);
  });

  it("covers a write to an item of a list, even a list of temporary resources", () => {
    const document = recipe({
      inputs,
      nodes: [
        step("first", "t.copy", { source: item }, each(fromRecipe("all"))),
        step("second", "t.write", { target: item }, each(fromStep("first", "copy"))),
        step("drop", "t.dropUndoable", { database: item }, each(fromStep("first", "copy"))),
      ],
      edges: chain("first", "second", "drop"),
    });
    expect(violations(document, "IrreversibleOnlyAfterApproval")).toEqual([
      before("step second", "first:Succeeded second:CancelledPartway => Cancelled"),
      before("step second", "first:Succeeded second:Succeeded => Cancelled"),
      before(
        "step second",
        "first:Succeeded second:Succeeded drop:CancelledPartway undo drop:Succeeded => Cancelled",
      ),
      before(
        "step second",
        "first:Succeeded second:Succeeded drop:CancelledPartway undo drop:Failed => NeedsAttention",
      ),
      before("step second", "first:Succeeded second:Succeeded drop:Succeeded => Succeeded"),
      before(
        "step second",
        "first:Succeeded second:Succeeded drop:Failed undo drop:Succeeded => Failed",
      ),
      before(
        "step second",
        "first:Succeeded second:Succeeded drop:Failed undo drop:Failed => NeedsAttention",
      ),
      before("step second", "first:Succeeded second:Failed => Failed"),
    ]);
  });

  it.each([
    ["a write to a temporary output of this run", write("first", fromStep("made", "database"))],
    [
      "a destroy of one",
      step("first", "t.dropRequired", { database: fromStep("made", "database") }),
    ],
    ["a block that only reads", step("first", "t.read", { target: production })],
    ["a write with an undo", step("first", "t.writeUndoable", { target: production })],
    ["creating a durable resource with an undo", step("first", "t.makeDurableUndoable")],
    ["creating a temporary resource", step("first", "t.copy", { source: production })],
    ["creating an expiring resource", step("first", "t.makeExpiring")],
    ["an optional input left unbound", step("first", "t.writeOptional")],
  ])("does not cover %s", (_, node) => {
    const document = recipe({
      inputs,
      start: "made",
      nodes: [
        step("made", "t.make"),
        node,
        step("drop", "t.drop", { database: maybeFromStep("made", "database") }),
        step(
          "dropCopy",
          "t.drop",
          { database: maybeFromStep("first", "copy") },
          { block: "t.drop" },
        ),
      ].slice(0, node.block === "t.copy" ? 4 : 3),
      edges: chain("made", "first"),
      finally: node.block === "t.copy" ? ["drop", "dropCopy"] : ["drop"],
    });
    expect(violations(document, "IrreversibleOnlyAfterApproval")).toEqual([]);
  });

  it("does not cover an undo block, which takes back what its step did", () => {
    const document = recipe({
      inputs,
      nodes: [step("first", "t.writeUndoable", { target: production }), step("second", "t.act")],
      edges: chain("first", "second"),
    });
    expect(violations(document, "IrreversibleOnlyAfterApproval")).toEqual([]);
  });

  it("covers a finally step on the paths where nothing was approved", () => {
    const document = recipe({
      inputs,
      start: "approve",
      nodes: [step("approve", "t.gate"), write("last")],
      finally: ["last"],
    });
    expect(violations(document, "IrreversibleOnlyAfterApproval")).toEqual([
      before("finally step last", "finally last:Succeeded => Cancelled"),
      before("finally step last", "finally last:Failed => NeedsAttention"),
      before("finally step last", "approve:CancelledWaiting finally last:Succeeded => Cancelled"),
      before("finally step last", "approve:CancelledWaiting finally last:Failed => NeedsAttention"),
      before("finally step last", "approve:Denied finally last:Succeeded => Failed"),
      before("finally step last", "approve:Denied finally last:Failed => NeedsAttention"),
    ]);
  });
});

describe("TemporaryCleanedUp", () => {
  const rule = "TemporaryCleanedUp";
  const left = (path: string, what = "step make", output = "database") =>
    `${rule}: ${what} creates temporary output ${output}, which is not destroyed afterwards @ ${path}`;
  const drop = (id: string, from: Json) => step(id, "t.drop", { database: from });

  it("names the one path on which a temporary resource is created and never destroyed", () => {
    const document = recipe({ start: "make", nodes: [step("make", "t.make")] });
    expect(violations(document, "TemporaryCleanedUp")).toEqual([
      left("make:Succeeded => Succeeded"),
    ]);
  });

  it("holds when a finally step destroys it, whether that succeeds or fails", () => {
    const document = recipe({
      start: "make",
      nodes: [
        step("make", "t.make"),
        step("use", "t.act"),
        drop("drop", maybeFromStep("make", "database")),
      ],
      edges: chain("make", "use"),
      finally: ["drop"],
    });
    expect(violations(document, "TemporaryCleanedUp")).toEqual([]);
  });

  it("is not excused by a different cleanup failing", () => {
    const document = recipe({
      start: "make",
      nodes: [step("make", "t.make"), step("other", "t.act")],
      finally: ["other"],
    });
    expect(violations(document, "TemporaryCleanedUp")).toEqual([
      left("make:Succeeded finally other:Succeeded => Succeeded"),
      left("make:Succeeded finally other:Failed => NeedsAttention"),
    ]);
  });

  it("is broken where a main-path destroy is cancelled before it runs, or fails", () => {
    const document = recipe({
      start: "make",
      nodes: [step("make", "t.make"), drop("drop", fromStep("make", "database"))],
      edges: chain("make", "drop"),
    });
    // A failed main-path step ends the run `Failed`, not `NeedsAttention`: nobody is told.
    expect(violations(document, "TemporaryCleanedUp")).toEqual([
      left("make:Succeeded => Cancelled"),
      left("make:Succeeded drop:Failed => Failed"),
    ]);
  });

  it.each([
    ["another output of the step", maybeFromStep("make", "spare")],
    ["an output of another step", maybeFromStep("other", "database")],
    ["nothing at all", undefined],
  ])("is not met by a step that destroys %s", (_, from) => {
    const document = recipe({
      start: "other",
      nodes: [
        step("other", "t.open"),
        step("make", "t.make"),
        step("drop", "t.drop", from === undefined ? {} : { database: from }),
      ],
      edges: chain("other", "make"),
      finally: ["drop"],
    });
    expect(violations(document, "TemporaryCleanedUp")).toEqual([
      left("other:Succeeded make:Succeeded finally drop:Succeeded => Succeeded"),
      left("other:Succeeded make:Succeeded finally drop:Failed => NeedsAttention"),
    ]);
  });

  it("is not met by a step that only writes it or reads it", () => {
    const document = recipe({
      start: "make",
      nodes: [
        step("make", "t.make"),
        step("write", "t.writeOptional", { target: maybeFromStep("make", "database") }),
      ],
      finally: ["write"],
    });
    expect(violations(document, "TemporaryCleanedUp")).toEqual([
      left("make:Succeeded finally write:Succeeded => Succeeded"),
      left("make:Succeeded finally write:Failed => NeedsAttention"),
    ]);
  });

  it("is met by an undo that destroys it, so only the successful path leaves it behind", () => {
    const document = recipe({
      start: "make",
      nodes: [step("make", "t.makeUndoable"), step("use", "t.act")],
      edges: chain("make", "use"),
    });
    expect(violations(document, "TemporaryCleanedUp")).toEqual([
      left("make:Succeeded use:Succeeded => Succeeded"),
    ]);
  });

  it("is met by a for-each that destroys the items of a for-each's output", () => {
    const document = recipe({
      inputs,
      start: "make",
      nodes: [
        step("make", "t.copy", { source: item }, each(fromRecipe("all"))),
        step("approve", "t.gate"),
        step("drop", "t.dropRequired", { database: item }, each(fromStep("make", "copy"))),
      ],
      edges: [edge("make", "Succeeded", "approve"), edge("approve", "Approved", "drop")],
    });
    expect(violations(document, "TemporaryCleanedUp")).toEqual([
      left("make:Succeeded => Cancelled", "step make", "copy"),
      left("make:Succeeded approve:CancelledWaiting => Cancelled", "step make", "copy"),
      left("make:Succeeded approve:Approved => Cancelled", "step make", "copy"),
      left(
        "make:Succeeded approve:Approved drop:CancelledPartway => Cancelled",
        "step make",
        "copy",
      ),
      left("make:Succeeded approve:Approved drop:Failed => Failed", "step make", "copy"),
      left("make:Succeeded approve:Denied => Failed", "step make", "copy"),
    ]);
  });

  it("still asks for the destroy when a for-each destroy is cancelled partway and another cleanup fails", () => {
    const document = recipe({
      inputs,
      start: "make",
      nodes: [
        step("make", "t.copy", { source: item }, each(fromRecipe("all"))),
        step("approve", "t.gate"),
        step("drop", "t.dropRequired", { database: item }, each(fromStep("make", "copy"))),
        step("other", "t.act"),
      ],
      edges: [edge("make", "Succeeded", "approve"), edge("approve", "Approved", "drop")],
      finally: ["other"],
    });
    const lines = violations(document, "TemporaryCleanedUp");
    // Cancelled partway is not a failed attempt: some items were never tried.
    expect(lines).toContain(
      left(
        "make:Succeeded approve:Approved drop:CancelledPartway finally other:Failed => NeedsAttention",
        "step make",
        "copy",
      ),
    );
    expect(lines.filter((text) => text.includes("drop:Succeeded"))).toEqual([]);
  });

  it("is met by the per-item undo of a for-each, and has nothing to ask of one that failed", () => {
    const document = recipe({
      inputs,
      start: "make",
      nodes: [
        step("make", "t.copyUndoable", { source: item }, each(fromRecipe("all"))),
        step("use", "t.act"),
      ],
      edges: chain("make", "use"),
      invariants: [{ rule: "CleanedUp", step: "make", output: "copy" }],
    });
    expect(violations(document, "TemporaryCleanedUp")).toEqual([
      left("make:Succeeded use:Succeeded => Succeeded", "step make", "copy"),
    ]);
    // The same answer from the rule a recipe asserts: where the for-each failed, the step did
    // not succeed, and its undo's own success is not the step's.
    expect(violations(document, "CleanedUp")).toEqual([
      "CleanedUp: output copy of step make is not destroyed after the step succeeded @ make:Succeeded use:Succeeded => Succeeded",
    ]);
  });

  it("does not cover what an undo block creates", () => {
    const document = recipe({
      nodes: [step("first", "t.snapshotUndoable"), step("second", "t.act")],
      edges: chain("first", "second"),
    });
    expect(violations(document, "TemporaryCleanedUp")).toEqual([]);
  });

  it("covers a finally step that creates a temporary resource", () => {
    const document = recipe({
      nodes: [step("first", "t.act"), step("make", "t.make")],
      finally: ["make"],
    });
    expect(violations(document, "TemporaryCleanedUp")).toEqual([
      left("finally make:Succeeded => Cancelled", "finally step make"),
      left("first:Succeeded finally make:Succeeded => Succeeded", "finally step make"),
      left("first:Failed finally make:Succeeded => Failed", "finally step make"),
    ]);
  });

  it.each(["t.makeExpiring", "t.makeDurableUndoable", "t.open"])(
    "does not cover an output of %s, which is not temporary",
    (blockId) => {
      const document = recipe({ start: "make", nodes: [step("make", blockId)] });
      expect(violations(document, "TemporaryCleanedUp")).toEqual([]);
    },
  );
});

describe("CleanedUp", () => {
  const rule = { rule: "CleanedUp", step: "open", output: "database" };
  const left = (path: string) =>
    `CleanedUp: output database of step open is not destroyed after the step succeeded @ ${path}`;

  it("names the one path on which the step succeeds and its output is not destroyed", () => {
    const document = recipe({ start: "open", nodes: [step("open", "t.open")], invariants: [rule] });
    expect(violations(document, "CleanedUp")).toEqual([left("open:Succeeded => Succeeded")]);
  });

  it("holds when the destroy succeeds, or fails and the run needs attention", () => {
    const document = recipe({
      start: "open",
      nodes: [
        step("open", "t.open"),
        step("drop", "t.drop", { database: maybeFromStep("open", "database") }),
      ],
      finally: ["drop"],
      invariants: [rule],
    });
    expect(violations(document, "CleanedUp")).toEqual([]);
  });

  it("is broken where the destroy fails on the main path, or destroys something else", () => {
    const document = recipe({
      start: "open",
      nodes: [
        step("open", "t.open"),
        step("approve", "t.gate"),
        step("drop", "t.dropRequired", { database: fromStep("open", "database") }),
        step("other", "t.drop", { database: maybeFromStep("open", "spare") }),
      ],
      edges: [edge("open", "Succeeded", "approve"), edge("approve", "Approved", "drop")],
      finally: ["other"],
      invariants: [rule],
    });
    const lines = violations(document, "CleanedUp");
    // The destroy is never attempted on six paths, and destroys nothing useful on none.
    expect(lines).toHaveLength(9);
    expect(lines).toContain(left("open:Succeeded finally other:Failed => NeedsAttention"));
    expect(lines).toContain(
      left("open:Succeeded approve:Denied finally other:Succeeded => Failed"),
    );
    // A destroy that fails on the main path ends the run `Failed`: nobody is told.
    expect(lines).toContain(
      left("open:Succeeded approve:Approved drop:Failed finally other:Succeeded => Failed"),
    );
    // The same failed destroy, on a run that then ended in `NeedsAttention`: the destroy was
    // attempted, it failed, and a person is told, which is what the rule asks.
    expect(lines).not.toContain(
      left("open:Succeeded approve:Approved drop:Failed finally other:Failed => NeedsAttention"),
    );
    expect(lines.filter((text) => text.includes("drop:Succeeded"))).toEqual([]);
  });
});

describe("NeverWritten", () => {
  const rule = { rule: "NeverWritten", input: "production" };
  const line = (what: string, verb: string, path: string) =>
    `NeverWritten: ${what} ${verb} recipe input production @ ${path}`;
  const gated = (nodes: ReadonlyArray<ReturnType<typeof step>>, more: Parts = {}) =>
    recipe({
      inputs,
      start: "approve",
      nodes: [step("approve", "t.gate"), ...nodes],
      edges: [edge("approve", "Approved", "first")],
      invariants: [rule],
      ...more,
    });

  it("names every path on which a step writes the input, failed attempts included", () => {
    expect(violations(gated([write("first")]), "NeverWritten")).toEqual([
      line("step first", "writes", "approve:Approved first:Succeeded => Succeeded"),
      line("step first", "writes", "approve:Approved first:Failed => Failed"),
    ]);
  });

  it("covers a destroy, and an item of the input", () => {
    const document = recipe({
      inputs,
      start: "approve",
      nodes: [
        step("approve", "t.gate"),
        step("first", "t.dropRequired", { database: item }, each(fromRecipe("all"))),
      ],
      edges: [edge("approve", "Approved", "first")],
      invariants: [{ rule: "NeverWritten", input: "all" }],
    });
    expect(violations(document, "NeverWritten")).toEqual([
      "NeverWritten: step first destroys recipe input all @ approve:Approved first:CancelledPartway => Cancelled",
      "NeverWritten: step first destroys recipe input all @ approve:Approved first:Succeeded => Succeeded",
      "NeverWritten: step first destroys recipe input all @ approve:Approved first:Failed => Failed",
    ]);
  });

  it("covers an undo block and a finally step", () => {
    const document = gated(
      [
        step("first", "t.writeUndoable", { target: fromRecipe("staging") }),
        step("second", "t.act"),
        write("last"),
      ],
      {
        edges: [edge("approve", "Approved", "first"), edge("first", "Succeeded", "second")],
        finally: ["last"],
        invariants: [
          { rule: "NeverWritten", input: "staging" },
          { rule: "NeverWritten", input: "all" },
        ],
      },
    );
    const lines = violations(document, "NeverWritten").filter((text) =>
      text.startsWith("NeverWritten"),
    );
    expect(lines).toContain(
      "NeverWritten: the undo of first writes recipe input staging @ approve:Approved first:Succeeded second:Failed undo first:Succeeded finally last:Succeeded => Failed",
    );
    // `last` writes production, which no rule here names; nothing touches `all`.
    expect(lines.filter((text) => !text.includes("recipe input staging"))).toEqual([]);
    expect(lines.filter((text) => text.includes("finally step"))).toEqual([]);
  });

  it("looks at the input the effect names, not at the block's other inputs", () => {
    const document = gated([
      step("first", "t.copyInto", { source: production, target: fromRecipe("staging") }),
    ]);
    expect(violations(document, "NeverWritten")).toEqual([]);
    const reversed = gated([
      step("first", "t.copyInto", { source: fromRecipe("staging"), target: production }),
    ]);
    expect(violations(reversed, "NeverWritten")).toEqual([
      line("step first", "writes", "approve:Approved first:Succeeded => Succeeded"),
      line("step first", "writes", "approve:Approved first:Failed => Failed"),
    ]);
  });

  it("takes an undo input that nothing feeds as touching nothing", () => {
    const document = gated(
      [step("first", "t.writeLoose", { target: production }), step("second", "t.act")],
      { edges: [edge("approve", "Approved", "first"), edge("first", "Succeeded", "second")] },
    );
    const lines = violations(document, "NeverWritten");
    expect(lines).toHaveLength(6);
    expect(lines.filter((text) => text.includes("the undo of"))).toEqual([]);
  });

  it("does not cover a read, another input, or a step output", () => {
    const document = gated(
      [
        step("first", "t.read", { target: production }),
        write("second", fromRecipe("staging")),
        step("third", "t.make"),
        write("fourth", fromStep("third", "database")),
        step("drop", "t.drop", { database: maybeFromStep("third", "database") }),
      ],
      {
        edges: [
          edge("approve", "Approved", "first"),
          ...chain("first", "second", "third", "fourth"),
        ],
        finally: ["drop"],
      },
    );
    expect(violations(document, "NeverWritten")).toEqual([]);
  });
});

describe("RequiredForSuccess", () => {
  const rule = { rule: "RequiredForSuccess", step: "verify" };
  const line = (path: string) =>
    `RequiredForSuccess: the main path succeeds without step verify having succeeded @ ${path}`;

  it("names the one path that succeeds though the step failed", () => {
    const document = recipe({
      nodes: [step("first", "t.act"), step("verify", "t.check")],
      edges: [edge("first", "Succeeded", "verify"), edge("verify", "Failed", succeeded)],
      invariants: [rule],
    });
    expect(violations(document, "RequiredForSuccess")).toEqual([
      line("first:Succeeded verify:Failed => Succeeded"),
    ]);
  });

  it("names a path that succeeds without reaching the step, and one whose cleanup then fails", () => {
    const document = recipe({
      nodes: [step("first", "t.act"), step("verify", "t.check"), step("last", "t.act")],
      edges: [edge("first", "Failed", "verify"), edge("verify", "Failed", failed("Run"))],
      finally: ["last"],
      invariants: [rule],
    });
    expect(violations(document, "RequiredForSuccess")).toEqual([
      line("first:Succeeded finally last:Succeeded => Succeeded"),
      line("first:Succeeded finally last:Failed => NeedsAttention"),
    ]);
  });

  it("does not take another step's success, or a finally step of that name, for the step's", () => {
    const document = recipe({
      nodes: [step("first", "t.act"), step("verify", "t.act")],
      finally: ["verify"],
      invariants: [rule],
    });
    expect(violations(document, "RequiredForSuccess")).toEqual([
      line("first:Succeeded finally verify:Succeeded => Succeeded"),
      line("first:Succeeded finally verify:Failed => NeedsAttention"),
    ]);
  });

  it("holds when every successful path passed the step", () => {
    const document = recipe({
      nodes: [step("first", "t.act"), step("verify", "t.check")],
      edges: chain("first", "verify"),
      invariants: [rule],
    });
    expect(violations(document, "RequiredForSuccess")).toEqual([]);
  });
});

describe("NoWriteBeforeApproval", () => {
  const rule = { rule: "NoWriteBeforeApproval", input: "production" };
  const line = (what: string, path: string, verb = "writes") =>
    `NoWriteBeforeApproval: ${what} ${verb} recipe input production before any approval @ ${path}`;
  const undoable = (id: string, to: Json = production) =>
    step(id, "t.writeUndoable", { target: to });

  it("names every path on which the input is written before a gate was approved", () => {
    const document = recipe({
      inputs,
      nodes: [undoable("first"), step("approve", "t.gate"), undoable("second")],
      edges: [edge("first", "Succeeded", "approve"), edge("approve", "Approved", "second")],
      invariants: [rule],
    });
    const lines = violations(document, "NoWriteBeforeApproval");
    // Every path on which `first` ran, and never for `second`, which comes after the approval.
    const byFirst = lines.filter((text) => text.startsWith(line("step first", "first:")));
    expect(byFirst).toHaveLength(12);
    expect(byFirst).toContain(line("step first", "first:Failed => Failed"));
    expect(byFirst).toContain(
      line(
        "step first",
        "first:Succeeded approve:Approved second:Failed undo first:Succeeded => Failed",
      ),
    );
    // The undo of `first` writes too. It counts where the run was cancelled before any
    // approval, and not where it undoes after one.
    expect(lines.filter((text) => !byFirst.includes(text))).toEqual([
      line("the undo of first", "first:Succeeded undo first:Succeeded => Cancelled"),
      line("the undo of first", "first:Succeeded undo first:Failed => NeedsAttention"),
      line(
        "the undo of first",
        "first:Succeeded approve:CancelledWaiting undo first:Succeeded => Cancelled",
      ),
      line(
        "the undo of first",
        "first:Succeeded approve:CancelledWaiting undo first:Failed => NeedsAttention",
      ),
      line("the undo of first", "first:Succeeded approve:Denied undo first:Succeeded => Failed"),
      line(
        "the undo of first",
        "first:Succeeded approve:Denied undo first:Failed => NeedsAttention",
      ),
    ]);
  });

  it("covers a write after a denial, an undo and a destroy, where nothing was approved", () => {
    const document = recipe({
      inputs,
      start: "approve",
      nodes: [
        step("approve", "t.gate"),
        undoable("denied"),
        step("drop", "t.dropUndoable", { database: production }),
      ],
      edges: [edge("approve", "Denied", "denied"), edge("denied", "Succeeded", "drop")],
      invariants: [rule],
    });
    const failed = "approve:Denied denied:Succeeded drop:Failed undo denied:";
    expect(violations(document, "NoWriteBeforeApproval")).toEqual([
      line("step denied", "approve:Denied denied:Succeeded drop:Succeeded => Succeeded"),
      line("step drop", "approve:Denied denied:Succeeded drop:Succeeded => Succeeded", "destroys"),
      line("step denied", `${failed}Succeeded => Failed`),
      line("step drop", `${failed}Succeeded => Failed`, "destroys"),
      line("the undo of denied", `${failed}Succeeded => Failed`),
      line("step denied", `${failed}Failed => NeedsAttention`),
      line("step drop", `${failed}Failed => NeedsAttention`, "destroys"),
      line("the undo of denied", `${failed}Failed => NeedsAttention`),
      line("step denied", "approve:Denied denied:Failed => Failed"),
    ]);
  });

  it("holds when every write comes after an approval, and for reads and other inputs before it", () => {
    const document = recipe({
      inputs,
      nodes: [
        step("first", "t.read", { target: production }),
        undoable("other", fromRecipe("staging")),
        step("approve", "t.gate"),
        undoable("second"),
      ],
      edges: [...chain("first", "other", "approve"), edge("approve", "Approved", "second")],
      invariants: [rule],
    });
    expect(violations(document, "NoWriteBeforeApproval")).toEqual([]);
  });
});

describe("AfterFailure", () => {
  const rule = { rule: "AfterFailure", step: "check", then: "rollBack" };
  const line = (path: string) =>
    `AfterFailure: step check fails and step rollBack does not run afterwards @ ${path}`;
  const nodes = [step("first", "t.act"), step("check", "t.check"), step("rollBack", "t.act")];

  it("names the one path on which the step fails and the other never runs", () => {
    const document = recipe({
      nodes,
      edges: [edge("first", "Succeeded", "check"), edge("first", "Failed", "rollBack")],
      invariants: [rule],
    });
    expect(violations(document, "AfterFailure")).toEqual([
      line("first:Succeeded check:Failed => Failed"),
    ]);
  });

  it("holds when the failure leads to the other step, whether that then succeeds or fails", () => {
    const document = recipe({
      nodes,
      edges: [edge("first", "Succeeded", "check"), edge("check", "Failed", "rollBack")],
      invariants: [rule],
    });
    expect(violations(document, "AfterFailure")).toEqual([]);
  });

  it("does not count the other step running before the failure, or as a finally step", () => {
    const before = recipe({
      nodes,
      edges: [edge("first", "Succeeded", "rollBack"), edge("rollBack", "Succeeded", "check")],
      invariants: [rule],
    });
    expect(violations(before, "AfterFailure")).toEqual([
      line("first:Succeeded rollBack:Succeeded check:Failed => Failed"),
    ]);
    const last = recipe({
      nodes,
      edges: chain("first", "check"),
      finally: ["rollBack"],
      invariants: [rule],
    });
    expect(violations(last, "AfterFailure")).toEqual([
      line("first:Succeeded check:Failed finally rollBack:Succeeded => Failed"),
      line("first:Succeeded check:Failed finally rollBack:Failed => NeedsAttention"),
    ]);
  });

  it("does not count some other step running after the failure, or the step itself", () => {
    const document = recipe({
      nodes: [...nodes, step("other", "t.act")],
      edges: [
        edge("first", "Succeeded", "check"),
        edge("first", "Failed", "rollBack"),
        edge("check", "Failed", "other"),
      ],
      invariants: [rule, { rule: "AfterFailure", step: "first", then: "first" }],
    });
    expect(violations(document, "AfterFailure")).toEqual([
      line("first:Succeeded check:Failed other:Succeeded => Succeeded"),
      line("first:Succeeded check:Failed other:Failed => Failed"),
      "AfterFailure: step first fails and step first does not run afterwards @ first:Failed rollBack:Succeeded => Succeeded",
      "AfterFailure: step first fails and step first does not run afterwards @ first:Failed rollBack:Failed => Failed",
    ]);
  });

  it("is about a main-path step: a finally step that fails is not covered", () => {
    const document = recipe({
      nodes,
      edges: chain("first", "rollBack"),
      finally: ["check"],
      invariants: [rule],
    });
    expect(violations(document, "AfterFailure")).toEqual([]);
  });

  it("is about failure only: not a denial, not a for-each cancelled partway", () => {
    const document = recipe({
      inputs,
      nodes: [
        step("first", "t.gate"),
        step("check", "t.read", { target: item }, each(fromRecipe("all"))),
        step("rollBack", "t.act"),
      ],
      edges: [edge("first", "Approved", "check"), edge("check", "Succeeded", "rollBack")],
      invariants: [rule, { rule: "AfterFailure", step: "first", then: "rollBack" }],
    });
    expect(violations(document, "AfterFailure")).toEqual([
      line("first:Approved check:Failed => Failed"),
    ]);
  });
});

describe("DestroysOnlyApproved", () => {
  const rule = { rule: "DestroysOnlyApproved", gate: "approve" };
  const line = (what: string, path: string) =>
    `DestroysOnlyApproved: ${what} destroys its input database, which does not come from gate approve @ ${path}`;
  const cleanup = (drops: ReadonlyArray<ReturnType<typeof step>>, more: Parts = {}) =>
    recipe({
      inputs,
      start: "list",
      nodes: [
        step("list", "t.list"),
        step("approve", "t.gateList", { items: fromStep("list", "found") }),
        ...drops,
      ],
      edges: [edge("list", "Succeeded", "approve"), edge("approve", "Approved", "drop")],
      invariants: [rule],
      ...more,
    });
  const dropEach = (id: string, over: Json) =>
    step(id, "t.dropRequired", { database: item }, each(over));

  it("holds when everything destroyed is an output of the gate, or an item of one", () => {
    const document = cleanup(
      [
        dropEach("drop", fromStep("approve", "approved")),
        step("dropOne", "t.dropRequired", { database: fromStep("approve", "one") }),
        step("nothing", "t.drop"),
      ],
      {
        edges: [
          edge("list", "Succeeded", "approve"),
          edge("approve", "Approved", "drop"),
          edge("drop", "Succeeded", "dropOne"),
        ],
        finally: ["nothing"],
      },
    );
    expect(violations(document, "DestroysOnlyApproved")).toEqual([]);
  });

  it("names every path on which a step destroys what was listed and not what was approved", () => {
    const document = cleanup([dropEach("drop", fromStep("list", "found"))]);
    expect(violations(document, "DestroysOnlyApproved")).toEqual([
      line("step drop", "list:Succeeded approve:Approved drop:CancelledPartway => Cancelled"),
      line("step drop", "list:Succeeded approve:Approved drop:Succeeded => Succeeded"),
      line("step drop", "list:Succeeded approve:Approved drop:Failed => Failed"),
    ]);
  });

  it("covers a destroy of a recipe input, and one in a finally step", () => {
    const document = cleanup(
      [
        step("drop", "t.dropRequired", { database: production }),
        step("last", "t.drop", { database: maybeFromStep("approve", "one") }),
      ],
      { finally: ["last"] },
    );
    const lines = violations(document, "DestroysOnlyApproved");
    expect(lines).toEqual([
      line(
        "step drop",
        "list:Succeeded approve:Approved drop:Succeeded finally last:Succeeded => Succeeded",
      ),
      line(
        "step drop",
        "list:Succeeded approve:Approved drop:Succeeded finally last:Failed => NeedsAttention",
      ),
      line(
        "step drop",
        "list:Succeeded approve:Approved drop:Failed finally last:Succeeded => Failed",
      ),
      line(
        "step drop",
        "list:Succeeded approve:Approved drop:Failed finally last:Failed => NeedsAttention",
      ),
    ]);
  });

  it("cannot name a step that is not a gate as its gate", () => {
    const document = cleanup([dropEach("drop", fromStep("list", "found"))], {
      invariants: [{ rule: "DestroysOnlyApproved", gate: "list" }],
    });
    expect(validate(document, catalog)).toEqual(
      Result.fail({
        _tag: "Structure",
        errors: [
          {
            _tag: "InvariantGateIsNotGate",
            step: "list",
            at: { _tag: "Invariant", index: 0, rule: "DestroysOnlyApproved" },
          },
        ],
      }),
    );
  });

  it("does not cover a write", () => {
    const document = cleanup([step("drop", "t.writeUndoable", { target: production })]);
    expect(violations(document, "DestroysOnlyApproved")).toEqual([]);
  });
});

describe("OnlyAfter", () => {
  const rule = { rule: "OnlyAfter", step: "revoke", requires: ["deploy", "approve"] };
  const line = (required: string, path: string) =>
    `OnlyAfter: step revoke runs without step ${required} having succeeded @ ${path}`;
  const nodes = [step("deploy", "t.act"), step("approve", "t.gate"), step("revoke", "t.act")];

  it("holds when the step is reached only through the success of each required step", () => {
    const document = recipe({
      start: "deploy",
      nodes,
      edges: [edge("deploy", "Succeeded", "approve"), edge("approve", "Approved", "revoke")],
      invariants: [rule],
    });
    expect(violations(document, "OnlyAfter")).toEqual([]);
  });

  it("names every path on which the step runs after a required step failed or was denied", () => {
    const document = recipe({
      start: "deploy",
      nodes,
      edges: [
        edge("deploy", "Succeeded", "approve"),
        edge("deploy", "Failed", "approve"),
        edge("approve", "Approved", "revoke"),
        edge("approve", "Denied", "revoke"),
      ],
      invariants: [rule],
    });
    expect(violations(document, "OnlyAfter")).toEqual([
      line("approve", "deploy:Succeeded approve:Denied revoke:Succeeded => Succeeded"),
      line("approve", "deploy:Succeeded approve:Denied revoke:Failed => Failed"),
      line("deploy", "deploy:Failed approve:Approved revoke:Succeeded => Succeeded"),
      line("deploy", "deploy:Failed approve:Approved revoke:Failed => Failed"),
      line("deploy", "deploy:Failed approve:Denied revoke:Succeeded => Succeeded"),
      line("approve", "deploy:Failed approve:Denied revoke:Succeeded => Succeeded"),
      line("deploy", "deploy:Failed approve:Denied revoke:Failed => Failed"),
      line("approve", "deploy:Failed approve:Denied revoke:Failed => Failed"),
    ]);
  });

  it("does not count a required step that runs after the step, and covers a finally step", () => {
    const document = recipe({
      start: "approve",
      nodes,
      edges: [edge("approve", "Approved", "deploy")],
      finally: ["revoke"],
      invariants: [{ rule: "OnlyAfter", step: "revoke", requires: ["deploy"] }],
    });
    const lines = violations(document, "OnlyAfter");
    expect(lines).toHaveLength(10);
    expect(lines.filter((text) => text.includes("deploy:Succeeded"))).toEqual([]);
    expect(lines).toContain(
      line("deploy", "approve:Approved deploy:Failed finally revoke:Failed => NeedsAttention"),
    );
  });

  it("does not count the step itself as having succeeded before it ran", () => {
    const document = recipe({
      start: "revoke",
      nodes: [step("revoke", "t.act")],
      invariants: [{ rule: "OnlyAfter", step: "revoke", requires: ["revoke"] }],
    });
    expect(violations(document, "OnlyAfter")).toEqual([
      line("revoke", "revoke:Succeeded => Succeeded"),
      line("revoke", "revoke:Failed => Failed"),
    ]);
  });

  it("does not take the success of a required step's undo for the step's own", () => {
    const document = recipe({
      inputs,
      start: "deploy",
      nodes: [
        step("deploy", "t.writeUndoable", { target: item }, each(fromRecipe("all"))),
        step("revoke", "t.act"),
      ],
      finally: ["revoke"],
      invariants: [{ rule: "OnlyAfter", step: "revoke", requires: ["deploy"] }],
    });
    const lines = violations(document, "OnlyAfter");
    expect(lines).toContain(
      line("deploy", "deploy:Failed undo deploy:Succeeded finally revoke:Succeeded => Failed"),
    );
    expect(lines.filter((text) => text.includes("@ deploy:Succeeded"))).toEqual([]);
  });

  it("does not count a required step that runs later on the main path", () => {
    const document = recipe({
      start: "revoke",
      nodes: [step("revoke", "t.act"), step("deploy", "t.act")],
      edges: chain("revoke", "deploy"),
      invariants: [{ rule: "OnlyAfter", step: "revoke", requires: ["deploy"] }],
    });
    expect(violations(document, "OnlyAfter")).toEqual([
      line("deploy", "revoke:Succeeded => Cancelled"),
      line("deploy", "revoke:Succeeded deploy:Succeeded => Succeeded"),
      line("deploy", "revoke:Succeeded deploy:Failed => Failed"),
      line("deploy", "revoke:Failed => Failed"),
    ]);
  });
});
