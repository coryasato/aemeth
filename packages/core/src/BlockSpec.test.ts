import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { blockSpecProblems, BlockSpec } from "./index";

const strict = { onExcessProperty: "error" } as const;
const decode = Schema.decodeUnknownSync(BlockSpec, strict);
const accepts = (value: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(BlockSpec, strict)(value));

const problems = (spec: unknown) => blockSpecProblems(decode(spec));

const database = { _tag: "Resource", kind: "cloudflare.d1.database" };

/** Uses every data type, both input tags and every effect tag. */
const createCopy = {
  id: "d1.createCopy",
  version: 1,
  title: "Create a copy of a database",
  kind: "Action",
  inputs: {
    source: { _tag: "Required", type: database },
    label: { _tag: "Optional", type: { _tag: "Text" } },
    old: { _tag: "Optional", type: database },
    options: {
      _tag: "Required",
      type: {
        _tag: "Struct",
        fields: {
          tables: { _tag: "List", item: { _tag: "Text" } },
          limit: { _tag: "Integer" },
          strict: { _tag: "Boolean" },
          timeout: { _tag: "Duration" },
          asOf: { _tag: "Timestamp" },
        },
      },
    },
  },
  outputs: { copy: database, link: { _tag: "Text" } },
  effects: [
    { _tag: "Reads", input: "source" },
    { _tag: "Writes", input: "source" },
    { _tag: "Creates", output: "copy", lifetime: "Temporary" },
    { _tag: "Creates", output: "link", lifetime: "Expiring" },
    { _tag: "Destroys", input: "old" },
  ],
  undo: {
    _tag: "Undo",
    block: "d1.destroyDatabase",
    version: 2,
    inputs: {
      database: { _tag: "FromOutput", name: "copy" },
      label: { _tag: "FromInput", name: "label" },
    },
  },
  rerun: "SafeWithIdempotencyKey",
};

const check = {
  id: "d1.check",
  version: 3,
  title: "Check a database",
  kind: "Check",
  inputs: { database: { _tag: "Required", type: database } },
  outputs: {},
  effects: [{ _tag: "Reads", input: "database" }],
  undo: { _tag: "NothingToUndo" },
  rerun: "SafeWithIdempotencyKey",
};

const gate = { ...check, id: "gate.approve", kind: "Gate", inputs: {}, effects: [] };

const destroy = {
  ...check,
  id: "d1.destroyDatabase",
  kind: "Action",
  outputs: { receipt: { _tag: "Resource", kind: "cloudflare.d1.receipt" } },
  effects: [
    { _tag: "Destroys", input: "database" },
    { _tag: "Creates", output: "receipt", lifetime: "Durable" },
  ],
  undo: { _tag: "NoUndo", reason: "A destroyed database cannot be brought back." },
};

describe("BlockSpec", () => {
  it.each([createCopy, check, gate, destroy])("decodes $id unchanged", (spec) => {
    expect(decode(spec)).toEqual(spec);
  });

  it.each([
    ["an unknown field", { ...check, target: "production" }],
    ["an unknown kind", { ...check, kind: "Wait" }],
    ["a rerun policy other than the safe one", { ...check, rerun: "Unsafe" }],
    ["no rerun policy", { ...check, rerun: undefined }],
    ["an unknown input tag", { ...check, inputs: { database: { _tag: "Maybe", type: database } } }],
    [
      "an input name that is not camel case",
      { ...check, inputs: { "The DB": check.inputs.database } },
    ],
    ["an output name that is not camel case", { ...check, outputs: { "The DB": database } }],
    ["an unknown data type", { ...check, outputs: { count: { _tag: "Float" } } }],
    ["an unknown field in a data type", { ...check, outputs: { count: { _tag: "Text", max: 3 } } }],
    [
      "a struct field name that is not camel case",
      { ...check, outputs: { o: { _tag: "Struct", fields: { "a b": database } } } },
    ],
    ["an unknown effect", { ...check, effects: [{ _tag: "Deletes", input: "database" }] }],
    [
      "an unknown lifetime",
      { ...destroy, effects: [{ _tag: "Creates", output: "receipt", lifetime: "Forever" }] },
    ],
    ["an unknown undo", { ...check, undo: { _tag: "Maybe" } }],
    ["an undo with no reason", { ...destroy, undo: { _tag: "NoUndo", reason: "" } }],
    [
      "an undo block with no version",
      { ...destroy, undo: { _tag: "Undo", block: "d1.restore", inputs: {} } },
    ],
    [
      "an undo block that does not say how it is fed",
      { ...destroy, undo: { _tag: "Undo", block: "d1.restore", version: 1 } },
    ],
    [
      "an undo input fed from something other than an input or an output",
      {
        ...destroy,
        undo: {
          _tag: "Undo",
          block: "d1.restore",
          version: 1,
          inputs: { database: { _tag: "FromRecipe", name: "database" } },
        },
      },
    ],
    [
      "an undo input name that is not camel case",
      {
        ...destroy,
        undo: {
          _tag: "Undo",
          block: "d1.restore",
          version: 1,
          inputs: { "The DB": { _tag: "FromInput", name: "database" } },
        },
      },
    ],
    ["a bad id", { ...check, id: "check" }],
    ["version 0", { ...check, version: 0 }],
    ["an empty title", { ...check, title: "" }],
  ])("rejects %s", (_, spec) => {
    expect(accepts(spec)).toBe(false);
  });
});

describe("blockSpecProblems", () => {
  it.each([createCopy, check, gate, destroy])("finds nothing wrong with $id", (spec) => {
    expect(problems(spec)).toEqual([]);
  });

  it.each(["Reads", "Writes", "Destroys"])("reports a %s effect on an undeclared input", (_tag) => {
    const effect = { _tag, input: "other" };
    expect(problems({ ...destroy, effects: [effect] })).toEqual([
      { _tag: "EffectNamesUnknownInput", effect, input: "other" },
    ]);
  });

  it("reports a Creates effect on an undeclared output", () => {
    const effect = { _tag: "Creates", output: "database", lifetime: "Temporary" };
    expect(problems({ ...destroy, effects: [effect] })).toEqual([
      { _tag: "EffectNamesUnknownOutput", effect, output: "database" },
    ]);
  });

  it("does not take an inherited property for a declared name", () => {
    const reads = { _tag: "Reads", input: "toString" };
    const creates = { _tag: "Creates", output: "valueOf", lifetime: "Durable" };
    expect(problems({ ...destroy, effects: [reads, creates] })).toEqual([
      { _tag: "EffectNamesUnknownInput", effect: reads, input: "toString" },
      { _tag: "EffectNamesUnknownOutput", effect: creates, output: "valueOf" },
    ]);
  });

  it.each([
    { _tag: "Writes", input: "database" },
    { _tag: "Destroys", input: "database" },
    { _tag: "Creates", output: "receipt", lifetime: "Temporary" },
  ])("reports NothingToUndo on a block with a $_tag effect", (effect) => {
    const spec = { ...destroy, effects: [effect], undo: { _tag: "NothingToUndo" } };
    expect(problems(spec)).toEqual([{ _tag: "NothingToUndoButChanges", effect }]);
  });

  it.each([
    { _tag: "Writes", input: "database" },
    { _tag: "Destroys", input: "database" },
    { _tag: "Creates", output: "receipt", lifetime: "Durable" },
  ])("reports a gate with a $_tag effect", (effect) => {
    const spec = { ...destroy, kind: "Gate", effects: [effect] };
    expect(problems(spec)).toEqual([{ _tag: "GateChanges", effect }]);
  });

  it("reports an undo fed from an input or an output the block does not declare", () => {
    const undo = {
      _tag: "Undo",
      block: "d1.restore",
      version: 1,
      inputs: {
        database: { _tag: "FromInput", name: "database" },
        receipt: { _tag: "FromOutput", name: "receipt" },
        // Each name exists, but on the other side: `receipt` is an output, `database` an input.
        wrongSide: { _tag: "FromInput", name: "receipt" },
        otherSide: { _tag: "FromOutput", name: "database" },
        inherited: { _tag: "FromInput", name: "toString" },
        alsoInherited: { _tag: "FromOutput", name: "valueOf" },
      },
    };
    expect(problems({ ...destroy, undo })).toEqual([
      { _tag: "UndoFedFromUnknownInput", undoInput: "wrongSide", input: "receipt" },
      { _tag: "UndoFedFromUnknownOutput", undoInput: "otherSide", output: "database" },
      { _tag: "UndoFedFromUnknownInput", undoInput: "inherited", input: "toString" },
      { _tag: "UndoFedFromUnknownOutput", undoInput: "alsoInherited", output: "valueOf" },
    ]);
  });

  it("reports a gate that declares an undo block, and not one that says it cannot be undone", () => {
    const undo = { _tag: "Undo", block: "d1.restore", version: 1, inputs: {} };
    expect(problems({ ...gate, undo })).toEqual([{ _tag: "GateHasUndo" }]);
    expect(
      problems({ ...gate, undo: { _tag: "NoUndo", reason: "Nothing to take back." } }),
    ).toEqual([]);
    expect(problems({ ...check, undo })).toEqual([]);
  });

  it("lets a gate read what it shows", () => {
    expect(problems({ ...check, kind: "Gate" })).toEqual([]);
  });

  it("reports every problem, in the order of the effects", () => {
    const writes = { _tag: "Writes", input: "other" };
    const reads = { _tag: "Reads", input: "database" };
    const creates = { _tag: "Creates", output: "other", lifetime: "Durable" };
    const spec = { ...check, effects: [writes, reads, creates] };
    expect(problems(spec)).toEqual([
      { _tag: "EffectNamesUnknownInput", effect: writes, input: "other" },
      { _tag: "NothingToUndoButChanges", effect: writes },
      { _tag: "EffectNamesUnknownOutput", effect: creates, output: "other" },
      { _tag: "NothingToUndoButChanges", effect: creates },
    ]);
  });
});
