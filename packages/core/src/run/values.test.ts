import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import type { ResolvedStep } from "../index";
import { inputsOf, itemsOf, sizeOf, undoInputsOf, valuesOf } from "../index";
import type { Parts } from "../testing/build";
import {
  block,
  chain,
  creates,
  database,
  each,
  fromInput,
  fromOutput,
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
  text,
  undoWith,
  writes,
} from "../testing/build";
import {
  approved,
  gateOpened,
  logOf,
  runStarted,
  stepFailed,
  stepStarted,
  stepSucceeded,
} from "../testing/events";
import { planOf } from "../testing/play";

const some = Option.some;
const none = Option.none();
const db = (id: string) => ({ kind: "test.database", id });

const catalog = [
  // Lists what there is to work on.
  block("t.list", { outputs: { found: list(database), note: text } }),
  block("t.gate", { kind: "Gate", outputs: { approved: list(database) } }),
  // Copies one thing, and can take the copy back.
  block("t.copy", {
    inputs: { source: required(database), label: required(text), hint: optional(text) },
    outputs: { copy: database },
    effects: [creates("copy", "Durable")],
    undo: undoWith("t.uncopy", {
      copy: fromOutput("copy"),
      label: fromInput("label"),
      hint: fromInput("hint"),
    }),
  }),
  block("t.uncopy", {
    inputs: {
      copy: required(database),
      label: required(text),
      hint: optional(text),
      unfed: optional(text),
    },
    effects: [writes("copy")],
    undo: noUndo,
  }),
  block("t.report", {
    inputs: { copies: optional(list(database)), note: optional(text), first: optional(database) },
  }),
];

// find → approve → copy each approved thing → copy one more, then report.
const plan = planOf(
  recipe({
    start: "find",
    inputs: { extra: { type: database }, things: { type: list(database) } },
    nodes: [
      step("find", "t.list"),
      step("approve", "t.gate"),
      step(
        "copies",
        "t.copy",
        { source: item, label: literal("nightly") },
        each(fromStep("approve", "approved")),
      ),
      step("one", "t.copy", {
        source: fromRecipe("extra"),
        label: fromStep("find", "note"),
        hint: literal("last"),
      }),
      step("report", "t.report", {
        copies: maybeFromStep("copies", "copy"),
        note: maybeFromStep("find", "note"),
        first: maybeFromStep("one", "copy"),
      }),
      step("again", "t.report", {}, each(fromRecipe("things"))),
    ],
    edges: [
      { from: "find", on: "Succeeded", to: { _tag: "Step", id: "approve" } },
      { from: "approve", on: "Approved", to: { _tag: "Step", id: "copies" } },
      ...chain("copies", "one"),
    ],
    finally: ["report", "again"],
  }),
  catalog,
);
const stepNamed = (id: string): ResolvedStep => {
  const found = [...plan.resolved.main, ...plan.resolved.finally].find(
    (candidate) => candidate.step.id === id,
  );
  if (found === undefined) {
    throw new Error(`no step ${id}`);
  }
  return found;
};

const started: Parts = { ...runStarted, inputs: { extra: db("x"), things: [db("t1"), db("t2")] } };
const found: ReadonlyArray<Parts> = [
  started,
  stepStarted("find"),
  { ...stepSucceeded("find"), outputs: { found: [db("a"), db("b"), db("c")], note: "three" } },
];
const approvedTwo: ReadonlyArray<Parts> = [
  ...found,
  gateOpened("approve"),
  { ...approved("approve"), outputs: { approved: [db("a"), db("c")] } },
];
const copied = (index: number, id: string): ReadonlyArray<Parts> => [
  stepStarted("copies", { item: index }),
  { ...stepSucceeded("copies", { item: index }), outputs: { copy: db(id) } },
];
const valuesAfter = (facts: ReadonlyArray<Parts>) => valuesOf(logOf(facts));

describe("valuesOf", () => {
  it("holds nothing for an empty log", () => {
    expect(valuesOf([])).toEqual({ inputs: {}, outputs: new Map() });
  });

  it("reads the run's inputs, what each step produced and what each gate approved", () => {
    const values = valuesAfter([...approvedTwo, ...copied(1, "c2"), ...copied(0, "a2")]);
    expect(values.inputs).toEqual({ extra: db("x"), things: [db("t1"), db("t2")] });
    const of = (entries: ReadonlyArray<[number | undefined, Parts]>) => new Map(entries);
    expect(values.outputs).toEqual(
      new Map([
        ["find", of([[undefined, { found: [db("a"), db("b"), db("c")], note: "three" }]])],
        ["approve", of([[undefined, { approved: [db("a"), db("c")] }]])],
        [
          "copies",
          of([
            [1, { copy: db("c2") }],
            [0, { copy: db("a2") }],
          ]),
        ],
      ]),
    );
  });

  it("holds nothing for work that failed or has not ended", () => {
    const values = valuesAfter([started, stepStarted("find"), stepFailed("find")]);
    expect(values.outputs).toEqual(new Map());
  });
});

describe("itemsOf and sizeOf", () => {
  it("is the list a for-each runs over, once its source has produced it", () => {
    const copies = stepNamed("copies");
    expect(itemsOf(plan.resolved, copies, valuesAfter(found))).toEqual(none);
    expect(sizeOf(plan.resolved, copies, valuesAfter(found))).toBe(0);
    expect(itemsOf(plan.resolved, copies, valuesAfter(approvedTwo))).toEqual(
      some([db("a"), db("c")]),
    );
    expect(sizeOf(plan.resolved, copies, valuesAfter(approvedTwo))).toBe(2);
    expect(sizeOf(plan.resolved, stepNamed("again"), valuesAfter([started]))).toBe(2);
  });

  it("is nothing for a step that is not a for-each", () => {
    expect(itemsOf(plan.resolved, stepNamed("one"), valuesAfter(approvedTwo))).toEqual(none);
    expect(sizeOf(plan.resolved, stepNamed("find"), valuesAfter(approvedTwo))).toBe(0);
  });

  it("is nothing when what should be a list is not one", () => {
    const wrong = valuesAfter([
      ...found,
      gateOpened("approve"),
      { ...approved("approve"), outputs: { approved: "all of them" } },
    ]);
    expect(itemsOf(plan.resolved, stepNamed("copies"), wrong)).toEqual(none);
    expect(sizeOf(plan.resolved, stepNamed("copies"), wrong)).toBe(0);
  });
});

describe("inputsOf", () => {
  it("gives a for-each item its item, and every literal as written", () => {
    const values = valuesAfter(approvedTwo);
    expect(inputsOf(plan.resolved, stepNamed("copies"), values, 0)).toEqual({
      source: some(db("a")),
      label: some("nightly"),
      hint: none,
    });
    expect(inputsOf(plan.resolved, stepNamed("copies"), values, 1).source).toEqual(some(db("c")));
    // Past the end of the list there is no item.
    expect(inputsOf(plan.resolved, stepNamed("copies"), values, 2).source).toEqual(none);
    expect(inputsOf(plan.resolved, stepNamed("copies"), values, undefined).source).toEqual(none);
  });

  it("reads a recipe input and a step's output", () => {
    expect(inputsOf(plan.resolved, stepNamed("one"), valuesAfter(approvedTwo), undefined)).toEqual({
      source: some(db("x")),
      label: some("three"),
      hint: some("last"),
    });
    // Before the step that produces it has succeeded, there is nothing to read.
    expect(inputsOf(plan.resolved, stepNamed("one"), valuesAfter([started]), undefined)).toEqual({
      source: some(db("x")),
      label: none,
      hint: some("last"),
    });
  });

  it("has an entry for every input the block declares, bound or not", () => {
    expect(inputsOf(plan.resolved, stepNamed("again"), valuesAfter([started]), 0)).toEqual({
      copies: none,
      note: none,
      first: none,
    });
  });

  it("gives a for-each's output as the list of its items' outputs, in item order", () => {
    const all = valuesAfter([...approvedTwo, ...copied(1, "c2"), ...copied(0, "a2")]);
    expect(inputsOf(plan.resolved, stepNamed("report"), all, undefined)).toEqual({
      copies: some([db("a2"), db("c2")]),
      note: some("three"),
      first: none,
    });
  });

  it("gives nothing for a for-each that has not succeeded in full, or has no list yet", () => {
    const part = valuesAfter([...approvedTwo, ...copied(1, "c2")]);
    expect(inputsOf(plan.resolved, stepNamed("report"), part, undefined).copies).toEqual(none);
    expect(inputsOf(plan.resolved, stepNamed("report"), valuesAfter(found), undefined)).toEqual({
      copies: none,
      note: some("three"),
      first: none,
    });
  });

  it("gives an empty list for a for-each over an empty list", () => {
    const empty = valuesAfter([
      ...found,
      gateOpened("approve"),
      { ...approved("approve"), outputs: { approved: [] } },
    ]);
    expect(inputsOf(plan.resolved, stepNamed("report"), empty, undefined).copies).toEqual(some([]));
  });

  it("does not take an inherited property for a value", () => {
    const odd = planOf(
      recipe({
        start: "a",
        inputs: { toString: { type: text } },
        nodes: [step("a", "t.report", { note: fromRecipe("toString") })],
      }),
      catalog,
    );
    const [a] = odd.resolved.main;
    expect(
      a === undefined ? undefined : inputsOf(odd.resolved, a, valuesOf([]), undefined).note,
    ).toEqual(none);
  });
});

describe("undoInputsOf", () => {
  const undoOf = (id: string) => {
    const target = stepNamed(id);
    return { target, undo: Option.getOrThrow(target.undo) };
  };

  it("feeds an undo from its step's inputs and outputs, as the block declares", () => {
    const { target, undo } = undoOf("one");
    const values = valuesAfter([
      ...approvedTwo,
      stepStarted("one"),
      { ...stepSucceeded("one"), outputs: { copy: db("x2") } },
    ]);
    expect(undoInputsOf(plan.resolved, target, undo, values, undefined)).toEqual({
      copy: some(db("x2")),
      label: some("three"),
      hint: some("last"),
      unfed: none,
    });
  });

  it("feeds the undo of a for-each item from that item", () => {
    const { target, undo } = undoOf("copies");
    const values = valuesAfter([...approvedTwo, ...copied(1, "c2"), ...copied(0, "a2")]);
    expect(undoInputsOf(plan.resolved, target, undo, values, 1)).toEqual({
      copy: some(db("c2")),
      label: some("nightly"),
      hint: none,
      unfed: none,
    });
    expect(undoInputsOf(plan.resolved, target, undo, values, 0).copy).toEqual(some(db("a2")));
  });

  it("gives nothing for an output the work did not produce", () => {
    const { target, undo } = undoOf("copies");
    expect(undoInputsOf(plan.resolved, target, undo, valuesAfter(approvedTwo), 0).copy).toEqual(
      none,
    );
  });
});
