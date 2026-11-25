import { Option, Result } from "effect";
import type { StepId } from "../ids";
import type { Outcome } from "../Recipe";
import type { ValidRecipe } from "../validate/index";
import type { ResolvedStep } from "../validate/model";
import { isSuccess } from "../validate/model";
import type { MainEnd, MainOutcome, Path, PathEntry } from "../validate/paths";
import type { ItemIndex } from "./idempotencyKey";
import type { RunEvent, Seq } from "./RunEvent";
import type { RunState } from "./RunState";
import { notStarted } from "./RunState";
import { transition } from "./transition";
import { sizeOf, valuesOf } from "./values";

// `followsRecipe` is the check `transition` cannot make (M1 gap 28): that a log did what its
// recipe says, step by step. It reads the log and the recipe and never calls `decide`, so the two
// are each other's second opinion.

/** How a log left its recipe. */
export const departures = [
  /** `transition` rejects the event: the log is not a run at all. */
  "RejectedByTransition",
  /** A step started that is not the one the recipe leads to. */
  "NotTheNextStep",
  /** Something began or ended while the step before it still had work to do. */
  "StepNotOver",
  /** A gate was run as a step, a step opened as a gate, or an item given to a plain step. */
  "WrongKindOfWork",
  /** An item past the end of its for-each's list. */
  "NoSuchItem",
  /** An item or a retry after an item failed for good in a for-each that stops at a failure. */
  "ForEachHadStopped",
  /** The main phase ended in a way the recipe does not give this path. */
  "WrongEnd",
  /** The main phase ended `Cancelled` where the recipe has no cancellation point. */
  "NoCancellationPoint",
  /** An undo that is not the next one owed. */
  "UndoOutOfTurn",
  /** The run moved on with an undo still owed. */
  "UndoOwed",
  /** A `finally` step that is not the next in the recipe's list. */
  "FinallyOutOfTurn",
  /** The run ended with a `finally` step still owed. */
  "FinallyOwed",
] as const;
export type Departure = (typeof departures)[number];

/** The first event of a log that leaves the recipe, and how. */
export type LeftRecipe = {
  readonly _tag: "LeftRecipe";
  readonly seq: Seq;
  readonly event: RunEvent["_tag"];
  readonly departure: Departure;
};

type Status = "Open" | "Succeeded" | "Failed" | "FailedRetryable" | "Approved" | "Denied";
type Kind = "Forward" | "Undo";
type MainEntry = { readonly step: ResolvedStep; readonly outcome: MainOutcome };
/** Where the main phase goes next: a step it has not begun, or its end. */
type Next =
  | {
      readonly _tag: "Step";
      readonly step: ResolvedStep;
      readonly handling: boolean;
      readonly passed: ReadonlyArray<MainEntry>;
    }
  | { readonly _tag: "End"; readonly main: MainEnd; readonly passed: ReadonlyArray<MainEntry> };
type Owed = { readonly step: ResolvedStep; readonly item: ItemIndex | undefined };

const isForEach = (step: ResolvedStep): boolean => Option.isSome(step.forEach);

/** Whether a failed end runs the undo phase; nothing for an end that is not a failure. */
const undoOf = (main: MainEnd): "Run" | "Skip" | undefined =>
  main.result === "Failed" ? main.undo : undefined;

const sameMain = (a: MainEnd, b: MainEnd): boolean =>
  a.result === b.result && undoOf(a) === undoOf(b);

/**
 * Whether a log follows its recipe: every step it started is the one the recipe leads to from
 * the outcomes before it, the main phase ended as the recipe says, every undo owed ran in
 * reverse order and no other, and every `finally` step ran in order. A log may stop anywhere: an
 * unfinished one follows its recipe so far.
 *
 * Returns the path the run took, as the validator would write it, once the log is finished; a
 * for-each is one entry, and so is the undo of its items. Otherwise the first event that leaves
 * the recipe.
 */
export const followsRecipe = (
  { resolved }: ValidRecipe,
  log: ReadonlyArray<RunEvent>,
): Result.Result<Option.Option<Path>, LeftRecipe> => {
  const values = valuesOf(log);
  const size = (step: ResolvedStep): number => sizeOf(resolved, step, values);

  /** The latest status of every piece of work the log has started, in the order each started. */
  const works: Array<{ kind: Kind; step: StepId; item: ItemIndex | undefined; status: Status }> =
    [];
  const workOf = (kind: Kind, step: StepId, item: ItemIndex | undefined) =>
    works.find((work) => work.kind === kind && work.step === step && work.item === item);
  // A retry leaves the status of the attempt before it until it ends: `transition` lets nothing
  // else happen to that work meanwhile.
  const opened = (kind: Kind, step: StepId, item: ItemIndex | undefined): void => {
    if (workOf(kind, step, item) === undefined) {
      works.push({ kind, step, item, status: "Open" });
    }
  };
  const closed = (kind: Kind, step: StepId, item: ItemIndex | undefined, status: Status): void => {
    const work = workOf(kind, step, item);
    if (work !== undefined) {
      work.status = status;
    }
  };
  const statusesOf = (kind: Kind, step: ResolvedStep): ReadonlyArray<Status> =>
    works.flatMap((work) =>
      work.kind === kind && work.step === step.step.id ? [work.status] : [],
    );

  /** How a step ended, or nothing while it still has work to do. */
  const outcomeOf = (step: ResolvedStep): Outcome | undefined => {
    const statuses = statusesOf("Forward", step);
    const failed = statuses.includes("Failed");
    if (!isForEach(step)) {
      return statuses.find(
        (status) =>
          status === "Succeeded" ||
          status === "Failed" ||
          status === "Approved" ||
          status === "Denied",
      );
    }
    if (failed && step.forEach.pipe(Option.exists((each) => each.onItemFailure === "Stop"))) {
      return "Failed";
    }
    const settled = statuses.filter((status) => status === "Succeeded" || status === "Failed");
    if (settled.length < size(step)) {
      return undefined;
    }
    return failed ? "Failed" : "Succeeded";
  };

  /**
   * From a step the run has reached but not begun: past every for-each with nothing to run,
   * which ends `Succeeded` and leaves no event.
   */
  const arriveAt = (
    step: ResolvedStep,
    handling: boolean,
    passed: ReadonlyArray<MainEntry>,
  ): Next =>
    isForEach(step) && size(step) === 0
      ? leave(step, "Succeeded", handling, passed)
      : { _tag: "Step", step, handling, passed };
  /** From a step that ended: along its edge for that outcome, or to the default end. */
  const leave = (
    step: ResolvedStep,
    outcome: Outcome,
    handling: boolean,
    before: ReadonlyArray<MainEntry>,
  ): Next => {
    const passed = [...before, { step, outcome }];
    const target = resolved.edges.get(step.step.id)?.get(outcome);
    if (target === undefined) {
      return {
        _tag: "End",
        main: isSuccess(outcome) ? { result: "Succeeded" } : { result: "Failed", undo: "Run" },
        passed,
      };
    }
    if (target._tag === "End") {
      return {
        _tag: "End",
        main:
          target.result === "Succeeded"
            ? { result: "Succeeded" }
            : { result: "Failed", undo: target.undo },
        passed,
      };
    }
    return arriveAt(target.step, handling || !isSuccess(outcome), passed);
  };

  let entries: ReadonlyArray<MainEntry> = [];
  let current: { readonly step: ResolvedStep; readonly handling: boolean } | undefined;
  let mainEnd: MainEnd | undefined;
  let owed: ReadonlyArray<Owed> = [];
  let undone = 0;
  let latestUndo: { readonly step: StepId; readonly item: ItemIndex | undefined } | undefined;
  /** The `finally` step the run is on, as a place in the recipe's list; -1 before the first. */
  let cleanup = -1;

  /** Where the main phase goes from here, or nothing while the current step is not over. */
  const next = (): Next | undefined => {
    if (current === undefined) {
      return arriveAt(resolved.start, false, entries);
    }
    const outcome = outcomeOf(current.step);
    return outcome === undefined
      ? undefined
      : leave(current.step, outcome, current.handling, entries);
  };

  /** Checks one piece of forward work against the step it belongs to. */
  const workFits = (step: ResolvedStep, item: ItemIndex | undefined): Departure | undefined => {
    if ((item !== undefined) !== isForEach(step)) {
      return "WrongKindOfWork";
    }
    if (item !== undefined && item >= size(step)) {
      return "NoSuchItem";
    }
    return isForEach(step) && outcomeOf(step) === "Failed" ? "ForEachHadStopped" : undefined;
  };

  const mainStarted = (
    id: StepId,
    item: ItemIndex | undefined,
    gate: boolean,
  ): Departure | undefined => {
    if (current?.step.step.id !== id) {
      const to = next();
      if (to === undefined) {
        return "StepNotOver";
      }
      if (to._tag === "End" || to.step.step.id !== id) {
        return "NotTheNextStep";
      }
      entries = to.passed;
      current = { step: to.step, handling: to.handling };
    }
    if ((current.step.block.kind === "Gate") !== gate) {
      return "WrongKindOfWork";
    }
    return gate ? undefined : workFits(current.step, item);
  };

  /**
   * The undos a main phase leaves owing: what succeeded and has an undo, latest first. Read when
   * the main phase ends, so all the work there is yet is main-phase work.
   */
  const undosOwed = (): ReadonlyArray<Owed> => {
    const order = [...new Set(works.map((work) => work.step))];
    return works
      .flatMap((work): Array<Owed> => {
        const step = resolved.main.find((candidate) => candidate.step.id === work.step);
        return work.status === "Succeeded" && step !== undefined && Option.isSome(step.undo)
          ? [{ step, item: work.item }]
          : [];
      })
      .toSorted(
        (a, b) =>
          order.indexOf(b.step.step.id) - order.indexOf(a.step.step.id) ||
          (b.item ?? 0) - (a.item ?? 0),
      );
  };

  const mainEnded = (main: MainEnd): Departure | undefined => {
    const to = next();
    if (main.result === "Cancelled") {
      if (to === undefined) {
        // The step the run was on is cut short: a gate still waiting, a for-each partway. A plain
        // step whose retry the cancel forestalled did nothing, and leaves no entry. `transition`
        // has already refused a cancel that a failure handler would have ignored.
        const step = current?.step;
        const partway: MainOutcome | undefined =
          step?.block.kind === "Gate"
            ? "CancelledWaiting"
            : step !== undefined && isForEach(step)
              ? "CancelledPartway"
              : undefined;
        entries =
          step === undefined || partway === undefined
            ? entries
            : [...entries, { step, outcome: partway }];
      } else if (to._tag === "End" || to.handling) {
        return "NoCancellationPoint";
      } else {
        entries = to.passed;
      }
    } else {
      if (to === undefined) {
        return "StepNotOver";
      }
      if (to._tag === "Step" || !sameMain(to.main, main)) {
        return "WrongEnd";
      }
      entries = to.passed;
    }
    mainEnd = main;
    owed = main.result === "Cancelled" || undoOf(main) === "Run" ? undosOwed() : [];
    return undefined;
  };

  /** Whether the latest undo has been tried to its end: it succeeded, or failed for good. */
  const undoSettled = (): boolean => {
    const status =
      latestUndo === undefined
        ? undefined
        : workOf("Undo", latestUndo.step, latestUndo.item)?.status;
    return status !== "FailedRetryable";
  };

  const undoStarted = (id: StepId, item: ItemIndex | undefined): Departure | undefined => {
    if (latestUndo?.step === id && latestUndo.item === item) {
      return undefined;
    }
    const due = owed[undone];
    if (due === undefined || due.step.step.id !== id || due.item !== item) {
      return "UndoOutOfTurn";
    }
    if (!undoSettled()) {
      return "StepNotOver";
    }
    undone += 1;
    latestUndo = { step: id, item };
    return undefined;
  };

  const undosDone = (): Departure | undefined => {
    if (undone < owed.length) {
      return "UndoOwed";
    }
    return undoSettled() ? undefined : "StepNotOver";
  };

  /** Whether a `finally` step has nothing left to do. A failed one is over: the next still runs. */
  const cleanupOver = (step: ResolvedStep | undefined): boolean =>
    step === undefined || outcomeOf(step) !== undefined;

  /** The place of the next `finally` step with anything to run, or the list's length. */
  const nextCleanup = (): number => {
    let place = cleanup + 1;
    for (
      let step = resolved.finally[place];
      step !== undefined && isForEach(step) && size(step) === 0;
      step = resolved.finally[place]
    ) {
      place += 1;
    }
    return place;
  };

  const finallyStarted = (id: StepId, item: ItemIndex | undefined): Departure | undefined => {
    const running = resolved.finally[cleanup];
    if (running?.step.id === id) {
      return workFits(running, item);
    }
    const pending = undosDone();
    if (pending !== undefined) {
      return pending;
    }
    if (!cleanupOver(running)) {
      return "StepNotOver";
    }
    const place = nextCleanup();
    const step = resolved.finally[place];
    if (step?.step.id !== id) {
      return "FinallyOutOfTurn";
    }
    cleanup = place;
    return workFits(step, item);
  };

  const runEnded = (): Departure | undefined => {
    const pending = undosDone();
    if (pending !== undefined) {
      return pending;
    }
    if (!cleanupOver(resolved.finally[cleanup])) {
      return "StepNotOver";
    }
    return nextCleanup() < resolved.finally.length ? "FinallyOwed" : undefined;
  };

  const check = (event: RunEvent): Departure | undefined => {
    switch (event._tag) {
      case "RunStarted":
      case "CancellationRequested": {
        return undefined;
      }
      case "StepStarted": {
        const departure =
          event.phase === "Main"
            ? mainStarted(event.step, event.item, false)
            : finallyStarted(event.step, event.item);
        opened("Forward", event.step, event.item);
        return departure;
      }
      case "GateOpened": {
        const departure = mainStarted(event.step, undefined, true);
        opened("Forward", event.step, undefined);
        return departure;
      }
      case "StepSucceeded": {
        closed("Forward", event.step, event.item, "Succeeded");
        return undefined;
      }
      case "StepFailed": {
        closed("Forward", event.step, event.item, event.retryable ? "FailedRetryable" : "Failed");
        return undefined;
      }
      case "ApprovalGranted": {
        closed("Forward", event.step, undefined, "Approved");
        return undefined;
      }
      case "ApprovalDenied": {
        closed("Forward", event.step, undefined, "Denied");
        return undefined;
      }
      case "MainPhaseEnded": {
        return mainEnded(event.main);
      }
      case "UndoStarted": {
        const departure = undoStarted(event.step, event.item);
        opened("Undo", event.step, event.item);
        return departure;
      }
      case "UndoSucceeded": {
        closed("Undo", event.step, event.item, "Succeeded");
        return undefined;
      }
      case "UndoFailed": {
        closed("Undo", event.step, event.item, event.retryable ? "FailedRetryable" : "Failed");
        return undefined;
      }
      case "RunSucceeded":
      case "RunFailed":
      case "RunCancelled":
      case "RunFlaggedForAttention": {
        return runEnded();
      }
    }
  };

  let state: RunState = notStarted;
  for (const event of log) {
    const accepted = transition(state, event);
    const departure = Result.isFailure(accepted) ? "RejectedByTransition" : check(event);
    if (departure !== undefined || Result.isFailure(accepted)) {
      return Result.fail({
        _tag: "LeftRecipe",
        seq: event.seq,
        event: event._tag,
        departure: departure ?? "RejectedByTransition",
      });
    }
    state = accepted.success;
  }

  const main = mainEnd;
  if (
    main === undefined ||
    state._tag === "NotStarted" ||
    state._tag === "Running" ||
    state._tag === "WaitingForApproval" ||
    state._tag === "Compensating" ||
    state._tag === "Finalizing"
  ) {
    return Result.succeed(Option.none());
  }

  // The path as the validator writes it: a for-each with an undo has an undo entry however it
  // ended, since some of its items may have succeeded (M1 decision 16).
  const cleanupOutcome = (kind: Kind, step: ResolvedStep): "Succeeded" | "Failed" =>
    statusesOf(kind, step).includes("Failed") ? "Failed" : "Succeeded";
  const undoRan = main.result === "Cancelled" || undoOf(main) === "Run";
  const undos = undoRan
    ? entries
        .filter(
          ({ outcome, step }) =>
            Option.isSome(step.undo) && (outcome === "Succeeded" || isForEach(step)),
        )
        .toReversed()
        .map(({ step }): PathEntry => ({
          phase: "Undo",
          step: step.step.id,
          outcome: cleanupOutcome("Undo", step),
        }))
    : [];
  const cleanups = resolved.finally.map((step): PathEntry => ({
    phase: "Finally",
    step: step.step.id,
    outcome: cleanupOutcome("Forward", step),
  }));
  const failed = [...undos, ...cleanups].some((entry) => entry.outcome === "Failed");
  return Result.succeed(
    Option.some({
      entries: [
        ...entries.map(({ outcome, step }): PathEntry => ({
          phase: "Main",
          step: step.step.id,
          outcome,
        })),
        ...undos,
        ...cleanups,
      ],
      main,
      result: failed ? "NeedsAttention" : main.result,
    }),
  );
};
