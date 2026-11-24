import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import type { Recipe } from "../index";
import type { Json, Parts } from "../testing/build";
import { DataType, validate } from "../index";
import {
  block,
  boolean,
  chain,
  creates,
  database,
  duration,
  each,
  edge,
  fromInput,
  fromOutput,
  fromRecipe,
  fromStep,
  integer,
  item,
  list,
  literal,
  maybeFromStep,
  noUndo,
  optional,
  recipe,
  required,
  resource,
  step,
  struct,
  text,
  timestamp,
  undoWith,
  writes,
} from "../testing/build";
import { literalFits } from "./wiring";

const other = resource("test.other");

const catalog = [
  block("t.act"),
  block("t.gate", { kind: "Gate", outputs: { approved: list(database) } }),
  block("t.make", { outputs: { database, name: text } }),
  block("t.use", { inputs: { database: required(database), label: optional(text) } }),
  block("t.note", { inputs: { database: optional(database), label: optional(text) } }),
  block("t.needsBoth", { inputs: { database: required(database), label: required(text) } }),
  block("t.takes", {
    inputs: {
      label: optional(text),
      count: optional(integer),
      flag: optional(boolean),
      wait: optional(duration),
      when: optional(timestamp),
      target: optional(database),
      names: optional(list(text)),
      options: optional(struct({ name: text, depth: integer })),
    },
  }),
];

const wiringErrors = (document: Recipe, blocks = catalog) => {
  const result = validate(document, blocks);
  if (Result.isSuccess(result)) {
    return [];
  }
  switch (result.failure._tag) {
    case "Wiring": {
      return result.failure.errors;
    }
    // Stopped before this stage: not an answer about wiring, so it fails any expectation.
    case "Structure":
    case "Size":
    case "Cycle": {
      return result.failure;
    }
    // Passed this stage.
    case "TooManyPaths":
    case "Invariants": {
      return [];
    }
  }
};

const inputs = { production: { type: database }, title: { type: text } };
const at = (stepId: string, input: string) => ({ _tag: "Input", step: stepId, input });

describe("types (stage 5)", () => {
  it("reports a required input that is not bound, and leaves an optional one alone", () => {
    const document = recipe({ nodes: [step("first", "t.needsBoth")] });
    expect(wiringErrors(document)).toEqual([
      { _tag: "RequiredInputNotBound", step: "first", input: "database" },
      { _tag: "RequiredInputNotBound", step: "first", input: "label" },
    ]);
    expect(wiringErrors(recipe({ nodes: [step("first", "t.note")] }))).toEqual([]);
  });

  it("accepts a recipe input of the input's type, into a required or an optional input", () => {
    const document = recipe({
      inputs,
      nodes: [
        step("first", "t.use", { database: fromRecipe("production"), label: fromRecipe("title") }),
      ],
    });
    expect(wiringErrors(document)).toEqual([]);
  });

  it("reports a recipe input of another type", () => {
    const document = recipe({
      inputs,
      nodes: [
        step("first", "t.use", { database: fromRecipe("title"), label: fromRecipe("production") }),
      ],
    });
    expect(wiringErrors(document)).toEqual([
      { _tag: "TypeMismatch", at: at("first", "database"), expected: database, actual: text },
      { _tag: "TypeMismatch", at: at("first", "label"), expected: text, actual: database },
    ]);
  });

  it("reports a step output of another type", () => {
    const document = recipe({
      nodes: [
        step("first", "t.make"),
        step("second", "t.use", {
          database: fromStep("first", "name"),
          label: fromStep("first", "database"),
        }),
      ],
      edges: chain("first", "second"),
    });
    expect(wiringErrors(document)).toEqual([
      { _tag: "TypeMismatch", at: at("second", "database"), expected: database, actual: text },
      { _tag: "TypeMismatch", at: at("second", "label"), expected: text, actual: database },
    ]);
  });

  it("types the output of a for-each step as a list", () => {
    const blocks = [
      ...catalog,
      block("t.copy", { inputs: { source: required(database) }, outputs: { copy: database } }),
      block("t.useAll", { inputs: { databases: required(list(database)) } }),
    ];
    const nodes = [
      step("first", "t.copy", { source: item }, each(fromRecipe("all"))),
      step("second", "t.useAll", { databases: fromStep("first", "copy") }),
      step("third", "t.use", { database: fromStep("first", "copy") }),
    ];
    const document = recipe({
      inputs: { all: { type: list(database) } },
      nodes,
      edges: chain("first", "second", "third"),
    });
    expect(wiringErrors(document, blocks)).toEqual([
      {
        _tag: "TypeMismatch",
        at: at("third", "database"),
        expected: database,
        actual: list(database),
      },
    ]);
  });

  it("types the for-each item as the item of the list, from a recipe input or a step output", () => {
    const document = recipe({
      inputs: { all: { type: list(database) }, names: { type: list(text) } },
      nodes: [
        step("first", "t.gate"),
        step("second", "t.use", { database: item }, each(fromRecipe("all"))),
        step("third", "t.use", { database: item }, each(fromStep("first", "approved"))),
        step("fourth", "t.use", { database: item }, each(fromRecipe("names"))),
      ],
      edges: [edge("first", "Approved", "second"), ...chain("second", "third", "fourth")],
    });
    expect(wiringErrors(document)).toEqual([
      { _tag: "TypeMismatch", at: at("fourth", "database"), expected: database, actual: text },
    ]);
  });

  it("reports a for-each over something that is not a list, once", () => {
    const document = recipe({
      inputs,
      nodes: [step("first", "t.use", { database: item }, each(fromRecipe("production")))],
    });
    expect(wiringErrors(document)).toEqual([
      { _tag: "ForEachOverNotList", step: "first", actual: database },
    ]);
  });

  it("reports a for-each over a literal or over an optional step output", () => {
    const document = recipe({
      nodes: [
        step("first", "t.gate"),
        step("second", "t.note", { label: item }, each(literal(["a", "b"]))),
        step("last", "t.note", { database: item }, each(maybeFromStep("first", "approved"))),
      ],
      edges: [edge("first", "Approved", "second")],
      finally: ["last"],
    });
    expect(wiringErrors(document)).toEqual([
      { _tag: "ForEachOverNotAllowed", step: "second", binding: "Literal" },
      { _tag: "ForEachOverNotAllowed", step: "last", binding: "OptionalStepOutput" },
    ]);
  });

  it("accepts an optional step output in a finally step, into an optional input", () => {
    const document = recipe({
      nodes: [
        step("first", "t.make"),
        step("last", "t.note", {
          database: maybeFromStep("first", "database"),
          label: maybeFromStep("first", "name"),
        }),
      ],
      finally: ["last"],
    });
    expect(wiringErrors(document)).toEqual([]);
  });

  it("reports an optional step output outside a finally step", () => {
    const document = recipe({
      nodes: [
        step("first", "t.make"),
        step("second", "t.note", { database: maybeFromStep("first", "database") }),
      ],
      edges: chain("first", "second"),
    });
    expect(wiringErrors(document)).toEqual([
      { _tag: "OptionalOutputOutsideFinally", step: "second", input: "database" },
    ]);
  });

  it("reports an optional step output into a required input, and one of another type", () => {
    const document = recipe({
      nodes: [
        step("first", "t.make"),
        step("last", "t.use", {
          database: maybeFromStep("first", "database"),
          label: maybeFromStep("first", "database"),
        }),
      ],
      finally: ["last"],
    });
    expect(wiringErrors(document)).toEqual([
      { _tag: "OptionalOutputIntoRequired", step: "last", input: "database" },
      { _tag: "TypeMismatch", at: at("last", "label"), expected: text, actual: database },
    ]);
  });

  it("reports a literal that does not fit, and never accepts one for a resource", () => {
    const document = recipe({
      nodes: [
        step("first", "t.takes", {
          label: literal(1),
          count: literal("one"),
          target: literal("production"),
          wait: literal("PT1M"),
        }),
        step("second", "t.takes", { label: literal("drill"), count: literal(3) }),
      ],
      edges: chain("first", "second"),
    });
    expect(wiringErrors(document)).toEqual([
      { _tag: "LiteralDoesNotFit", step: "first", input: "label", expected: text },
      { _tag: "LiteralDoesNotFit", step: "first", input: "count", expected: integer },
      { _tag: "LiteralDoesNotFit", step: "first", input: "target", expected: database },
      { _tag: "LiteralDoesNotFit", step: "first", input: "wait", expected: duration },
    ]);
  });
});

describe("literalFits", () => {
  const type = Schema.decodeUnknownSync(DataType);
  const options = struct({ name: text, depth: integer });

  it.each([
    ["text", text, "drill"],
    ["an empty text", text, ""],
    ["a whole number", integer, 3],
    ["zero", integer, 0],
    ["a negative whole number", integer, -3],
    ["a boolean", boolean, false],
    ["a list", list(text), ["a", "b"]],
    ["an empty list", list(database), []],
    ["a list of lists", list(list(integer)), [[1], [], [2, 3]]],
    ["a struct", options, { name: "a", depth: 1 }],
    ["a struct with its fields in another order", options, { depth: 1, name: "a" }],
    ["an empty struct", struct({}), {}],
    ["a struct of structs", struct({ inner: options }), { inner: { name: "a", depth: 1 } }],
  ])("accepts %s", (_, expected, value) => {
    expect(literalFits(type(expected), value)).toBe(true);
  });

  it.each([
    ["a number for text", text, 1],
    ["a boolean for text", text, true],
    ["text for an integer", integer, "1"],
    ["a fraction for an integer", integer, 1.5],
    ["a number too large to be exact for an integer", integer, 2 ** 53],
    ["a number for a boolean", boolean, 0],
    ["text for a boolean", boolean, "true"],
    ["text for a list", list(text), "a"],
    ["a struct for a list", list(text), { length: 0 }],
    ["a list with one item of another type", list(text), ["a", 1]],
    ["a list for a struct", struct({}), []],
    ["empty text for an empty struct", struct({}), ""],
    ["a number for an empty struct", struct({}), 0],
    ["a boolean for an empty struct", struct({}), true],
    ["text for a struct", options, "a"],
    ["a struct with a field missing", options, { name: "a" }],
    ["a struct with an extra field", options, { name: "a", depth: 1, extra: true }],
    ["a struct with a field under another name", options, { name: "a", deep: 1 }],
    ["a struct with a field of another type", options, { name: "a", depth: "1" }],
    ["a struct that only inherits the field", struct({ toString: text }), { name: "a" }],
    ["text for a duration", duration, "PT1M"],
    ["a number for a duration", duration, 60],
    ["text for a timestamp", timestamp, "2026-11-23T00:00:00Z"],
    ["text for a resource", database, "production"],
    ["a struct for a resource", database, { id: "production" }],
    ["a list of text for a list of resources", list(other), ["a"]],
  ])("rejects %s", (_, expected, value) => {
    expect(literalFits(type(expected), value)).toBe(false);
  });
});

describe("references (stage 5)", () => {
  const useOf = (producer: string) =>
    step("use", "t.use", { database: fromStep(producer, "database") });

  it("accepts a step output whose step succeeded on every path to its user", () => {
    const document = recipe({
      start: "make",
      nodes: [step("make", "t.make"), step("middle", "t.act"), useOf("make")],
      edges: [
        edge("make", "Succeeded", "middle"),
        edge("middle", "Succeeded", "use"),
        edge("middle", "Failed", "use"),
      ],
    });
    expect(wiringErrors(document)).toEqual([]);
  });

  it("accepts a gate's output after it was approved, and not after it was denied", () => {
    const eachApproved = (id: string) =>
      step(id, "t.use", { database: item }, each(fromStep("gate", "approved")));
    const approved = recipe({
      start: "gate",
      nodes: [step("gate", "t.gate"), eachApproved("use")],
      edges: [edge("gate", "Approved", "use")],
    });
    expect(wiringErrors(approved)).toEqual([]);
    const denied = recipe({
      start: "gate",
      nodes: [step("gate", "t.gate"), eachApproved("use")],
      edges: [edge("gate", "Denied", "use")],
    });
    expect(wiringErrors(denied)).toEqual([
      {
        _tag: "OutputNotGuaranteed",
        at: { _tag: "ForEachOver", step: "use" },
        producer: "gate",
        path: [{ step: "gate", outcome: "Denied" }],
      },
    ]);
  });

  it("reports an output read after its step failed, with the path", () => {
    const document = recipe({
      start: "make",
      nodes: [step("make", "t.make"), useOf("make")],
      edges: [edge("make", "Failed", "use")],
    });
    expect(wiringErrors(document)).toEqual([
      {
        _tag: "OutputNotGuaranteed",
        at: at("use", "database"),
        producer: "make",
        path: [{ step: "make", outcome: "Failed" }],
      },
    ]);
  });

  it("reports an output that is there on one path and not on another, with the path where it is not", () => {
    const document = recipe({
      start: "first",
      nodes: [step("first", "t.act"), step("make", "t.make"), step("skip", "t.act"), useOf("make")],
      edges: [
        edge("first", "Succeeded", "make"),
        edge("first", "Failed", "skip"),
        edge("make", "Succeeded", "use"),
        edge("skip", "Succeeded", "use"),
      ],
    });
    expect(wiringErrors(document)).toEqual([
      {
        _tag: "OutputNotGuaranteed",
        at: at("use", "database"),
        producer: "make",
        path: [
          { step: "first", outcome: "Failed" },
          { step: "skip", outcome: "Succeeded" },
        ],
      },
    ]);
  });

  it("keeps a guarantee through a join only when every way in has it", () => {
    // Both ways into `join` pass `make`, so `use` may read it; only one passes `left`.
    const document = recipe({
      start: "make",
      nodes: [
        step("make", "t.make"),
        step("left", "t.make"),
        step("right", "t.act"),
        step("join", "t.act"),
        useOf("make"),
        step("useLeft", "t.use", { database: fromStep("left", "database") }),
      ],
      edges: [
        edge("make", "Succeeded", "left"),
        edge("left", "Succeeded", "join"),
        edge("left", "Failed", "right"),
        edge("right", "Succeeded", "join"),
        edge("join", "Succeeded", "use"),
        edge("use", "Succeeded", "useLeft"),
      ],
    });
    expect(wiringErrors(document)).toEqual([
      {
        _tag: "OutputNotGuaranteed",
        at: at("useLeft", "database"),
        producer: "left",
        path: [
          { step: "make", outcome: "Succeeded" },
          { step: "left", outcome: "Failed" },
          { step: "right", outcome: "Succeeded" },
          { step: "join", outcome: "Succeeded" },
          { step: "use", outcome: "Succeeded" },
        ],
      },
    ]);
  });

  it("reports a step that reads its own output, a later step's, or a finally step's", () => {
    const document = recipe({
      start: "first",
      nodes: [
        step("first", "t.use", { database: fromStep("first", "database") }, { block: "t.loop" }),
        step("second", "t.use", { database: fromStep("third", "database") }),
        step("third", "t.make"),
        step("fourth", "t.use", { database: fromStep("last", "database") }),
        step("last", "t.make"),
      ],
      edges: chain("first", "second", "third", "fourth"),
      finally: ["last"],
    });
    const blocks = [
      ...catalog,
      block("t.loop", { inputs: { database: required(database) }, outputs: { database } }),
    ];
    expect(wiringErrors(document, blocks)).toEqual([
      { _tag: "OutputNotGuaranteed", at: at("first", "database"), producer: "first", path: [] },
      {
        _tag: "OutputNotGuaranteed",
        at: at("second", "database"),
        producer: "third",
        path: [{ step: "first", outcome: "Succeeded" }],
      },
      {
        _tag: "OutputNotGuaranteed",
        at: at("fourth", "database"),
        producer: "last",
        path: [
          { step: "first", outcome: "Succeeded" },
          { step: "second", outcome: "Succeeded" },
          { step: "third", outcome: "Succeeded" },
        ],
      },
    ]);
  });
});

describe("undo blocks (stage 5)", () => {
  const undoable = (undo: Json, parts: Parts = {}) =>
    block("t.change", {
      inputs: { target: required(database), label: optional(text), note: required(text) },
      outputs: { made: database, count: integer },
      effects: [writes("target"), creates("made", "Durable")],
      undo,
      ...parts,
    });
  const revert = (parts: Parts) => block("t.revert", { undo: noUndo, ...parts });
  const document = recipe({
    inputs,
    nodes: [
      step("first", "t.change", { target: fromRecipe("production"), note: fromRecipe("title") }),
    ],
  });
  const errors = (undo: Json, revertParts: Parts) =>
    wiringErrors(document, [undoable(undo), revert(revertParts)]);

  it("accepts an undo fed by name and type from its step's inputs and outputs", () => {
    const fed = undoWith("t.revert", {
      database: fromInput("target"),
      label: fromInput("label"),
      made: fromOutput("made"),
    });
    expect(
      errors(fed, {
        inputs: {
          database: required(database),
          label: optional(text),
          made: required(database),
          spare: optional(database),
        },
        effects: [writes("database"), writes("made"), writes("spare")],
      }),
    ).toEqual([]);
  });

  it("reports a mapping for an input the undo block does not have, inherited names included", () => {
    const fed = undoWith("t.revert", {
      other: fromInput("target"),
      toString: fromOutput("made"),
    });
    expect(errors(fed, {})).toEqual([
      { _tag: "UndoInputUnknown", step: "first", input: "other" },
      { _tag: "UndoInputUnknown", step: "first", input: "toString" },
    ]);
  });

  it("reports a required undo input that nothing feeds, and leaves an optional one alone", () => {
    expect(
      errors(undoWith("t.revert"), {
        inputs: { database: required(database), label: optional(text) },
      }),
    ).toEqual([{ _tag: "UndoInputNotFed", step: "first", input: "database" }]);
  });

  it("reports an undo input fed a value of another type, from an input or an output", () => {
    const fed = undoWith("t.revert", { database: fromInput("note"), count: fromOutput("made") });
    expect(
      errors(fed, { inputs: { database: required(database), count: required(integer) } }),
    ).toEqual([
      {
        _tag: "UndoTypeMismatch",
        step: "first",
        input: "database",
        expected: database,
        actual: text,
      },
      {
        _tag: "UndoTypeMismatch",
        step: "first",
        input: "count",
        expected: integer,
        actual: database,
      },
    ]);
  });

  it("reports a required undo input fed from an optional step input", () => {
    const fed = undoWith("t.revert", { label: fromInput("label"), other: fromInput("label") });
    expect(errors(fed, { inputs: { label: required(text), other: optional(text) } })).toEqual([
      { _tag: "UndoOptionalIntoRequired", step: "first", input: "label" },
    ]);
  });

  it("feeds the undo of a for-each step one item's output, not the list", () => {
    const blocks = [
      block("t.copy", {
        inputs: { source: required(database) },
        outputs: { copy: database },
        effects: [creates("copy", "Durable")],
        undo: undoWith("t.revert", { database: fromOutput("copy") }),
      }),
      revert({ inputs: { database: required(database) }, effects: [writes("database")] }),
    ];
    const forEach = recipe({
      inputs: { all: { type: list(database) } },
      nodes: [step("first", "t.copy", { source: item }, each(fromRecipe("all")))],
    });
    expect(wiringErrors(forEach, blocks)).toEqual([]);
  });

  const withEffect = (effect: string, source: Json, type: Json) =>
    errors(undoWith("t.revert", { thing: source }), {
      inputs: { thing: required(type) },
      effects: [{ _tag: effect === "writes" ? "Writes" : "Destroys", input: "thing" }],
    });

  it.each([
    ["writes", "an input its step only read", fromInput("note"), text],
    ["writes", "an output its step did not create", fromOutput("count"), integer],
    ["destroys", "an input its step only read", fromInput("note"), text],
    ["destroys", "an output its step did not create", fromOutput("count"), integer],
    // Destroying what the step merely wrote is not taking the write back.
    ["destroys", "an input its step wrote", fromInput("target"), database],
  ])("reports an undo block that %s %s", (effect, _, source, type) => {
    expect(withEffect(effect, source, type)).toEqual([
      { _tag: "UndoChangesUntouched", step: "first", input: "thing" },
    ]);
  });

  it.each([
    ["writes", "what its step wrote", fromInput("target")],
    ["writes", "what its step created", fromOutput("made")],
    ["destroys", "what its step created", fromOutput("made")],
  ])("accepts an undo block that %s %s", (effect, _, source) => {
    expect(withEffect(effect, source, database)).toEqual([]);
  });

  it("does not take a write of one input, or the creation of one output, for another's", () => {
    // The step writes `target` and creates `made`; the undo is fed `target` under the name of
    // an output and `made` under the name of an input, so neither effect covers it.
    const crossed = block("t.change", {
      inputs: { target: required(database), made: required(database) },
      outputs: { made: database, target: database },
      effects: [writes("target"), creates("made", "Durable")],
      undo: undoWith("t.revert", { first: fromOutput("target"), second: fromInput("made") }),
    });
    const blocks = [
      crossed,
      revert({
        inputs: { first: required(database), second: required(database) },
        effects: [writes("first"), writes("second")],
      }),
    ];
    const crossedRecipe = recipe({
      inputs,
      nodes: [
        step("first", "t.change", {
          target: fromRecipe("production"),
          made: fromRecipe("production"),
        }),
      ],
    });
    expect(wiringErrors(crossedRecipe, blocks)).toEqual([
      { _tag: "UndoChangesUntouched", step: "first", input: "first" },
      { _tag: "UndoChangesUntouched", step: "first", input: "second" },
    ]);
  });

  it("lets an undo block read anything its step can give it", () => {
    const fed = undoWith("t.revert", { thing: fromInput("note") });
    expect(
      errors(fed, {
        inputs: { thing: required(text) },
        effects: [{ _tag: "Reads", input: "thing" }],
      }),
    ).toEqual([]);
  });

  it("returns every error of the stage at once", () => {
    const all = recipe({
      inputs,
      nodes: [
        step("first", "t.use", { label: literal(1) }),
        step("second", "t.use", { database: fromRecipe("title") }),
      ],
      edges: chain("first", "second"),
    });
    expect(wiringErrors(all)).toEqual([
      { _tag: "RequiredInputNotBound", step: "first", input: "database" },
      { _tag: "LiteralDoesNotFit", step: "first", input: "label", expected: text },
      { _tag: "TypeMismatch", at: at("second", "database"), expected: database, actual: text },
    ]);
  });
});
