import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { EventRejected, RunEvent, RunState } from "../index";
import type { Parts } from "../testing/build";

// One fixed document per event and per state, decoded with unknown fields rejected. A property
// over a derived generator follows the Schema, so it cannot see a field that a change removed
// (M1 Part B findings); these can.

const strict = { onExcessProperty: "error" } as const;
const accepts = (schema: Schema.Codec<unknown, unknown>, value: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema, strict)(value));

/** A document with one field taken out. */
const without = (document: Parts, field: string): Parts =>
  Object.fromEntries(Object.entries(document).filter(([key]) => key !== field));

const envelope = {
  eventSchemaVersion: 1,
  runId: "run-1",
  seq: 4,
  at: 1_795_000_000_000,
  recipe: { id: "restore-drill", version: 3 },
};
const error = { name: "RunTagMismatch", message: "The database is tagged for another run." };
const by = "ada@example.com";
const item = { step: "deploy", item: 2, attempt: 1 };
const whole = { step: "export", attempt: 2 };

const events: ReadonlyArray<Parts> = [
  {
    _tag: "RunStarted",
    inputs: {
      production: { kind: "cloudflare.d1.database", id: "6b1f-42" },
      stages: [10, 50, 100],
      settle: 300_000,
      dryRun: false,
      plan: { name: "release", steps: ["shift", "check"] },
    },
  },
  { _tag: "RunStarted", inputs: {} },
  { _tag: "StepStarted", phase: "Main", ...whole, idempotencyKey: "run-1:export:Forward" },
  { _tag: "StepStarted", phase: "Finally", ...item, idempotencyKey: "run-1:deploy:Forward:2" },
  { _tag: "StepSucceeded", ...item, outputs: { rows: 12, checksum: "ab12", tables: ["a", "b"] } },
  { _tag: "StepSucceeded", ...whole, outputs: {} },
  { _tag: "StepFailed", ...item, error, retryable: true },
  { _tag: "StepFailed", ...whole, error, retryable: false },
  { _tag: "GateOpened", step: "approve", attempt: 1 },
  { _tag: "ApprovalGranted", step: "approve", attempt: 1, by, outputs: { stacks: ["pr-12"] } },
  { _tag: "ApprovalDenied", step: "approve", attempt: 1, by },
  { _tag: "CancellationRequested", by },
  { _tag: "MainPhaseEnded", main: { result: "Succeeded" } },
  { _tag: "MainPhaseEnded", main: { result: "Failed", undo: "Run" } },
  { _tag: "MainPhaseEnded", main: { result: "Failed", undo: "Skip" } },
  { _tag: "MainPhaseEnded", main: { result: "Cancelled" } },
  { _tag: "UndoStarted", ...item, idempotencyKey: "run-1:deploy:Undo:2" },
  { _tag: "UndoStarted", ...whole, idempotencyKey: "run-1:export:Undo" },
  { _tag: "UndoSucceeded", ...item },
  { _tag: "UndoSucceeded", ...whole },
  { _tag: "UndoFailed", ...item, error, retryable: false },
  { _tag: "UndoFailed", ...whole, error, retryable: true },
  { _tag: "RunSucceeded" },
  { _tag: "RunFailed" },
  { _tag: "RunCancelled" },
  { _tag: "RunFlaggedForAttention" },
];

describe("RunEvent", () => {
  it.each(events)("decodes $_tag and gives back every field", (fact) => {
    const document = { ...envelope, ...fact };
    expect(Schema.decodeUnknownSync(RunEvent, strict)(document)).toEqual(document);
  });

  it("has a document here for every event", () => {
    expect(new Set(events.map((fact) => fact._tag))).toEqual(new Set(Object.keys(RunEvent.cases)));
  });

  it.each(events)("needs every field of $_tag", (fact) => {
    const document: Parts = { ...envelope, ...fact };
    for (const field of Object.keys(document)) {
      // `item` is the one field that may be absent: a step that is not a for-each has none.
      expect([field, accepts(RunEvent, without(document, field))]).toEqual([
        field,
        field === "item",
      ]);
    }
    expect(accepts(RunEvent, { ...document, extra: 1 })).toBe(false);
  });

  it.each([
    ["an event schema version it does not know", { eventSchemaVersion: 2 }],
    ["a negative seq", { seq: -1 }],
    ["a seq that is not whole", { seq: 1.5 }],
    ["a time before 1970", { at: -1 }],
    ["a time that is not whole milliseconds", { at: 0.5 }],
    ["a run id with a colon", { runId: "run:1" }],
    ["a recipe with no version", { recipe: { id: "restore-drill" } }],
    ["a recipe version of 0", { recipe: { id: "restore-drill", version: 0 } }],
    ["a recipe with an unknown field", { recipe: { id: "restore-drill", version: 1, x: 1 } }],
  ])("rejects %s", (_, change) => {
    expect(accepts(RunEvent, { ...envelope, _tag: "RunStarted", inputs: {}, ...change })).toBe(
      false,
    );
  });

  const stepStarted = {
    ...envelope,
    _tag: "StepStarted",
    phase: "Main",
    ...item,
    idempotencyKey: "run-1:deploy:Forward:2",
  };
  it.each([
    ["an undo phase on a step", stepStarted, { phase: "Undo" }],
    ["attempt 0", stepStarted, { attempt: 0 }],
    ["attempt 1001", stepStarted, { attempt: 1001 }],
    ["a negative item", stepStarted, { item: -1 }],
    ["a key that is not a key", stepStarted, { idempotencyKey: "deploy" }],
    ["an item on a gate", { ...envelope, _tag: "GateOpened", step: "g", attempt: 1 }, { item: 0 }],
    [
      "an approval by nobody",
      { ...envelope, _tag: "ApprovalGranted", step: "g", attempt: 1, outputs: {} },
      { by: " " },
    ],
    [
      "a denial by nobody",
      { ...envelope, _tag: "ApprovalDenied", step: "g", attempt: 1 },
      { by: "" },
    ],
    ["a cancel by nobody", { ...envelope, _tag: "CancellationRequested" }, { by: "\n" }],
    [
      "a name longer than an identity",
      { ...envelope, _tag: "CancellationRequested" },
      { by: "a".repeat(321) },
    ],
    [
      "an output that is not named like one",
      { ...envelope, _tag: "StepSucceeded", ...item },
      { outputs: { "Not A Name": 1 } },
    ],
    [
      "an error with no name",
      { ...envelope, _tag: "StepFailed", ...item, retryable: false },
      { error: { name: "", message: "" } },
    ],
    [
      "an error named like a sentence",
      { ...envelope, _tag: "UndoFailed", ...item, retryable: false },
      { error: { name: "it broke", message: "" } },
    ],
    [
      "an error name of 65 characters",
      { ...envelope, _tag: "UndoFailed", ...item, retryable: false },
      { error: { name: "E".repeat(65), message: "" } },
    ],
    [
      "an error message of 2001 characters",
      { ...envelope, _tag: "UndoFailed", ...item, retryable: false },
      { error: { name: "E", message: "x".repeat(2001) } },
    ],
    [
      "an error with an unknown field",
      { ...envelope, _tag: "UndoFailed", ...item, retryable: false },
      { error: { name: "E", message: "", stack: "" } },
    ],
    [
      "a successful end that chooses undo",
      { ...envelope, _tag: "MainPhaseEnded" },
      { main: { result: "Succeeded", undo: "Skip" } },
    ],
    [
      "a cancelled end that chooses undo",
      { ...envelope, _tag: "MainPhaseEnded" },
      { main: { result: "Cancelled", undo: "Run" } },
    ],
    [
      "a failed end that does not choose",
      { ...envelope, _tag: "MainPhaseEnded" },
      { main: { result: "Failed" } },
    ],
    [
      "an end that needs attention: that is not a main result",
      { ...envelope, _tag: "MainPhaseEnded" },
      { main: { result: "NeedsAttention" } },
    ],
    ["an event it does not know", { ...envelope }, { _tag: "StepSkipped" }],
  ])("rejects %s", (_, document, change) => {
    expect(accepts(RunEvent, { ...document, ...change })).toBe(false);
  });

  it("accepts the edges of what it allows", () => {
    expect(accepts(RunEvent, { ...stepStarted, attempt: 1000 })).toBe(true);
    expect(accepts(RunEvent, { ...envelope, _tag: "RunStarted", inputs: {}, seq: 0, at: 0 })).toBe(
      true,
    );
    expect(
      accepts(RunEvent, { ...envelope, _tag: "RunStarted", inputs: {}, seq: 1_000_000_000 }),
    ).toBe(true);
    expect(
      accepts(RunEvent, { ...envelope, _tag: "RunStarted", inputs: {}, seq: 1_000_000_001 }),
    ).toBe(false);
    expect(
      accepts(RunEvent, { ...envelope, _tag: "RunStarted", inputs: {}, at: 8_640_000_000_000_001 }),
    ).toBe(false);
    expect(
      accepts(RunEvent, { ...envelope, _tag: "CancellationRequested", by: "a".repeat(320) }),
    ).toBe(true);
    const failed = { ...envelope, _tag: "StepFailed", ...item, retryable: false };
    expect(
      accepts(RunEvent, { ...failed, error: { name: "E".repeat(64), message: "x".repeat(2000) } }),
    ).toBe(true);
    expect(accepts(RunEvent, { ...failed, error: { name: "E1a", message: "" } })).toBe(true);
    expect(accepts(RunEvent, { ...failed, error: { name: "e", message: "" } })).toBe(false);
    expect(accepts(RunEvent, { ...failed, error: { name: "E-1", message: "" } })).toBe(false);
  });
});

const attempts: ReadonlyArray<Parts> = [
  { _tag: "Step", phase: "Main", step: "export", attempt: 2, status: "Succeeded" },
  { _tag: "Step", phase: "Main", step: "deploy", item: 0, attempt: 1, status: "FailedRetryable" },
  { _tag: "Gate", step: "approve", attempt: 1, status: "Approved" },
  { _tag: "Gate", step: "confirm", attempt: 1, status: "Denied" },
  { _tag: "Gate", step: "wait", attempt: 1, status: "Cancelled" },
  { _tag: "Gate", step: "ask", attempt: 1, status: "Open" },
  { _tag: "Undo", step: "export", attempt: 1, status: "Failed" },
  { _tag: "Undo", step: "deploy", item: 0, attempt: 1, status: "Open" },
  { _tag: "Step", phase: "Finally", step: "record", attempt: 1, status: "Open" },
];
const run = { runId: "run-1", recipe: { id: "restore-drill", version: 3 }, seq: 9, attempts };

const states: ReadonlyArray<Parts> = [
  { _tag: "NotStarted" },
  { _tag: "Running", run, track: "Normal" },
  { _tag: "Running", run, track: "Handling" },
  { _tag: "WaitingForApproval", run, track: "CancelRequested" },
  { _tag: "Compensating", run, main: "Failed" },
  { _tag: "Compensating", run, main: "Cancelled" },
  { _tag: "Finalizing", run, main: "Succeeded" },
  { _tag: "Finalizing", run, main: "Failed" },
  { _tag: "Finalizing", run, main: "Cancelled" },
  { _tag: "Succeeded", run },
  { _tag: "Failed", run },
  { _tag: "Cancelled", run },
  { _tag: "NeedsAttention", run, main: "Cancelled" },
];

describe("RunState", () => {
  it.each(states)("decodes $_tag and gives back every field", (state) => {
    expect(Schema.decodeUnknownSync(RunState, strict)(state)).toEqual(state);
  });

  it("has a document here for every state", () => {
    expect(new Set(states.map((state) => state._tag))).toEqual(
      new Set(Object.keys(RunState.cases)),
    );
  });

  it.each(states)("needs every field of $_tag", (state) => {
    for (const field of Object.keys(state)) {
      expect([field, accepts(RunState, without(state, field))]).toEqual([field, false]);
    }
    expect(accepts(RunState, { ...state, extra: 1 })).toBe(false);
  });

  it.each(["runId", "recipe", "seq", "attempts"])("needs the run's %s", (field) => {
    expect(accepts(RunState, { _tag: "Succeeded", run: without(run, field) })).toBe(false);
  });

  it.each(attempts)("needs every field of the attempt $_tag $step", (attempt) => {
    const stateWith = (changed: Parts) => ({
      _tag: "Succeeded",
      run: { ...run, attempts: [changed] },
    });
    expect(accepts(RunState, stateWith(attempt))).toBe(true);
    for (const field of Object.keys(attempt)) {
      expect([field, accepts(RunState, stateWith(without(attempt, field)))]).toEqual([
        field,
        field === "item",
      ]);
    }
    expect(accepts(RunState, stateWith({ ...attempt, extra: 1 }))).toBe(false);
  });

  it.each([
    [
      "an undo phase on a step",
      { _tag: "Step", phase: "Undo", step: "a", attempt: 1, status: "Open" },
    ],
    ["a gate that succeeded", { _tag: "Gate", step: "a", attempt: 1, status: "Succeeded" }],
    ["a gate with an item", { _tag: "Gate", step: "a", item: 0, attempt: 1, status: "Open" }],
    [
      "a step that was approved",
      { _tag: "Step", phase: "Main", step: "a", attempt: 1, status: "Approved" },
    ],
    ["an undo that was cancelled", { _tag: "Undo", step: "a", attempt: 1, status: "Cancelled" }],
    [
      "an undo with a phase",
      { _tag: "Undo", phase: "Main", step: "a", attempt: 1, status: "Open" },
    ],
  ])("rejects %s", (_, attempt) => {
    expect(accepts(RunState, { _tag: "Succeeded", run: { ...run, attempts: [attempt] } })).toBe(
      false,
    );
  });

  it.each([
    ["a track it does not know", { _tag: "Running", run, track: "Paused" }],
    ["a success being undone", { _tag: "Compensating", run, main: "Succeeded" }],
    ["a main result of NeedsAttention", { _tag: "Finalizing", run, main: "NeedsAttention" }],
    ["attention with no main result it knows", { _tag: "NeedsAttention", run, main: "Denied" }],
    ["a state it does not know", { _tag: "Paused", run }],
  ])("rejects %s", (_, state) => {
    expect(accepts(RunState, state)).toBe(false);
  });
});

describe("EventRejected", () => {
  const rejected = {
    _tag: "EventRejected",
    reason: "AttemptsOpen",
    state: "Running",
    event: "MainPhaseEnded",
    seq: 2,
  };

  it("decodes and gives back every field", () => {
    expect(Schema.decodeUnknownSync(EventRejected, strict)(rejected)).toEqual(rejected);
  });

  it("needs every field, and a reason it knows", () => {
    for (const field of Object.keys(rejected)) {
      expect([field, accepts(EventRejected, without(rejected, field))]).toEqual([field, false]);
    }
    expect(accepts(EventRejected, { ...rejected, reason: "Unlucky" })).toBe(false);
    expect(accepts(EventRejected, { ...rejected, state: "Paused" })).toBe(false);
    expect(accepts(EventRejected, { ...rejected, event: "StepSkipped" })).toBe(false);
    expect(accepts(EventRejected, { ...rejected, state: "MainPhaseEnded" })).toBe(false);
    expect(accepts(EventRejected, { ...rejected, extra: 1 })).toBe(false);
  });
});
