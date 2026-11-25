import { Schema } from "effect";
import { Name, RecipeId, RunId, StepId, Version } from "../ids";
import { Value } from "../Value";
import { IdempotencyKey, ItemIndex } from "./idempotencyKey";

/** An event's position in its run's log. The first event is 0 and each one after it adds one. */
export const Seq = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 })),
  Schema.annotate({ identifier: "Seq" }),
);
export type Seq = typeof Seq.Type;

/**
 * When a fact was recorded, in milliseconds since 1970 UTC. The engine reads it from Effect's
 * `Clock`; nothing in core reads a clock.
 */
export const EpochMillis = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })),
  Schema.annotate({ identifier: "EpochMillis" }),
);

/** Which attempt at a piece of work this is: 1, then 2 for the first retry, and so on. */
export const AttemptNumber = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  Schema.annotate({ identifier: "AttemptNumber" }),
);
export type AttemptNumber = typeof AttemptNumber.Type;

/** The recipe a run follows. A run always uses one fixed version. */
export const RecipeRef = Schema.Struct({ id: RecipeId, version: Version }).annotate({
  identifier: "RecipeRef",
});
export type RecipeRef = typeof RecipeRef.Type;

/** Who did something: the identity the engine was given for a person, or the name of a policy. */
export const Actor = Schema.String.pipe(
  Schema.check(Schema.isPattern(/\S/u), Schema.isMaxLength(320)),
  Schema.annotate({ identifier: "Actor" }),
);

/** Why a step or an undo failed. `name` is the typed error's name, such as `RunTagMismatch`. */
export const StepError = Schema.Struct({
  name: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[A-Z][a-zA-Z0-9]*$/u), Schema.isMaxLength(64)),
  ),
  message: Schema.String.pipe(Schema.check(Schema.isMaxLength(2000))),
}).annotate({ identifier: "StepError" });

/** What a step produced, by output name, as JSON. For a gate: what was approved. */
export const Outputs = Schema.Record(Name, Schema.Json).annotate({ identifier: "Outputs" });

/**
 * How the main phase ended, as the engine read it from the recipe. Only a failed end chooses
 * whether the undo phase runs (M1 decision 15); a cancelled one always undoes and a successful
 * one never does. The same shape as a path's `main` in the validator.
 */
export const MainEnded = Schema.Union([
  Schema.Struct({ result: Schema.Literal("Succeeded") }),
  Schema.Struct({ result: Schema.Literal("Failed"), undo: Schema.Literals(["Run", "Skip"]) }),
  Schema.Struct({ result: Schema.Literal("Cancelled") }),
]).annotate({ identifier: "MainEnded" });

/**
 * What a run was started with, by recipe input name, in the written form of `Value`. The engine
 * checks it against the recipe's inputs before the run starts (`inputProblems`).
 */
export const Inputs = Schema.Record(Name, Value).annotate({ identifier: "Inputs" });

/** What every event carries, whatever it records. */
const envelope = {
  eventSchemaVersion: Schema.Literal(1),
  runId: RunId,
  seq: Seq,
  at: EpochMillis,
  recipe: RecipeRef,
};

/**
 * The attempt an event opens or ends. For-each items run side by side, so `item` says which one;
 * it is absent for a step that is not a for-each.
 */
const attempt = {
  step: StepId,
  item: Schema.optionalKey(ItemIndex),
  attempt: AttemptNumber,
};

/** A gate is never a for-each, so its attempt has no item. */
const gateAttempt = { step: StepId, attempt: AttemptNumber };

/**
 * One fact in a run's log, in the past tense. The log is the run: its state, its timeline and
 * its audit trail are all computed from these, by `transition`.
 *
 * `transition` never sees the recipe, so the log says what it could not look up: a step's phase
 * (`StepStarted.phase`), and how the main phase ended (`MainPhaseEnded`).
 */
export const RunEvent = Schema.TaggedUnion({
  RunStarted: { ...envelope, inputs: Inputs },
  StepStarted: {
    ...envelope,
    phase: Schema.Literals(["Main", "Finally"]),
    ...attempt,
    idempotencyKey: IdempotencyKey,
  },
  StepSucceeded: { ...envelope, ...attempt, outputs: Outputs },
  /** `retryable` says the next attempt may follow. Without it, this work has failed for good. */
  StepFailed: { ...envelope, ...attempt, error: StepError, retryable: Schema.Boolean },
  GateOpened: { ...envelope, ...gateAttempt },
  ApprovalGranted: { ...envelope, ...gateAttempt, by: Actor, outputs: Outputs },
  ApprovalDenied: { ...envelope, ...gateAttempt, by: Actor },
  CancellationRequested: { ...envelope, by: Actor },
  MainPhaseEnded: { ...envelope, main: MainEnded },
  UndoStarted: { ...envelope, ...attempt, idempotencyKey: IdempotencyKey },
  UndoSucceeded: { ...envelope, ...attempt },
  UndoFailed: { ...envelope, ...attempt, error: StepError, retryable: Schema.Boolean },
  RunSucceeded: { ...envelope },
  RunFailed: { ...envelope },
  RunCancelled: { ...envelope },
  RunFlaggedForAttention: { ...envelope },
}).annotate({ identifier: "RunEvent" });
export type RunEvent = typeof RunEvent.Type;
