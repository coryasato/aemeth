import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";
import type { Recipe } from "../index";
import type { Parts } from "../testing/build";
import { validate } from "../index";
import {
  block,
  chain,
  database,
  each,
  edge,
  failed,
  fromInput,
  fromRecipe,
  fromStep,
  item,
  list,
  literal,
  maybeFromStep,
  noUndo,
  optional,
  recipe,
  required,
  step,
  succeeded,
  text,
  undoWith,
  writes,
} from "../testing/build";

const catalog = [
  block("t.act"),
  block("t.check", { kind: "Check" }),
  block("t.gate", { kind: "Gate" }),
  block("t.make", { outputs: { database, name: text } }),
  block("t.use", { inputs: { database: required(database), label: optional(text) } }),
  block("t.note", { inputs: { database: optional(database) } }),
  block("t.undoable", { undo: undoWith("t.act") }),
  block("t.undoMissing", { undo: undoWith("t.nowhere") }),
  block("t.undoOldVersion", { undo: undoWith("t.act", {}, 2) }),
  block("t.undoIsGate", { undo: undoWith("t.gate") }),
  block("t.undoBroken", { undo: undoWith("t.broken") }),
  block("t.broken", { effects: [writes("nothing")], undo: noUndo }),
  block("t.gateWithUndo", { kind: "Gate", undo: undoWith("t.act") }),
  block("t.brokenUndoFeed", { undo: undoWith("t.act", { database: fromInput("nothing") }) }),
];

const structureErrors = (document: Recipe) => {
  const result = validate(document, catalog);
  return Result.isFailure(result) && result.failure._tag === "Structure"
    ? result.failure.errors
    : [];
};

const one = (parts: Parts = {}) =>
  recipe({ start: "first", nodes: [step("first", "t.act")], ...parts });

describe("structure (stage 2)", () => {
  it("accepts a recipe of one step", () => {
    expect(Result.isSuccess(validate(one(), catalog))).toBe(true);
  });

  it("accepts every kind of reference when each resolves", () => {
    const document = recipe({
      start: "make",
      inputs: { production: { type: database }, names: { type: list(text) } },
      nodes: [
        step("make", "t.make"),
        step("approve", "t.gate"),
        step("use", "t.use", {
          database: fromStep("make", "database"),
          label: literal("drill"),
        }),
        step(
          "label",
          "t.use",
          { database: fromRecipe("production"), label: item },
          each(fromRecipe("names")),
        ),
        step("undone", "t.undoable"),
        step("note", "t.note", { database: maybeFromStep("make", "database") }),
      ],
      edges: [
        ...chain("make", "approve"),
        edge("approve", "Approved", "use"),
        edge("approve", "Denied", failed("Skip")),
        ...chain("use", "label", "undone"),
        edge("undone", "Succeeded", succeeded),
        edge("undone", "Failed", failed("Run")),
      ],
      finally: ["note"],
      invariants: [
        { rule: "NeverWritten", input: "production" },
        { rule: "NoWriteBeforeApproval", input: "production" },
        { rule: "CleanedUp", step: "make", output: "database" },
        { rule: "OnlyAfter", step: "use", requires: ["make", "approve"] },
      ],
    });
    expect(structureErrors(document)).toEqual([]);
  });

  it("reports a step id used twice", () => {
    const document = one({ nodes: [step("first", "t.act"), step("first", "t.check")] });
    expect(structureErrors(document)).toEqual([{ _tag: "DuplicateStepId", step: "first" }]);
  });

  it("reports a start that is not a step", () => {
    expect(structureErrors(one({ start: "missing" }))).toEqual([
      { _tag: "UnknownStep", step: "missing", at: { _tag: "Start" } },
    ]);
  });

  it("reports a start that is a finally step", () => {
    expect(structureErrors(one({ finally: ["first"] }))).toEqual([
      { _tag: "StartIsFinally", step: "first" },
    ]);
  });

  it("reports a finally entry that is not a step", () => {
    expect(structureErrors(one({ finally: ["missing"] }))).toEqual([
      { _tag: "UnknownStep", step: "missing", at: { _tag: "Finally" } },
    ]);
  });

  it("reports a finally step listed twice, once per repeat", () => {
    const document = one({
      nodes: [step("first", "t.act"), step("last", "t.act")],
      finally: ["last", "last", "last"],
    });
    expect(structureErrors(document)).toEqual([
      { _tag: "FinallyStepRepeated", step: "last" },
      { _tag: "FinallyStepRepeated", step: "last" },
    ]);
  });

  it("reports an edge from or to a step that does not exist", () => {
    const document = one({
      edges: [edge("first", "Succeeded", "missing"), edge("nowhere", "Failed", "first")],
    });
    expect(structureErrors(document)).toEqual([
      {
        _tag: "UnknownStep",
        step: "missing",
        at: { _tag: "Edge", from: "first", on: "Succeeded" },
      },
      { _tag: "UnknownStep", step: "nowhere", at: { _tag: "Edge", from: "nowhere", on: "Failed" } },
    ]);
  });

  it("reports an edge out of or into a finally step", () => {
    const document = one({
      nodes: [step("first", "t.act"), step("second", "t.act"), step("last", "t.act")],
      edges: [
        edge("first", "Succeeded", "second"),
        edge("second", "Succeeded", "last"),
        edge("last", "Failed", succeeded),
      ],
      finally: ["last"],
    });
    expect(structureErrors(document)).toEqual([
      { _tag: "FinallyStepHasEdge", step: "last" },
      { _tag: "FinallyStepHasEdge", step: "last" },
    ]);
  });

  it("reports two edges for one step and outcome, whatever they lead to", () => {
    const document = one({
      nodes: [step("first", "t.act"), step("second", "t.act")],
      edges: [
        edge("first", "Succeeded", "second"),
        edge("first", "Succeeded", succeeded),
        edge("first", "Failed", "second"),
      ],
    });
    expect(structureErrors(document)).toEqual([
      { _tag: "DuplicateEdge", from: "first", on: "Succeeded" },
    ]);
  });

  it.each([
    ["t.act", "Action", "Approved"],
    ["t.act", "Action", "Denied"],
    ["t.check", "Check", "Approved"],
    ["t.check", "Check", "Denied"],
    ["t.gate", "Gate", "Succeeded"],
    ["t.gate", "Gate", "Failed"],
  ])("reports an edge out of a %s block on an outcome a %s does not have: %s", (id, kind, on) => {
    const document = one({ nodes: [step("first", id)], edges: [edge("first", on, succeeded)] });
    expect(structureErrors(document)).toEqual([
      { _tag: "OutcomeDoesNotFitKind", from: "first", on, kind },
    ]);
  });

  it.each([
    ["t.act", "Succeeded"],
    ["t.act", "Failed"],
    ["t.check", "Succeeded"],
    ["t.check", "Failed"],
    ["t.gate", "Approved"],
    ["t.gate", "Denied"],
  ])("accepts an edge out of a %s block on %s", (id, on) => {
    const document = one({ nodes: [step("first", id)], edges: [edge("first", on, succeeded)] });
    expect(structureErrors(document)).toEqual([]);
  });

  it("reports a block that is not in the catalog, by id or by version", () => {
    const document = one({
      nodes: [step("first", "t.unknown"), step("second", "t.act", {}, { version: 2 })],
      edges: chain("first", "second"),
    });
    expect(structureErrors(document)).toEqual([
      { _tag: "UnknownBlock", step: "first", block: "t.unknown", version: 1 },
      { _tag: "UnknownBlock", step: "second", block: "t.act", version: 2 },
    ]);
  });

  it("reports an unknown block once, not again for each input bound on it", () => {
    const document = one({
      inputs: { production: { type: database } },
      nodes: [
        step("first", "t.unknown", { database: fromRecipe("production"), other: literal(1) }),
      ],
    });
    expect(structureErrors(document)).toEqual([
      { _tag: "UnknownBlock", step: "first", block: "t.unknown", version: 1 },
    ]);
  });

  it("reports an undo block that is not in the catalog, by id or by version", () => {
    const document = one({
      nodes: [step("first", "t.undoMissing"), step("second", "t.undoOldVersion")],
      edges: chain("first", "second"),
    });
    expect(structureErrors(document)).toEqual([
      { _tag: "UnknownUndoBlock", step: "first", block: "t.nowhere", version: 1 },
      { _tag: "UnknownUndoBlock", step: "second", block: "t.act", version: 2 },
    ]);
  });

  it("reports an undo block that is a gate", () => {
    expect(structureErrors(one({ nodes: [step("first", "t.undoIsGate")] }))).toEqual([
      { _tag: "UndoBlockIsGate", step: "first", block: "t.gate", version: 1 },
    ]);
  });

  it("reports a block, or an undo block, whose declaration contradicts itself, once per block", () => {
    const document = one({
      nodes: [
        step("first", "t.broken"),
        step("second", "t.undoBroken"),
        step("third", "t.brokenUndoFeed"),
        step("fourth", "t.broken"),
        step("fifth", "t.gateWithUndo"),
      ],
      edges: [...chain("first", "second", "third", "fourth", "fifth")],
    });
    expect(structureErrors(document)).toEqual([
      {
        _tag: "BlockInconsistent",
        block: "t.broken",
        version: 1,
        problem: {
          _tag: "EffectNamesUnknownInput",
          effect: { _tag: "Writes", input: "nothing" },
          input: "nothing",
        },
      },
      {
        _tag: "BlockInconsistent",
        block: "t.brokenUndoFeed",
        version: 1,
        problem: { _tag: "UndoFedFromUnknownInput", undoInput: "database", input: "nothing" },
      },
      {
        _tag: "BlockInconsistent",
        block: "t.gateWithUndo",
        version: 1,
        problem: { _tag: "GateHasUndo" },
      },
    ]);
  });

  it("does not accept a recipe whose only fault is an undo block that contradicts itself", () => {
    // `t.broken` is reported at `first`; `second` uses it only as its undo block, and a second
    // step that uses a block already reported must still not pass.
    const viaUndo = one({ nodes: [step("first", "t.undoBroken")] });
    expect(structureErrors(viaUndo)).toHaveLength(1);
    const twice = one({
      nodes: [step("first", "t.undoBroken"), step("second", "t.undoBroken")],
      edges: chain("first", "second"),
    });
    expect(structureErrors(twice)).toHaveLength(1);
    expect(Result.isFailure(validate(twice, catalog))).toBe(true);
  });

  it("reports two declarations of one block and version, used or not, once per extra one", () => {
    const blocks = [
      ...catalog,
      block("t.act"),
      block("t.check"),
      block("t.act", { kind: "Check" }),
    ];
    expect(validate(one(), blocks)).toEqual(
      Result.fail({
        _tag: "Structure",
        errors: [
          { _tag: "DuplicateBlock", block: "t.act", version: 1 },
          { _tag: "DuplicateBlock", block: "t.check", version: 1 },
          { _tag: "DuplicateBlock", block: "t.act", version: 1 },
        ],
      }),
    );
    // The same id at another version is a different block.
    expect(Result.isSuccess(validate(one(), [...catalog, block("t.act", { version: 2 })]))).toBe(
      true,
    );
  });

  it("reports a bound input the block does not have, inherited names included", () => {
    const document = one({
      inputs: { production: { type: database } },
      nodes: [
        step("first", "t.use", {
          database: fromRecipe("production"),
          other: literal(1),
          toString: literal("x"),
        }),
      ],
    });
    expect(structureErrors(document)).toEqual([
      { _tag: "UnknownBlockInput", step: "first", input: "other" },
      { _tag: "UnknownBlockInput", step: "first", input: "toString" },
    ]);
  });

  it("reports a recipe input that does not exist, inherited names included", () => {
    const document = one({
      nodes: [
        step("first", "t.use", { database: fromRecipe("missing"), label: fromRecipe("toString") }),
        step("second", "t.act", {}, each(fromRecipe("gone"))),
      ],
      edges: chain("first", "second"),
      invariants: [
        { rule: "NeverWritten", input: "absent" },
        { rule: "NoWriteBeforeApproval", input: "valueOf" },
      ],
    });
    expect(structureErrors(document)).toEqual([
      {
        _tag: "UnknownRecipeInput",
        name: "missing",
        at: { _tag: "Input", step: "first", input: "database" },
      },
      {
        _tag: "UnknownRecipeInput",
        name: "toString",
        at: { _tag: "Input", step: "first", input: "label" },
      },
      { _tag: "UnknownRecipeInput", name: "gone", at: { _tag: "ForEachOver", step: "second" } },
      {
        _tag: "UnknownRecipeInput",
        name: "absent",
        at: { _tag: "Invariant", index: 0, rule: "NeverWritten" },
      },
      {
        _tag: "UnknownRecipeInput",
        name: "valueOf",
        at: { _tag: "Invariant", index: 1, rule: "NoWriteBeforeApproval" },
      },
    ]);
  });

  it("reports a binding to a step that does not exist", () => {
    const document = one({
      nodes: [
        step("first", "t.use", { database: fromStep("missing", "database") }),
        step("last", "t.note", { database: maybeFromStep("gone", "database") }),
      ],
      finally: ["last"],
    });
    expect(structureErrors(document)).toEqual([
      {
        _tag: "UnknownStep",
        step: "missing",
        at: { _tag: "Input", step: "first", input: "database" },
      },
      { _tag: "UnknownStep", step: "gone", at: { _tag: "Input", step: "last", input: "database" } },
    ]);
  });

  it("reports a binding to an output its step does not have, inherited names included", () => {
    const document = one({
      nodes: [
        step("first", "t.make"),
        step("second", "t.use", {
          database: fromStep("first", "copy"),
          label: fromStep("first", "toString"),
        }),
        step("third", "t.act", {}, each(fromStep("first", "items"))),
        step("last", "t.note", { database: maybeFromStep("first", "other") }),
      ],
      edges: chain("first", "second", "third"),
      finally: ["last"],
      invariants: [{ rule: "CleanedUp", step: "first", output: "temp" }],
    });
    expect(structureErrors(document)).toEqual([
      {
        _tag: "UnknownStepOutput",
        step: "first",
        output: "copy",
        at: { _tag: "Input", step: "second", input: "database" },
      },
      {
        _tag: "UnknownStepOutput",
        step: "first",
        output: "toString",
        at: { _tag: "Input", step: "second", input: "label" },
      },
      {
        _tag: "UnknownStepOutput",
        step: "first",
        output: "items",
        at: { _tag: "ForEachOver", step: "third" },
      },
      {
        _tag: "UnknownStepOutput",
        step: "first",
        output: "other",
        at: { _tag: "Input", step: "last", input: "database" },
      },
      {
        _tag: "UnknownStepOutput",
        step: "first",
        output: "temp",
        at: { _tag: "Invariant", index: 0, rule: "CleanedUp" },
      },
    ]);
  });

  it("reports an unknown block once, not again for each binding to its outputs", () => {
    const document = one({
      nodes: [
        step("first", "t.unknown"),
        step("second", "t.use", { database: fromStep("first", "database") }),
      ],
      edges: chain("first", "second"),
    });
    expect(structureErrors(document)).toEqual([
      { _tag: "UnknownBlock", step: "first", block: "t.unknown", version: 1 },
    ]);
  });

  it("reports a step that start does not reach, but not a finally step", () => {
    const document = one({
      nodes: [
        step("first", "t.act"),
        step("second", "t.act"),
        step("island", "t.act"),
        step("beyond", "t.act"),
        step("last", "t.act"),
      ],
      edges: [...chain("first", "second"), ...chain("island", "beyond")],
      finally: ["last"],
    });
    expect(structureErrors(document)).toEqual([
      { _tag: "Unreachable", step: "island" },
      { _tag: "Unreachable", step: "beyond" },
    ]);
  });

  it("follows every edge when looking for unreachable steps, failed ones and joins included", () => {
    const document = one({
      nodes: ["first", "second", "third", "fourth"].map((id) => step(id, "t.act")),
      edges: [
        edge("first", "Succeeded", "second"),
        edge("first", "Failed", "third"),
        edge("second", "Succeeded", "fourth"),
        edge("third", "Succeeded", "fourth"),
      ],
    });
    expect(structureErrors(document)).toEqual([]);
  });

  it("does not report every step as unreachable when start itself is unknown", () => {
    const document = one({ start: "missing", nodes: [step("first", "t.act")] });
    expect(structureErrors(document)).toEqual([
      { _tag: "UnknownStep", step: "missing", at: { _tag: "Start" } },
    ]);
  });

  it("reports a finally step that reads a step output, as an input or as its for-each list", () => {
    const document = one({
      nodes: [
        step("first", "t.make"),
        step("last", "t.note", { database: fromStep("first", "database") }),
        step("lastEach", "t.act", {}, each(fromStep("first", "name"))),
      ],
      finally: ["last", "lastEach"],
    });
    expect(structureErrors(document)).toEqual([
      {
        _tag: "FinallyStepUsesStepOutput",
        step: "last",
        at: { _tag: "Input", step: "last", input: "database" },
      },
      {
        _tag: "FinallyStepUsesStepOutput",
        step: "lastEach",
        at: { _tag: "ForEachOver", step: "lastEach" },
      },
    ]);
  });

  it("reports a gate as a finally step, and a gate as a for-each", () => {
    const document = one({
      inputs: { names: { type: list(text) } },
      nodes: [
        step("first", "t.gate", {}, each(fromRecipe("names"))),
        step("last", "t.gate"),
        step("lastAct", "t.act", {}, each(fromRecipe("names"))),
      ],
      finally: ["last", "lastAct"],
    });
    expect(structureErrors(document)).toEqual([
      { _tag: "ForEachGate", step: "first" },
      { _tag: "FinallyStepIsGate", step: "last" },
    ]);
  });

  it("reports the for-each item used outside a for-each, or as the for-each's own list", () => {
    const document = one({
      nodes: [
        step("first", "t.use", { database: item }),
        step("second", "t.use", { database: item }, each(item)),
      ],
      edges: chain("first", "second"),
    });
    expect(structureErrors(document)).toEqual([
      {
        _tag: "ForEachItemOutsideForEach",
        at: { _tag: "Input", step: "first", input: "database" },
      },
      { _tag: "ForEachItemOutsideForEach", at: { _tag: "ForEachOver", step: "second" } },
    ]);
  });

  it("reports an invariant that names a step that does not exist", () => {
    const document = one({
      invariants: [
        { rule: "RequiredForSuccess", step: "a" },
        { rule: "AfterFailure", step: "b", then: "first" },
        { rule: "AfterFailure", step: "first", then: "c" },
        { rule: "DestroysOnlyApproved", gate: "d" },
        { rule: "OnlyAfter", step: "e", requires: ["first", "f"] },
        { rule: "CleanedUp", step: "g", output: "database" },
      ],
    });
    const at = (index: number, rule: string) => ({ _tag: "Invariant", index, rule });
    expect(structureErrors(document)).toEqual([
      { _tag: "UnknownStep", step: "a", at: at(0, "RequiredForSuccess") },
      { _tag: "UnknownStep", step: "b", at: at(1, "AfterFailure") },
      { _tag: "UnknownStep", step: "c", at: at(2, "AfterFailure") },
      { _tag: "UnknownStep", step: "d", at: at(3, "DestroysOnlyApproved") },
      { _tag: "UnknownStep", step: "e", at: at(4, "OnlyAfter") },
      { _tag: "UnknownStep", step: "f", at: at(4, "OnlyAfter") },
      { _tag: "UnknownStep", step: "g", at: at(5, "CleanedUp") },
    ]);
  });

  it("returns every error of the stage at once", () => {
    const document = one({
      start: "missing",
      nodes: [step("first", "t.unknown"), step("first", "t.gate")],
      edges: [edge("first", "Succeeded", "gone")],
      finally: ["absent"],
    });
    expect(structureErrors(document)).toEqual([
      { _tag: "DuplicateStepId", step: "first" },
      { _tag: "UnknownBlock", step: "first", block: "t.unknown", version: 1 },
      { _tag: "UnknownStep", step: "missing", at: { _tag: "Start" } },
      { _tag: "UnknownStep", step: "absent", at: { _tag: "Finally" } },
      { _tag: "UnknownStep", step: "gone", at: { _tag: "Edge", from: "first", on: "Succeeded" } },
      { _tag: "OutcomeDoesNotFitKind", from: "first", on: "Succeeded", kind: "Gate" },
    ]);
  });
});
