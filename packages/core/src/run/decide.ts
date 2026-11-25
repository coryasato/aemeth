import type { NonEmptyReadonlyArray } from "effect/Array";
import { Option } from "effect";
import type { StepId } from "../ids";
import type { ValidRecipe } from "../validate/index";
import type { ResolvedRecipe, ResolvedStep, ResolvedUndo } from "../validate/model";
import { isSuccess } from "../validate/model";
import type { MainEnd } from "../validate/paths";
import type { ItemIndex } from "./idempotencyKey";
import type { AttemptNumber } from "./RunEvent";
import type { Attempt, Run, RunState } from "./RunState";
import { failedCleanups } from "./transition";

// `decide` is the half of the engine that knows the recipe: from a recipe and a state it says
// the one thing to do next. `transition` is the half that does not. An engine that does only
// what `decide` returns cannot skip a step, an undo that is owed or a `finally` step.

/** How many items of a for-each run side by side (M2 decision 10). */
export const maxSideBySide = 4;

/** One attempt at a step, or at one item of a for-each. */
export type Work = { readonly item?: ItemIndex; readonly attempt: AttemptNumber };

/** The event that ends a run. */
export type FinalEvent = "RunSucceeded" | "RunFailed" | "RunCancelled" | "RunFlaggedForAttention";

/**
 * What to do next. Every `Run…` and `Open…` and `End…` is one or more events to append; the
 * `Await…` ones mean something else moves first: the run has not started, a gate is waiting for a
 * person, or work is in flight. `RunSteps` holds several pieces of work only for a for-each,
 * whose items run side by side.
 */
export type Decision =
  | { readonly _tag: "AwaitStart" }
  | {
      readonly _tag: "RunSteps";
      readonly phase: "Main" | "Finally";
      readonly step: ResolvedStep;
      readonly work: NonEmptyReadonlyArray<Work>;
    }
  | { readonly _tag: "OpenGate"; readonly step: ResolvedStep }
  | { readonly _tag: "AwaitGate"; readonly step: ResolvedStep }
  | { readonly _tag: "AwaitWork" }
  | { readonly _tag: "EndMainPhase"; readonly main: MainEnd }
  | {
      readonly _tag: "RunUndo";
      readonly step: ResolvedStep;
      readonly undo: ResolvedUndo;
      readonly work: Work;
    }
  | { readonly _tag: "EndRun"; readonly event: FinalEvent }
  | { readonly _tag: "Ended" };

type StepAttempt = Extract<Attempt, { readonly _tag: "Step" }>;
type Phase = "Main" | "Finally";

/** How a step's forward work stands. `CutShort`: work is left that a cancel keeps from starting. */
type Standing =
  | { readonly _tag: "Do"; readonly decision: Decision }
  | { readonly _tag: "Over"; readonly outcome: "Succeeded" | "Failed" }
  | { readonly _tag: "CutShort" };

const awaitWork: Standing = { _tag: "Do", decision: { _tag: "AwaitWork" } };
const cutShort: Standing = { _tag: "CutShort" };
const over = (outcome: "Succeeded" | "Failed"): Standing => ({ _tag: "Over", outcome });

const attemptsOf = (run: Run, step: ResolvedStep, phase: Phase): ReadonlyArray<StepAttempt> =>
  run.attempts.filter(
    (attempt): attempt is StepAttempt =>
      attempt._tag === "Step" && attempt.phase === phase && attempt.step === step.step.id,
  );

const startWork = (
  phase: Phase,
  step: ResolvedStep,
  cancelling: boolean,
  todo: ReadonlyArray<Work>,
): Standing | undefined => {
  const [first, ...rest] = todo;
  if (first === undefined) {
    return undefined;
  }
  return cancelling
    ? cutShort
    : { _tag: "Do", decision: { _tag: "RunSteps", phase, step, work: [first, ...rest] } };
};

/**
 * How a step that is not a gate stands in its phase. A cancel that is in effect keeps anything
 * new from starting: a step, an item or a retry (M1 decisions 17, 19 and 32).
 */
const standingOf = (
  run: Run,
  phase: Phase,
  step: ResolvedStep,
  size: number,
  cancelling: boolean,
): Standing => {
  const attempts = attemptsOf(run, step, phase);
  if (attempts.some((attempt) => attempt.status === "Open")) {
    return awaitWork;
  }
  const retries = attempts.flatMap((attempt): Array<Work> => {
    if (attempt.status !== "FailedRetryable") {
      return [];
    }
    const again = attempt.attempt + 1;
    return [
      attempt.item === undefined ? { attempt: again } : { item: attempt.item, attempt: again },
    ];
  });
  const failed = attempts.some((attempt) => attempt.status === "Failed");
  if (Option.isNone(step.forEach)) {
    const fresh: Array<Work> = attempts.length === 0 ? [{ attempt: 1 }] : [];
    return (
      startWork(phase, step, cancelling, [...retries, ...fresh]) ??
      over(failed ? "Failed" : "Succeeded")
    );
  }
  // After an item failed for good, `Stop` starts nothing more: no further item and no retry.
  if (failed && step.forEach.value.onItemFailure === "Stop") {
    return over("Failed");
  }
  const fresh = Array.from({ length: size }, (_, item): Work => ({ item, attempt: 1 })).filter(
    (work) => !attempts.some((attempt) => attempt.item === work.item),
  );
  return (
    startWork(phase, step, cancelling, [...retries, ...fresh].slice(0, maxSideBySide)) ??
    over(failed ? "Failed" : "Succeeded")
  );
};

const cancelled: Decision = { _tag: "EndMainPhase", main: { result: "Cancelled" } };

/**
 * The main phase: walks the recipe from `start` along the outcomes the state records, to the
 * first step that is not over. A step reached over a `Failed` or `Denied` edge is the recipe's
 * failure handler, which no cancel stops (M1 decisions 18 and 30).
 *
 * A for-each over an empty list is over before it begins: it leaves no event, and the walk
 * passes it. So a cancel takes effect before the first step ahead that has work to do, and a
 * run with none left ends as it would have.
 */
const mainPhase = (
  recipe: ResolvedRecipe,
  state: Extract<RunState, { readonly _tag: "Running" | "WaitingForApproval" }>,
  sizeOf: (step: ResolvedStep) => number,
): Decision => {
  const { run } = state;
  const from = (step: ResolvedStep, handling: boolean): Decision => {
    const cancelling = state.track === "CancelRequested" && !handling;
    const follow = (outcome: "Succeeded" | "Failed" | "Approved" | "Denied"): Decision => {
      const target = recipe.edges.get(step.step.id)?.get(outcome);
      if (target === undefined) {
        return {
          _tag: "EndMainPhase",
          main: isSuccess(outcome) ? { result: "Succeeded" } : { result: "Failed", undo: "Run" },
        };
      }
      if (target._tag === "End") {
        return {
          _tag: "EndMainPhase",
          main:
            target.result === "Succeeded"
              ? { result: "Succeeded" }
              : { result: "Failed", undo: target.undo },
        };
      }
      return from(target.step, handling || !isSuccess(outcome));
    };
    if (step.block.kind === "Gate") {
      const gate = run.attempts.find(
        (attempt) => attempt._tag === "Gate" && attempt.step === step.step.id,
      );
      switch (gate?.status) {
        case "Approved": {
          return follow("Approved");
        }
        case "Denied": {
          return follow("Denied");
        }
        case "Open": {
          return cancelling ? cancelled : { _tag: "AwaitGate", step };
        }
        default: {
          return cancelling ? cancelled : { _tag: "OpenGate", step };
        }
      }
    }
    const standing = standingOf(run, "Main", step, sizeOf(step), cancelling);
    switch (standing._tag) {
      case "Do": {
        return standing.decision;
      }
      case "CutShort": {
        return cancelled;
      }
      case "Over": {
        return follow(standing.outcome);
      }
    }
  };
  return from(recipe.start, false);
};

/**
 * The undo phase: the undo of every step and for-each item that succeeded in the main phase and
 * has one, one at a time, latest first. Nothing once each has been tried: a failed undo does not
 * stop the ones after it (M1 decision 3).
 */
const undoPhase = (recipe: ResolvedRecipe, run: Run): Decision | undefined => {
  const undos = run.attempts.filter((attempt) => attempt._tag === "Undo");
  const position = (step: StepId): number =>
    run.attempts.findIndex((attempt) => attempt.step === step);
  const owed = run.attempts
    .flatMap((attempt) => {
      // In the undo phase every step the state holds is a main-phase one.
      if (attempt._tag !== "Step" || attempt.status !== "Succeeded") {
        return [];
      }
      const step = recipe.main.find((candidate) => candidate.step.id === attempt.step);
      return step === undefined || Option.isNone(step.undo)
        ? []
        : [{ step, undo: step.undo.value, item: attempt.item }];
    })
    .toSorted(
      (a, b) =>
        position(b.step.step.id) - position(a.step.step.id) || (b.item ?? 0) - (a.item ?? 0),
    );
  const latest = undos.at(-1);
  if (latest?.status === "Open") {
    return { _tag: "AwaitWork" };
  }
  const next = owed.find(
    ({ item, step }) =>
      !undos.some((undo) => undo.step === step.step.id && undo.item === item) ||
      (latest?.status === "FailedRetryable" &&
        latest.step === step.step.id &&
        latest.item === item),
  );
  if (next === undefined) {
    return undefined;
  }
  const attempt = latest?.status === "FailedRetryable" ? latest.attempt + 1 : 1;
  return {
    _tag: "RunUndo",
    step: next.step,
    undo: next.undo,
    work: next.item === undefined ? { attempt } : { item: next.item, attempt },
  };
};

const finalEventOf = {
  Succeeded: "RunSucceeded",
  Failed: "RunFailed",
  Cancelled: "RunCancelled",
} as const;

/**
 * The `finally` phase: every `finally` step in order, whatever became of the ones before it, and
 * then the event that ends the run.
 */
const finallyPhase = (
  recipe: ResolvedRecipe,
  run: Run,
  main: "Succeeded" | "Failed" | "Cancelled",
  sizeOf: (step: ResolvedStep) => number,
): Decision => {
  for (const step of recipe.finally) {
    const standing = standingOf(run, "Finally", step, sizeOf(step), false);
    if (standing._tag === "Do") {
      return standing.decision;
    }
  }
  return {
    _tag: "EndRun",
    event: failedCleanups(run).length > 0 ? "RunFlaggedForAttention" : finalEventOf[main],
  };
};

/**
 * The next thing a run does, from its recipe and its state. Pure, and total over every state.
 *
 * `sizeOf` says how many items a for-each step runs over. That is a value in the log, not in the
 * state: `sizeOf` from `./values` reads it there.
 */
export const decide = (
  { resolved }: ValidRecipe,
  state: RunState,
  sizeOf: (step: ResolvedStep) => number,
): Decision => {
  switch (state._tag) {
    case "NotStarted": {
      return { _tag: "AwaitStart" };
    }
    case "Running":
    case "WaitingForApproval": {
      return mainPhase(resolved, state, sizeOf);
    }
    case "Compensating": {
      return (
        undoPhase(resolved, state.run) ?? finallyPhase(resolved, state.run, state.main, sizeOf)
      );
    }
    case "Finalizing": {
      return finallyPhase(resolved, state.run, state.main, sizeOf);
    }
    case "Succeeded":
    case "Failed":
    case "Cancelled":
    case "NeedsAttention": {
      return { _tag: "Ended" };
    }
  }
};
