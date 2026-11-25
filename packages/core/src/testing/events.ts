import { Result, Schema } from "effect";
import type { Attempt, RunState } from "../run/index";
import { notStarted, RunEvent, transition } from "../run/index";
import type { Parts } from "./build";

// Builders for run events, and the two halves of the guided property test of `transition`
// (M1 decision 13): `candidates` lists what could arrive in a state, and `brokenRunInvariants`
// checks a log against the run invariants without looking at any state.

/** The numbers a guided event sequence is built from: two for each event, so up to 48 events. */
export const TracePicks = Schema.Array(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9999 })),
).check(Schema.isMinLength(96), Schema.isMaxLength(96));

const decodeEvent = Schema.decodeUnknownSync(RunEvent, { onExcessProperty: "error" });

const runId = "run1";

/** A fact with its envelope. The fact may override any envelope field, to build a bad one. */
export const eventAt = (seq: number, fact: Parts): RunEvent =>
  decodeEvent({
    eventSchemaVersion: 1,
    runId,
    seq,
    at: 1_700_000_000_000 + seq,
    recipe: { id: "test", version: 1 },
    ...fact,
  });

type Work = { readonly item?: number | undefined; readonly attempt?: number };
const work = (step: string, { attempt = 1, item }: Work) =>
  item === undefined ? { step, attempt } : { step, item, attempt };
const keyOf = (step: string, phase: string, item: number | undefined): string =>
  item === undefined ? `${runId}:${step}:${phase}` : `${runId}:${step}:${phase}:${item}`;
const error = { name: "Broke", message: "It broke." };

export const runStarted: Parts = { _tag: "RunStarted", inputs: {} };
export const stepStarted = (step: string, at: Work = {}, phase = "Main"): Parts => ({
  _tag: "StepStarted",
  phase,
  ...work(step, at),
  idempotencyKey: keyOf(step, "Forward", at.item),
});
export const finallyStarted = (step: string, at: Work = {}): Parts =>
  stepStarted(step, at, "Finally");
export const stepSucceeded = (step: string, at: Work = {}): Parts => ({
  _tag: "StepSucceeded",
  ...work(step, at),
  outputs: {},
});
export const stepFailed = (step: string, at: Work = {}, retryable = false): Parts => ({
  _tag: "StepFailed",
  ...work(step, at),
  error,
  retryable,
});
export const gateOpened = (step: string, attempt = 1): Parts => ({
  _tag: "GateOpened",
  step,
  attempt,
});
export const approved = (step: string, attempt = 1): Parts => ({
  _tag: "ApprovalGranted",
  step,
  attempt,
  by: "ada@example.com",
  outputs: {},
});
export const denied = (step: string, attempt = 1): Parts => ({
  _tag: "ApprovalDenied",
  step,
  attempt,
  by: "ada@example.com",
});
export const cancelRequested: Parts = { _tag: "CancellationRequested", by: "ada@example.com" };
export const mainSucceeded: Parts = { _tag: "MainPhaseEnded", main: { result: "Succeeded" } };
export const mainFailed = (undo: "Run" | "Skip" = "Run"): Parts => ({
  _tag: "MainPhaseEnded",
  main: { result: "Failed", undo },
});
export const mainCancelled: Parts = { _tag: "MainPhaseEnded", main: { result: "Cancelled" } };
export const undoStarted = (step: string, at: Work = {}): Parts => ({
  _tag: "UndoStarted",
  ...work(step, at),
  idempotencyKey: keyOf(step, "Undo", at.item),
});
export const undoSucceeded = (step: string, at: Work = {}): Parts => ({
  _tag: "UndoSucceeded",
  ...work(step, at),
});
export const undoFailed = (step: string, at: Work = {}, retryable = false): Parts => ({
  _tag: "UndoFailed",
  ...work(step, at),
  error,
  retryable,
});
export const runSucceeded: Parts = { _tag: "RunSucceeded" };
export const runFailed: Parts = { _tag: "RunFailed" };
export const runCancelled: Parts = { _tag: "RunCancelled" };
export const runFlagged: Parts = { _tag: "RunFlaggedForAttention" };

/** The facts as a log: each gets the next `seq`. */
export const logOf = (facts: ReadonlyArray<Parts>): ReadonlyArray<RunEvent> =>
  facts.map((fact, seq) => eventAt(seq, fact));

/** The state after these facts. Throws if `transition` rejects one: the test is then wrong. */
export const stateAfter = (facts: ReadonlyArray<Parts>): RunState =>
  logOf(facts).reduce((state, event) => Result.getOrThrow(transition(state, event)), notStarted);

const itemOf = (attempt: Attempt | undefined): number | undefined =>
  attempt === undefined || attempt._tag === "Gate" ? undefined : attempt.item;

/** `"s0#1"` for a for-each item, `"s0"` otherwise. */
const place = (step: string, item: number | undefined): string =>
  item === undefined ? step : `${step}#${item}`;

const showEvent = (event: RunEvent): string => {
  switch (event._tag) {
    case "StepStarted": {
      return `${event._tag}(${event.phase} ${place(event.step, event.item)} @${event.attempt})`;
    }
    case "StepSucceeded":
    case "UndoStarted":
    case "UndoSucceeded": {
      return `${event._tag}(${place(event.step, event.item)} @${event.attempt})`;
    }
    case "StepFailed":
    case "UndoFailed": {
      const retryable = event.retryable ? " retryable" : "";
      return `${event._tag}(${place(event.step, event.item)} @${event.attempt}${retryable})`;
    }
    case "GateOpened":
    case "ApprovalGranted":
    case "ApprovalDenied": {
      return `${event._tag}(${event.step})`;
    }
    case "MainPhaseEnded": {
      const undo = event.main.result === "Failed" ? ` ${event.main.undo}` : "";
      return `${event._tag}(${event.main.result}${undo})`;
    }
    case "RunStarted":
    case "CancellationRequested":
    case "RunSucceeded":
    case "RunFailed":
    case "RunCancelled":
    case "RunFlaggedForAttention": {
      return event._tag;
    }
  }
};

/** One line for a log, for a failing property to print. */
export const showLog = (log: ReadonlyArray<RunEvent>): string => log.map(showEvent).join(", ");

/**
 * What could arrive next: `good` must be accepted, and `bad` and `misplaced` must be rejected.
 * `bad` is wrong for this state in particular; `misplaced` would be wrong in any live state (a
 * skipped `seq`, another run, a completion of nothing), and is kept apart so that it does not
 * crowd out the rest.
 */
export type Candidates = {
  readonly good: ReadonlyArray<Parts>;
  readonly bad: ReadonlyArray<Parts>;
  readonly misplaced: ReadonlyArray<Parts>;
};

const failed = (status: string): boolean =>
  status === "Failed" || status === "FailedRetryable" || status === "Denied";

const finals = [runSucceeded, runFailed, runCancelled, runFlagged];
const finalOf = { Succeeded: runSucceeded, Failed: runFailed, Cancelled: runCancelled };

/**
 * The events that could arrive in a state, including ones that must be rejected. Uniform random
 * events end a run within a few events (M1 Part A findings), so the property test picks from
 * these instead. A step is invented when one is needed: `s0`, `s1`, … in the order they start.
 *
 * This reads the state `transition` built, so it is not a second opinion on it. The second
 * opinion is `brokenRunInvariants`, which reads only the log.
 */
export const candidates = (state: RunState): Candidates => {
  if (state._tag === "NotStarted") {
    return {
      good: [runStarted],
      bad: [{ ...runStarted, seq: 1 }, cancelRequested, stepStarted("s0"), mainSucceeded],
      misplaced: [],
    };
  }
  if (
    state._tag === "Succeeded" ||
    state._tag === "Failed" ||
    state._tag === "Cancelled" ||
    state._tag === "NeedsAttention"
  ) {
    return {
      good: [],
      bad: [cancelRequested, runStarted, stepStarted("s9"), ...finals],
      misplaced: [],
    };
  }

  const { attempts, seq } = state.run;
  const good: Array<Parts> = [cancelRequested];
  const bad: Array<Parts> = [];
  const misplaced: Array<Parts> = [
    { ...cancelRequested, seq: seq + 2 },
    { ...cancelRequested, seq },
    { ...cancelRequested, runId: "run2" },
    { ...cancelRequested, recipe: { id: "test", version: 2 } },
    { ...cancelRequested, recipe: { id: "other", version: 1 } },
    runStarted,
    stepSucceeded("zz"),
    undoSucceeded("zz"),
    approved("zz"),
  ];
  const add = (valid: boolean, ...facts: ReadonlyArray<Parts>): void => {
    (valid ? good : bad).push(...facts);
  };

  const fresh = `s${new Set(attempts.map((attempt) => attempt.step)).size}`;
  const open = attempts.filter((attempt) => attempt.status === "Open");
  const idle = open.length === 0;

  /** The forward work of the main or the `finally` phase: completions, retries, items, new steps. */
  const forward = (
    phase: "Main" | "Finally",
    mayStartMore: boolean,
    mayStartNew: boolean,
  ): void => {
    const started = (step: string, at: Work = {}) => stepStarted(step, at, phase);
    const ofPhase = attempts.filter((attempt) =>
      attempt._tag === "Gate"
        ? phase === "Main"
        : attempt._tag === "Step" && attempt.phase === phase,
    );
    const current = ofPhase.at(-1)?.step;
    for (const attempt of attempts) {
      if (attempt._tag === "Step" && attempt.status === "Open") {
        const at = { item: attempt.item, attempt: attempt.attempt };
        const again = { item: attempt.item, attempt: attempt.attempt + 1 };
        // Success twice, so that it is as likely as failure.
        good.push(
          stepSucceeded(attempt.step, at),
          stepSucceeded(attempt.step, at),
          stepFailed(attempt.step, at, true),
          stepFailed(attempt.step, at, false),
        );
        bad.push(started(attempt.step, again), stepSucceeded(attempt.step, again));
      }
      if (attempt._tag === "Step" && attempt.step === current && attempt.status !== "Open") {
        const again = { item: attempt.item, attempt: attempt.attempt + 1 };
        add(mayStartMore && attempt.status === "FailedRetryable", started(attempt.step, again));
        bad.push(
          started(attempt.step, { item: attempt.item, attempt: attempt.attempt + 2 }),
          stepSucceeded(attempt.step, { item: attempt.item, attempt: attempt.attempt }),
        );
      }
      if (attempt.step !== current) {
        bad.push(
          started(attempt.step),
          started(attempt.step, { item: 7 }),
          gateOpened(attempt.step),
        );
      }
    }
    const items = attempts.flatMap((attempt) =>
      attempt._tag === "Step" && attempt.step === current && attempt.item !== undefined
        ? [attempt.item]
        : [],
    );
    if (current !== undefined && items.length > 0) {
      add(mayStartMore, started(current, { item: Math.max(...items) + 1 }));
      bad.push(started(current), started(current, { item: Math.max(...items) + 1, attempt: 2 }));
    } else if (current !== undefined) {
      bad.push(started(current, { item: 0 }));
    }
    // A new step several times over, so that it is likelier than the end of the phase. The
    // weights never depend on `seq`: dropping an event must not change what the next ones mean,
    // or a failing sequence would not shrink.
    for (let weight = 0; weight < 3; weight += 1) {
      add(idle && mayStartNew, started(fresh), started(fresh, { item: 0 }));
    }
    bad.push(
      started(fresh, { attempt: 2 }),
      { ...started(fresh), idempotencyKey: keyOf(fresh, "Undo", undefined) },
      { ...started(fresh, { item: 1 }), idempotencyKey: keyOf(fresh, "Forward", 2) },
    );
  };

  switch (state._tag) {
    case "Running": {
      const current = attempts.at(-1)?.step;
      const ofCurrent = attempts.filter((attempt) => attempt.step === current);
      const currentFailed = ofCurrent.some((attempt) => failed(attempt.status));
      const stoppedAtFailure = ofCurrent.some(
        (attempt) =>
          (attempt.status === "Failed" || attempt.status === "Denied") &&
          (attempt._tag === "Gate" || attempt.item === undefined),
      );
      const cancelling = state.track === "CancelRequested";
      forward("Main", !cancelling, !cancelling || currentFailed);
      add(idle && (!cancelling || currentFailed), gateOpened(fresh));
      // One way to end at a time, so that a run more often goes on than ends, and the one that
      // leads to the undo phase twice as often as the others.
      const ends = [mainFailed("Run"), mainSucceeded, mainFailed("Run"), mainFailed("Skip")];
      add(idle, ends[attempts.length % ends.length] ?? mainSucceeded);
      add(idle && cancelling && !stoppedAtFailure, mainCancelled);
      bad.push(
        finallyStarted(fresh),
        gateOpened(fresh, 2),
        undoStarted(attempts[0]?.step ?? "s0", { item: itemOf(attempts[0]) }),
        ...finals,
      );
      break;
    }
    case "WaitingForApproval": {
      const gate = open[0]?.step ?? "s0";
      good.push(approved(gate), denied(gate));
      add(state.track === "CancelRequested", mainCancelled, mainCancelled);
      bad.push(
        stepStarted(fresh),
        finallyStarted(fresh),
        gateOpened(fresh),
        mainSucceeded,
        mainFailed("Run"),
        approved(gate, 2),
        denied(fresh),
        stepSucceeded(gate),
        undoStarted(gate),
        ...finals,
      );
      break;
    }
    case "Compensating": {
      const undos = attempts.filter((attempt) => attempt._tag === "Undo");
      const latest = undos.at(-1);
      const position = (step: string): number =>
        attempts.findIndex((attempt) => attempt.step === step);
      for (const attempt of attempts) {
        if (attempt._tag === "Undo" && attempt.status === "Open") {
          const at = { item: attempt.item, attempt: attempt.attempt };
          good.push(
            undoSucceeded(attempt.step, at),
            undoFailed(attempt.step, at, true),
            undoFailed(attempt.step, at, false),
          );
          bad.push(
            undoSucceeded(attempt.step, { item: attempt.item, attempt: attempt.attempt + 1 }),
          );
        }
        if (attempt._tag === "Undo" && attempt.status !== "Open") {
          const again = { item: attempt.item, attempt: attempt.attempt + 1 };
          for (let weight = 0; weight < 4; weight += 1) {
            add(
              idle && attempt === latest && attempt.status === "FailedRetryable",
              undoStarted(attempt.step, again),
            );
          }
          bad.push(undoStarted(attempt.step, { item: attempt.item }));
        }
        if (attempt._tag === "Gate" || attempt.status !== "Succeeded") {
          bad.push(undoStarted(attempt.step, { item: itemOf(attempt) }));
        }
        if (attempt._tag === "Step" && attempt.status === "Succeeded") {
          const at = { item: attempt.item };
          const isUndone = undos.some(
            (undo) => undo.step === attempt.step && itemOf(undo) === attempt.item,
          );
          const isBeforeLatest =
            latest === undefined ||
            (attempt.step === latest.step
              ? (attempt.item ?? 0) < (itemOf(latest) ?? 0)
              : position(attempt.step) < position(latest.step));
          if (!isUndone) {
            // An undo several times over, so that it is likelier than leaving the undo phase.
            for (let weight = 0; weight < 4; weight += 1) {
              add(idle && isBeforeLatest, undoStarted(attempt.step, at));
            }
            bad.push(undoStarted(attempt.step, { item: attempt.item, attempt: 2 }), {
              ...undoStarted(attempt.step, at),
              idempotencyKey: keyOf(attempt.step, "Forward", attempt.item),
            });
          }
        }
      }
      add(idle, finallyStarted(fresh), finallyStarted(fresh, { item: 0 }));
      const expected = attempts.some((attempt) => attempt._tag === "Undo" && failed(attempt.status))
        ? runFlagged
        : finalOf[state.main];
      add(idle, expected);
      bad.push(
        ...finals.filter((fact) => fact !== expected),
        stepStarted(fresh),
        gateOpened(fresh),
        mainSucceeded,
        mainCancelled,
        undoStarted(fresh),
        finallyStarted(fresh, { attempt: 2 }),
      );
      break;
    }
    case "Finalizing": {
      forward("Finally", true, true);
      const expected = attempts.some(
        (attempt) =>
          (attempt._tag === "Undo" || (attempt._tag === "Step" && attempt.phase === "Finally")) &&
          failed(attempt.status),
      )
        ? runFlagged
        : finalOf[state.main];
      add(idle, expected);
      bad.push(
        ...finals.filter((fact) => fact !== expected),
        stepStarted(fresh),
        gateOpened(fresh),
        mainFailed("Run"),
        undoStarted(attempts[0]?.step ?? "s0", { item: itemOf(attempts[0]) }),
      );
      break;
    }
  }
  return { good, bad, misplaced };
};
