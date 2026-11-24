import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { BlockSpec, DataType, EventRejected, Recipe, RunEvent, RunState } from "./index";

/**
 * Every Schema survives a trip through JSON text: encode, stringify, parse, decode.
 *
 * A property over a generator can pass without ever producing the interesting shapes
 * (M1 Part A findings), so each test records the tags it saw, and a test after it
 * fails if a required one was never reached.
 */

const strict = { onExcessProperty: "error" } as const;
const runs = { arbitrary: { runs: 300 } };
// The generator gives a Struct at most `size` properties, and `Recipe` has 11 required ones, so
// at the default size its optional `$schema` is never generated. The coverage test caught this.
const recipeRuns = { arbitrary: { runs: 300, size: 16 } };

/** Records `key=value` for every text-valued property in a value, at any depth. */
const record = (seen: Set<string>, value: unknown, key = ""): void => {
  if (typeof value === "string") {
    seen.add(`${key}=${value}`);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      record(seen, item, key);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [name, inner] of Object.entries(value)) {
      record(seen, inner, name);
    }
  }
};

// JSON text has no `-0`: `JSON.stringify(-0)` is `"0"`. A literal `-0` therefore comes back as
// `0`, which is the only change the trip makes, so numbers are compared with `===` here.
expect.addEqualityTesters([
  (a: unknown, b: unknown) =>
    typeof a === "number" && typeof b === "number" ? a === b : undefined,
]);

const roundTrips = <S extends Schema.Codec<unknown, unknown>>(schema: S, seen: Set<string>) => {
  const codec = Schema.toCodecJson(schema);
  const encode = Schema.encodeSync(codec);
  const decode = Schema.decodeUnknownSync(codec, strict);
  return (value: S["Type"]): void => {
    const text = JSON.stringify(encode(value));
    const decoded = decode(JSON.parse(text));
    expect(decoded).toEqual(value);
    expect(JSON.stringify(encode(decoded))).toBe(text);
    record(seen, value);
  };
};

const dataTypeTags = [
  "Text",
  "Integer",
  "Boolean",
  "Duration",
  "Timestamp",
  "Resource",
  "List",
  "Struct",
].map((tag) => `_tag=${tag}`);

describe("DataType", () => {
  const seen = new Set<string>();
  const check = roundTrips(DataType, seen);

  it.prop("round-trips through JSON", [DataType], ([type]) => check(type), runs);

  it("reached every tag", () => {
    expect([...seen]).toEqual(expect.arrayContaining(dataTypeTags));
  });
});

describe("BlockSpec", () => {
  const seen = new Set<string>();
  const check = roundTrips(BlockSpec, seen);

  it.prop("round-trips through JSON", [BlockSpec], ([spec]) => check(spec), runs);

  it("reached every tag", () => {
    expect([...seen]).toEqual(
      expect.arrayContaining([
        ...dataTypeTags,
        "kind=Action",
        "kind=Check",
        "kind=Gate",
        "_tag=Required",
        "_tag=Optional",
        "_tag=Reads",
        "_tag=Writes",
        "_tag=Creates",
        "_tag=Destroys",
        "lifetime=Temporary",
        "lifetime=Expiring",
        "_tag=FromInput",
        "_tag=FromOutput",
        "lifetime=Durable",
        "_tag=Undo",
        "_tag=NoUndo",
        "_tag=NothingToUndo",
        "rerun=SafeWithIdempotencyKey",
      ]),
    );
  });
});

describe("Recipe", () => {
  const seen = new Set<string>();
  const check = roundTrips(Recipe, seen);
  let withForEach = 0;
  let withoutForEach = 0;
  let withSchemaField = 0;
  const literals = new Set<string>();

  it.prop(
    "round-trips through JSON",
    [Recipe],
    ([recipe]) => {
      check(recipe);
      withSchemaField += recipe.$schema === undefined ? 0 : 1;
      for (const step of recipe.nodes) {
        withForEach += step.forEach === undefined ? 0 : 1;
        withoutForEach += step.forEach === undefined ? 1 : 0;
        for (const binding of Object.values(step.inputs)) {
          if (binding._tag === "Literal") {
            literals.add(Array.isArray(binding.value) ? "array" : typeof binding.value);
          }
        }
      }
    },
    recipeRuns,
  );

  it("reached every tag", () => {
    expect([...seen]).toEqual(
      expect.arrayContaining([
        ...dataTypeTags,
        "_tag=Step",
        "_tag=RecipeInput",
        "_tag=StepOutput",
        "_tag=OptionalStepOutput",
        "_tag=ForEachItem",
        "_tag=Literal",
        "onItemFailure=Stop",
        "onItemFailure=Continue",
        "on=Succeeded",
        "on=Failed",
        "on=Approved",
        "on=Denied",
        "_tag=End",
        "result=Succeeded",
        "result=Failed",
        "undo=Run",
        "undo=Skip",
        "rule=NeverWritten",
        "rule=CleanedUp",
        "rule=RequiredForSuccess",
        "rule=NoWriteBeforeApproval",
        "rule=AfterFailure",
        "rule=DestroysOnlyApproved",
        "rule=OnlyAfter",
      ]),
    );
  });

  it("reached steps with and without a for-each, and every kind of literal", () => {
    expect(withForEach).toBeGreaterThan(0);
    expect(withoutForEach).toBeGreaterThan(0);
    expect(withSchemaField).toBeGreaterThan(0);
    expect([...literals].toSorted()).toEqual(["array", "boolean", "number", "object", "string"]);
  });
});

// The rarest value of a run event, `undo: "Skip"`, is in one generated event in about a hundred:
// 300 runs missed it one time in twenty, which failed the coverage test by chance.
const runRuns = { arbitrary: { runs: 2000, size: 16 } };

const attemptTags = [
  "_tag=Step",
  "_tag=Gate",
  "_tag=Undo",
  "phase=Main",
  "phase=Finally",
  "status=Open",
  "status=Succeeded",
  "status=FailedRetryable",
  "status=Failed",
  "status=Approved",
  "status=Denied",
  "status=Cancelled",
];

describe("RunEvent", () => {
  const seen = new Set<string>();
  const check = roundTrips(RunEvent, seen);
  let withItem = 0;
  let withoutItem = 0;
  let retryable = 0;
  let final = 0;

  it.prop(
    "round-trips through JSON",
    [RunEvent],
    ([event]) => {
      check(event);
      if (event._tag === "StepStarted" || event._tag === "UndoStarted") {
        withItem += event.item === undefined ? 0 : 1;
        withoutItem += event.item === undefined ? 1 : 0;
      }
      if (event._tag === "StepFailed" || event._tag === "UndoFailed") {
        retryable += event.retryable ? 1 : 0;
        final += event.retryable ? 0 : 1;
      }
    },
    runRuns,
  );

  it("reached every event, phase and way for the main phase to end", () => {
    expect([...seen]).toEqual(
      expect.arrayContaining([
        ...Object.keys(RunEvent.cases).map((tag) => `_tag=${tag}`),
        "phase=Main",
        "phase=Finally",
        "result=Succeeded",
        "result=Failed",
        "result=Cancelled",
        "undo=Run",
        "undo=Skip",
      ]),
    );
    expect(Object.keys(RunEvent.cases)).toHaveLength(16);
  });

  it("reached work with and without an item, and failures that may and may not be retried", () => {
    expect(withItem).toBeGreaterThan(0);
    expect(withoutItem).toBeGreaterThan(0);
    expect(retryable).toBeGreaterThan(0);
    expect(final).toBeGreaterThan(0);
  });
});

describe("RunState", () => {
  const seen = new Set<string>();
  const check = roundTrips(RunState, seen);

  it.prop("round-trips through JSON", [RunState], ([state]) => check(state), runRuns);

  it("reached every state, track and kind of attempt", () => {
    expect([...seen]).toEqual(
      expect.arrayContaining([
        ...Object.keys(RunState.cases).map((tag) => `_tag=${tag}`),
        ...attemptTags,
        "track=Normal",
        "track=CancelRequested",
        "track=Handling",
        "main=Succeeded",
        "main=Failed",
        "main=Cancelled",
      ]),
    );
    expect(Object.keys(RunState.cases)).toHaveLength(9);
  });
});

describe("EventRejected", () => {
  const seen = new Set<string>();
  const check = roundTrips(EventRejected, seen);

  it.prop("round-trips through JSON", [EventRejected], ([rejected]) => check(rejected), runs);

  it("reached several reasons", () => {
    expect([...seen].filter((entry) => entry.startsWith("reason=")).length).toBeGreaterThan(9);
  });
});
