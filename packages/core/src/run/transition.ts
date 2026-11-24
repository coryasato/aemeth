import { Result } from "effect";
import type { StepId } from "../ids";
import type { ItemIndex } from "./idempotencyKey";
import { idempotencyKey } from "./idempotencyKey";
import type { AttemptNumber, RunEvent } from "./RunEvent";
import type { Attempt, EventRejected, RejectionReason, Run, RunState } from "./RunState";

// `transition` is the whole run state machine. It never sees the recipe, so it checks the order
// of facts, not which step comes next: choosing the next step is the engine's work (M2). For the
// same reason it checks that every undo is one the log allows, not that every undo owed has run.

type EventOf<Tag extends RunEvent["_tag"]> = Extract<RunEvent, { readonly _tag: Tag }>;
type StateOf<Tag extends RunState["_tag"]> = Extract<RunState, { readonly _tag: Tag }>;
/** A run that has started and has not ended. */
type Live = StateOf<"Running" | "WaitingForApproval" | "Compensating" | "Finalizing">;
type Verdict = Result.Result<RunState, RejectionReason>;

type WorkAttempt = Extract<Attempt, { readonly _tag: "Step" | "Undo" }>;
type WorkStatus = WorkAttempt["status"];
/** A step, or one item of a for-each. */
type Place = { readonly step: StepId; readonly item: ItemIndex | undefined };
/** The work an event names. */
type Work = {
  readonly step: StepId;
  readonly item?: ItemIndex;
  readonly attempt: AttemptNumber;
};

const reject = (reason: RejectionReason): Result.Result<never, RejectionReason> =>
  Result.fail(reason);

const isOpen = (attempt: Attempt): boolean => attempt.status === "Open";

const hasFailed = (attempt: Attempt): boolean =>
  attempt.status === "Failed" ||
  attempt.status === "FailedRetryable" ||
  attempt.status === "Denied";

const itemOf = (attempt: Attempt): ItemIndex | undefined =>
  attempt._tag === "Gate" ? undefined : attempt.item;

/** Whether an attempt is forward work of this phase. A gate is main-phase work. */
const inPhase =
  (phase: "Main" | "Finally") =>
  (attempt: Attempt): boolean =>
    attempt._tag === "Gate" ? phase === "Main" : attempt._tag === "Step" && attempt.phase === phase;

/** The step and item of some work, with no `item` key when there is none. */
const target = ({ item, step }: Work) => (item === undefined ? { step } : { step, item });

/**
 * The cleanups that have failed so far: undos and `finally` steps whose latest attempt failed.
 * If any is left when the run ends, the run ends in `NeedsAttention`.
 */
export const failedCleanups = (run: Run): ReadonlyArray<Attempt> =>
  run.attempts.filter(
    (attempt) =>
      (attempt._tag === "Undo" || (attempt._tag === "Step" && attempt.phase === "Finally")) &&
      hasFailed(attempt),
  );

/** Ends the open attempt a completion event names. */
const close = (
  run: Run,
  kind: WorkAttempt["_tag"],
  work: Work,
  status: WorkStatus,
): Result.Result<Run, RejectionReason> => {
  const matches = (attempt: Attempt): attempt is WorkAttempt =>
    attempt._tag === kind &&
    attempt.status === "Open" &&
    attempt.step === work.step &&
    attempt.item === work.item &&
    attempt.attempt === work.attempt;
  return run.attempts.some(matches)
    ? Result.succeed({
        ...run,
        attempts: run.attempts.map((attempt) =>
          matches(attempt) ? { ...attempt, status } : attempt,
        ),
      })
    : reject("NoOpenAttempt");
};

/** Ends the gate that is waiting, if the event names it. */
const closeGate = (
  state: Live,
  run: Run,
  gate: EventOf<"ApprovalGranted" | "ApprovalDenied">,
  status: "Approved" | "Denied",
): Verdict => {
  const matches = (attempt: Attempt): boolean =>
    attempt._tag === "Gate" &&
    attempt.status === "Open" &&
    attempt.step === gate.step &&
    attempt.attempt === gate.attempt;
  if (state._tag !== "WaitingForApproval" || !run.attempts.some(matches)) {
    return reject("NoOpenAttempt");
  }
  const attempts = run.attempts.map((attempt) =>
    attempt._tag === "Gate" && matches(attempt) ? { ...attempt, status } : attempt,
  );
  return Result.succeed({ _tag: "Running", run: { ...run, attempts }, track: state.track });
};

/**
 * More work on the step that is already running in its phase: a retry of an attempt that failed
 * and may be retried, or another item of a for-each, whose items run side by side.
 */
const beginMore = (
  run: Run,
  phase: "Main" | "Finally",
  work: Work,
): Result.Result<ReadonlyArray<Attempt>, RejectionReason> => {
  const opened: Attempt = {
    _tag: "Step",
    phase,
    ...target(work),
    attempt: work.attempt,
    status: "Open",
  };
  const ofStep = run.attempts.filter((attempt) => attempt.step === work.step);
  // A gate does not run again as a step, and a step is a for-each throughout or not at all.
  if (
    ofStep.some(
      (attempt) =>
        attempt._tag !== "Step" || (attempt.item === undefined) !== (work.item === undefined),
    )
  ) {
    return reject("StepAlreadyRan");
  }
  const previous = ofStep.find((attempt) => itemOf(attempt) === work.item);
  if (previous === undefined) {
    return work.attempt === 1
      ? Result.succeed([...run.attempts, opened])
      : reject("AttemptOutOfOrder");
  }
  return previous.status === "FailedRetryable" && work.attempt === previous.attempt + 1
    ? Result.succeed(run.attempts.map((attempt) => (attempt === previous ? opened : attempt)))
    : reject("AttemptOutOfOrder");
};

/**
 * Starts forward work: a step, a for-each item or a gate. Control never forks (M1 decision 1),
 * so a step the run has not seen starts only when nothing is in flight. `handler` says the step
 * before it failed or was denied, which makes this the start of the recipe's failure handler.
 */
const begin = (
  run: Run,
  phase: "Main" | "Finally",
  work: Work,
  gate: boolean,
): Result.Result<
  { readonly attempts: ReadonlyArray<Attempt>; readonly handler: boolean },
  RejectionReason
> => {
  const current = run.attempts.findLast(inPhase(phase))?.step;
  if (!gate && work.step === current) {
    return Result.map(beginMore(run, phase, work), (attempts) => ({ attempts, handler: false }));
  }
  if (run.attempts.some(isOpen)) {
    return reject("AttemptsOpen");
  }
  if (run.attempts.some((attempt) => attempt.step === work.step)) {
    return reject("StepAlreadyRan");
  }
  if (work.attempt !== 1) {
    return reject("AttemptOutOfOrder");
  }
  const opened: Attempt = gate
    ? { _tag: "Gate", step: work.step, attempt: work.attempt, status: "Open" }
    : { _tag: "Step", phase, ...target(work), attempt: work.attempt, status: "Open" };
  return Result.succeed({
    attempts: [...run.attempts, opened],
    handler: run.attempts.some((attempt) => attempt.step === current && hasFailed(attempt)),
  });
};

/**
 * Starts main-phase work. After a cancel was requested, the only work that may start is the
 * failure handler of a step that was in flight and failed: from there the run is failing, not
 * cancelling, and the handler runs to its end (M1 decision 18).
 */
const beginMain = (state: StateOf<"Running">, run: Run, work: Work, gate: boolean): Verdict =>
  Result.flatMap(begin(run, "Main", work, gate), ({ attempts, handler }): Verdict => {
    if (state.track === "CancelRequested" && !handler) {
      return reject("CancellationPending");
    }
    const track = handler ? "Handling" : state.track;
    return Result.succeed({
      _tag: gate ? "WaitingForApproval" : "Running",
      run: { ...run, attempts },
      track,
    });
  });

const stepStarted = (state: Live, run: Run, event: EventOf<"StepStarted">): Verdict => {
  if (state._tag === "WaitingForApproval") {
    return reject("GateWaiting");
  }
  // No `Main` step starts after the main phase ended, and no `Finally` step before.
  if ((event.phase === "Main") !== (state._tag === "Running")) {
    return reject("WrongPhase");
  }
  if (event.idempotencyKey !== idempotencyKey(run.runId, event.step, "Forward", event.item)) {
    return reject("WrongIdempotencyKey");
  }
  if (state._tag === "Running") {
    return beginMain(state, run, event, false);
  }
  // The first `finally` step ends the undo phase, once no undo is in flight.
  return Result.map(begin(run, "Finally", event, false), ({ attempts }) => ({
    _tag: "Finalizing",
    run: { ...run, attempts },
    main: state.main,
  }));
};

const gateOpened = (state: Live, run: Run, event: EventOf<"GateOpened">): Verdict => {
  if (state._tag === "WaitingForApproval") {
    return reject("GateWaiting");
  }
  return state._tag === "Running" ? beginMain(state, run, event, true) : reject("WrongPhase");
};

/**
 * Whether the step the main phase stopped at ended in a failure that is the step's own: a gate
 * that was denied, or a step that is not a for-each and failed for good. Such a run failed; it
 * was not cancelled. A failure that may be retried is not one: the next attempt had not started,
 * and a cancel takes effect before it. A for-each cut short by a cancel may hold failed items and
 * still be cancelled; whether it was cut short the log does not say (M1 spec, gap 33).
 */
const stoppedAtFailure = (run: Run): boolean => {
  const current = run.attempts.findLast(inPhase("Main"))?.step;
  return run.attempts.some(
    (attempt) =>
      attempt.step === current &&
      (attempt.status === "Failed" || attempt.status === "Denied") &&
      itemOf(attempt) === undefined,
  );
};

const mainPhaseEnded = (state: Live, run: Run, { main }: EventOf<"MainPhaseEnded">): Verdict => {
  if (state._tag !== "Running" && state._tag !== "WaitingForApproval") {
    return reject("WrongPhase");
  }
  if (main.result === "Cancelled") {
    // A cancel takes effect between steps and at a gate (M1 decision 17), and only if it was
    // requested while the run was on the normal track.
    if (state.track !== "CancelRequested" || stoppedAtFailure(run)) {
      return reject("NotCancelled");
    }
    // A gate still waiting is closed by the cancel. Anything else in flight ends first.
    const attempts = run.attempts.map((attempt): Attempt =>
      attempt._tag === "Gate" && attempt.status === "Open"
        ? { ...attempt, status: "Cancelled" }
        : attempt,
    );
    return attempts.some(isOpen)
      ? reject("AttemptsOpen")
      : Result.succeed({ _tag: "Compensating", run: { ...run, attempts }, main: "Cancelled" });
  }
  if (run.attempts.some(isOpen)) {
    return reject("AttemptsOpen");
  }
  return main.result === "Failed" && main.undo === "Run"
    ? Result.succeed({ _tag: "Compensating", run, main: "Failed" })
    : Result.succeed({ _tag: "Finalizing", run, main: main.result });
};

/**
 * Whether work `a` comes before work `b` on the way forward: by the order their steps first
 * started, then by item, since a for-each's items start side by side.
 */
const isBefore = (run: Run, a: Place, b: Place): boolean => {
  const position = (step: StepId): number =>
    run.attempts.findIndex((attempt) => attempt.step === step);
  return a.step === b.step ? (a.item ?? 0) < (b.item ?? 0) : position(a.step) < position(b.step);
};

/**
 * Starts an undo: of work that succeeded in the main phase, one at a time, each further back
 * than the last. The latest undo may be tried again if it failed and may be retried.
 */
const undoStarted = (state: Live, run: Run, event: EventOf<"UndoStarted">): Verdict => {
  if (state._tag !== "Compensating") {
    return reject("WrongPhase");
  }
  if (event.idempotencyKey !== idempotencyKey(run.runId, event.step, "Undo", event.item)) {
    return reject("WrongIdempotencyKey");
  }
  if (run.attempts.some(isOpen)) {
    return reject("AttemptsOpen");
  }
  const succeeded = run.attempts.some(
    (attempt) =>
      attempt._tag === "Step" &&
      attempt.phase === "Main" &&
      attempt.status === "Succeeded" &&
      attempt.step === event.step &&
      attempt.item === event.item,
  );
  if (!succeeded) {
    return reject("NothingToUndo");
  }
  const opened: Attempt = {
    _tag: "Undo",
    ...target(event),
    attempt: event.attempt,
    status: "Open",
  };
  const latest = run.attempts.findLast((attempt) => attempt._tag === "Undo");
  const compensating = (attempts: ReadonlyArray<Attempt>): Verdict =>
    Result.succeed({ ...state, run: { ...run, attempts } });
  if (latest !== undefined && latest.step === event.step && itemOf(latest) === event.item) {
    return latest.status === "FailedRetryable" && event.attempt === latest.attempt + 1
      ? compensating(run.attempts.map((attempt) => (attempt === latest ? opened : attempt)))
      : reject("AttemptOutOfOrder");
  }
  if (
    latest !== undefined &&
    !isBefore(
      run,
      { step: event.step, item: event.item },
      { step: latest.step, item: itemOf(latest) },
    )
  ) {
    return reject("UndoOutOfOrder");
  }
  return event.attempt === 1
    ? compensating([...run.attempts, opened])
    : reject("AttemptOutOfOrder");
};

const finalEventOf = {
  Succeeded: "RunSucceeded",
  Failed: "RunFailed",
  Cancelled: "RunCancelled",
} as const;

/**
 * Ends the run. The final event must agree with what the log recorded: `RunFlaggedForAttention`
 * if any cleanup failed, and otherwise the one that matches how the main phase ended.
 */
const runEnded = (
  state: Live,
  run: Run,
  event: EventOf<"RunSucceeded" | "RunFailed" | "RunCancelled" | "RunFlaggedForAttention">,
): Verdict => {
  if (state._tag !== "Compensating" && state._tag !== "Finalizing") {
    return reject("WrongPhase");
  }
  if (run.attempts.some(isOpen)) {
    return reject("AttemptsOpen");
  }
  const expected =
    failedCleanups(run).length > 0 ? "RunFlaggedForAttention" : finalEventOf[state.main];
  if (event._tag !== expected) {
    return reject("FinalResultMismatch");
  }
  switch (event._tag) {
    case "RunSucceeded": {
      return Result.succeed({ _tag: "Succeeded", run });
    }
    case "RunFailed": {
      return Result.succeed({ _tag: "Failed", run });
    }
    case "RunCancelled": {
      return Result.succeed({ _tag: "Cancelled", run });
    }
    case "RunFlaggedForAttention": {
      return Result.succeed({ _tag: "NeedsAttention", run, main: state.main });
    }
  }
};

const apply = (state: Live, run: Run, event: Exclude<RunEvent, EventOf<"RunStarted">>): Verdict => {
  const closed = (kind: WorkAttempt["_tag"], work: Work, status: WorkStatus): Verdict =>
    Result.map(close(run, kind, work, status), (next) => ({ ...state, run: next }));
  switch (event._tag) {
    case "StepStarted": {
      return stepStarted(state, run, event);
    }
    case "StepSucceeded": {
      return closed("Step", event, "Succeeded");
    }
    case "StepFailed": {
      return closed("Step", event, event.retryable ? "FailedRetryable" : "Failed");
    }
    case "GateOpened": {
      return gateOpened(state, run, event);
    }
    case "ApprovalGranted": {
      return closeGate(state, run, event, "Approved");
    }
    case "ApprovalDenied": {
      return closeGate(state, run, event, "Denied");
    }
    case "CancellationRequested": {
      // Recorded in every live state. It changes something only on the normal track of the main
      // phase: a failure handler and the cleanups are never cancelled.
      return Result.succeed(
        (state._tag === "Running" || state._tag === "WaitingForApproval") &&
          state.track === "Normal"
          ? { ...state, run, track: "CancelRequested" }
          : { ...state, run },
      );
    }
    case "MainPhaseEnded": {
      return mainPhaseEnded(state, run, event);
    }
    case "UndoStarted": {
      return undoStarted(state, run, event);
    }
    case "UndoSucceeded": {
      return closed("Undo", event, "Succeeded");
    }
    case "UndoFailed": {
      return closed("Undo", event, event.retryable ? "FailedRetryable" : "Failed");
    }
    case "RunSucceeded":
    case "RunFailed":
    case "RunCancelled":
    case "RunFlaggedForAttention": {
      return runEnded(state, run, event);
    }
  }
};

const decide = (state: RunState, event: RunEvent): Verdict => {
  switch (state._tag) {
    case "NotStarted": {
      if (event._tag !== "RunStarted") {
        return reject("RunNotStarted");
      }
      return event.seq === 0
        ? Result.succeed({
            _tag: "Running",
            run: { runId: event.runId, recipe: event.recipe, seq: event.seq, attempts: [] },
            track: "Normal",
          })
        : reject("OutOfSequence");
    }
    case "Succeeded":
    case "Failed":
    case "Cancelled":
    case "NeedsAttention": {
      return reject("RunAlreadyEnded");
    }
    case "Running":
    case "WaitingForApproval":
    case "Compensating":
    case "Finalizing": {
      const { run } = state;
      if (event.runId !== run.runId) {
        return reject("DifferentRun");
      }
      if (event.recipe.id !== run.recipe.id || event.recipe.version !== run.recipe.version) {
        return reject("RecipeChanged");
      }
      // Before the `seq` check: a run started twice is that, whatever `seq` the repeat carries.
      if (event._tag === "RunStarted") {
        return reject("RunAlreadyStarted");
      }
      return event.seq === run.seq + 1
        ? apply(state, { ...run, seq: event.seq }, event)
        : reject("OutOfSequence");
    }
  }
};

/**
 * The next state of a run after one event. An event that does not fit the state is a typed
 * rejection, never an exception, and leaves the state as it was. Pure: it reads no clock and
 * knows nothing of the recipe beyond its id and version.
 */
export const transition = (
  state: RunState,
  event: RunEvent,
): Result.Result<RunState, EventRejected> =>
  Result.mapError(decide(state, event), (reason) => ({
    _tag: "EventRejected",
    reason,
    state: state._tag,
    event: event._tag,
    seq: event.seq,
  }));

/** The state a log leads to, or the first event it holds that does not fit. */
export const replay = (events: Iterable<RunEvent>): Result.Result<RunState, EventRejected> => {
  let state: RunState = { _tag: "NotStarted" };
  for (const event of events) {
    const next = transition(state, event);
    if (Result.isFailure(next)) {
      return next;
    }
    state = next.success;
  }
  return Result.succeed(state);
};
