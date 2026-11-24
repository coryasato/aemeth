import { Schema, Struct } from "effect";
import { RunId, StepId } from "../ids";
import { ItemIndex } from "./idempotencyKey";
import { AttemptNumber, RecipeRef, RunEvent, Seq } from "./RunEvent";

/** How a step's work or an undo stands. `FailedRetryable` may be followed by the next attempt. */
const WorkStatus = Schema.Literals(["Open", "Succeeded", "FailedRetryable", "Failed"]);

const work = {
  step: StepId,
  item: Schema.optionalKey(ItemIndex),
  attempt: AttemptNumber,
  status: WorkStatus,
};

/**
 * The latest attempt at one piece of work: a step (or one item of a for-each), a gate, or an
 * undo. A gate is `Cancelled` when the run was cancelled while it waited.
 */
export const Attempt = Schema.TaggedUnion({
  Step: { phase: Schema.Literals(["Main", "Finally"]), ...work },
  Gate: {
    step: StepId,
    attempt: AttemptNumber,
    status: Schema.Literals(["Open", "Approved", "Denied", "Cancelled"]),
  },
  Undo: { ...work },
}).annotate({ identifier: "Attempt" });
export type Attempt = typeof Attempt.Type;

/**
 * What a run's log has said so far. `attempts` holds one entry per piece of work, in the order
 * each was first started, with a retry taking the place of the attempt it follows.
 */
export const Run = Schema.Struct({
  runId: RunId,
  recipe: RecipeRef,
  /** The `seq` of the last event accepted. */
  seq: Seq,
  attempts: Schema.Array(Attempt),
}).annotate({ identifier: "Run" });
export type Run = typeof Run.Type;

/**
 * Where the main phase stands. `Normal` until a cancel is requested (`CancelRequested`: no new
 * main-phase work may start) or a step starts after a different step failed or a gate was denied
 * (`Handling`: the recipe's own failure handler runs to its end, and a cancel changes nothing,
 * M1 decision 18).
 */
export const Track = Schema.Literals(["Normal", "CancelRequested", "Handling"]).annotate({
  identifier: "Track",
});
export type Track = typeof Track.Type;

/** How the main phase ended. */
const MainResult = Schema.Literals(["Succeeded", "Failed", "Cancelled"]);

/**
 * The state of a run, computed from its log by `transition`. The last four are final: they
 * accept no event. `NeedsAttention` tells a person that a cleanup failed and something may have
 * been left behind (M1 decision 3); `main` is how the main phase had ended.
 */
export const RunState = Schema.TaggedUnion({
  NotStarted: {},
  Running: { run: Run, track: Track },
  WaitingForApproval: { run: Run, track: Track },
  /** Undoing what succeeded, in reverse order. */
  Compensating: { run: Run, main: Schema.Literals(["Failed", "Cancelled"]) },
  /** Running the `finally` steps, which follow a success too. */
  Finalizing: { run: Run, main: MainResult },
  Succeeded: { run: Run },
  Failed: { run: Run },
  Cancelled: { run: Run },
  NeedsAttention: { run: Run, main: MainResult },
}).annotate({ identifier: "RunState" });
export type RunState = typeof RunState.Type;

/** The state of a run with no events. */
export const notStarted: RunState = { _tag: "NotStarted" };

/** Why `transition` did not accept an event. */
export const RejectionReason = Schema.Literals([
  /** The first event of a run is `RunStarted`. */
  "RunNotStarted",
  "RunAlreadyStarted",
  /** A final state accepts nothing. */
  "RunAlreadyEnded",
  /** `seq` is not one more than the last event's. */
  "OutOfSequence",
  "DifferentRun",
  /** A run uses one recipe at one version. */
  "RecipeChanged",
  /** The event belongs to another phase of the run. */
  "WrongPhase",
  /** No step starts while a gate waits. */
  "GateWaiting",
  /** Work is still in flight that must end first. */
  "AttemptsOpen",
  /** A completion that matches no open attempt, or one that already ended. */
  "NoOpenAttempt",
  /** Not attempt 1 of new work, or not the attempt after a failure that may be retried. */
  "AttemptOutOfOrder",
  /** The step already ran, as a step of another kind or in another place. */
  "StepAlreadyRan",
  /** A cancel was requested, so no new main-phase work may start. */
  "CancellationPending",
  /** The main phase cannot have ended `Cancelled`: no cancel was in effect, or the step failed. */
  "NotCancelled",
  /** Only a step or a for-each item that succeeded is undone. */
  "NothingToUndo",
  /** Undo runs in reverse order, each piece of work once. */
  "UndoOutOfOrder",
  "WrongIdempotencyKey",
  /** The final event does not agree with the main result and the cleanups. */
  "FinalResultMismatch",
]).annotate({ identifier: "RejectionReason" });
export type RejectionReason = typeof RejectionReason.Type;

/** An event that does not fit the state it arrived in. The state is left as it was. */
export const EventRejected = Schema.TaggedStruct("EventRejected", {
  reason: RejectionReason,
  /** The tag of the state the event arrived in, and the tag and `seq` of the event. */
  state: Schema.Literals(Struct.keys(RunState.cases)),
  event: Schema.Literals(Struct.keys(RunEvent.cases)),
  seq: Seq,
}).annotate({ identifier: "EventRejected" });
export type EventRejected = typeof EventRejected.Type;
