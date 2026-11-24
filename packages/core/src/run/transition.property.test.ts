import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";
import type { RunEvent, RunState } from "../index";
import {
  failedCleanups,
  notStarted,
  RejectionReason,
  replay,
  RunState as States,
  transition,
} from "../index";
import { candidates, eventAt, showLog, TracePicks } from "../testing/events";
import { brokenRunInvariants, stateTagOf } from "../testing/runInvariants";

/**
 * `transition` against event sequences guided by the state (M1 decision 13). At each step the
 * state's candidates are listed, good and bad, and the next two numbers pick one: a good one
 * eleven times in sixteen, a bad one four times, and no event at all once. A good one must be
 * accepted and a bad one rejected. After every accepted event the whole log is checked against
 * the run invariants, by code that reads the log and no state.
 *
 * A property can pass without reaching what matters, so the tests after it fail if any state,
 * track, event, rejection or situation was never reached.
 */

// The rarest rejection and the rarest situation are each reached about fifteen times in a
// thousand runs, so the coverage tests below do not fail by chance.
const runs = { arbitrary: { runs: 1000, maxShrinks: 0 } };

const seen = {
  states: new Set<string>(),
  tracks: new Set<string>(),
  accepted: new Set<string>(),
  rejected: new Set<string>(),
  situations: new Set<string>(),
};

const seqAfter = (state: RunState): number => (state._tag === "NotStarted" ? 0 : state.run.seq + 1);

/** What an accepted event shows was reached, beyond its own tag. */
const note = (before: RunState, event: RunEvent, after: RunState): void => {
  seen.states.add(after._tag);
  seen.accepted.add(event._tag);
  if (after._tag === "Running" || after._tag === "WaitingForApproval") {
    seen.tracks.add(after.track);
  }
  if (before._tag === "NotStarted" || after._tag === "NotStarted") {
    return;
  }
  const cleanupStarts =
    event._tag === "UndoStarted" || (event._tag === "StepStarted" && event.phase === "Finally");
  const mark = (reached: boolean, situation: string): void => {
    if (reached) {
      seen.situations.add(situation);
    }
  };
  mark(cleanupStarts && failedCleanups(before.run).length > 0, "a cleanup after a failed cleanup");
  mark(event._tag === "UndoStarted" && event.attempt > 1, "an undo retried");
  mark(event._tag === "UndoStarted" && event.item !== undefined, "an item undone");
  mark(event._tag === "StepStarted" && event.attempt > 1, "a step retried");
  mark(
    before._tag === "Running" &&
      before.track === "CancelRequested" &&
      after._tag !== "Compensating" &&
      (event._tag === "StepStarted" || event._tag === "GateOpened"),
    "a failure handler after a cancel request",
  );
  mark(
    before._tag === "WaitingForApproval" && event._tag === "MainPhaseEnded",
    "a gate cancelled while it waited",
  );
  mark(
    before._tag === "Compensating" && event._tag !== "UndoStarted" && after._tag === "Finalizing",
    "finally after undo",
  );
  mark(
    event._tag === "MainPhaseEnded" && event.main.result === "Failed" && event.main.undo === "Skip",
    "a failed end that skips undo",
  );
  mark(
    event._tag === "RunFlaggedForAttention" && before._tag === "Compensating",
    "flagged with no finally step",
  );
};

/**
 * Plays one sequence and says what went wrong first, if anything did. `observe` records what was
 * reached; it is off while a failing sequence is being made shorter.
 */
const play = (picks: ReadonlyArray<number>, observe: boolean): string | undefined => {
  let state = notStarted;
  const log: Array<RunEvent> = [];
  for (let cursor = 0; cursor + 1 < picks.length; cursor += 2) {
    const { bad, good, misplaced } = candidates(state);
    const kind = (picks[cursor] ?? 0) % 16;
    // A turn with no event, so that a failing sequence can be made shorter by dropping a turn
    // without moving the numbers of the turns after it.
    if (kind === 0) {
      continue;
    }
    const takeBad = good.length === 0 || kind >= 12;
    const from = takeBad ? (kind === 15 && misplaced.length > 0 ? misplaced : bad) : good;
    const fact = from[(picks[cursor + 1] ?? 0) % from.length] ?? {};
    const event = eventAt(seqAfter(state), fact);
    const result = transition(state, event);
    const trace = `in ${state._tag}, after ${showLog(log)}: ${showLog([event])}`;
    if (takeBad) {
      if (Result.isSuccess(result)) {
        return `accepted ${trace}`;
      }
      const { reason, ...rest } = result.failure;
      const expected = {
        _tag: "EventRejected",
        state: state._tag,
        event: event._tag,
        seq: event.seq,
      };
      if (JSON.stringify(rest) !== JSON.stringify(expected)) {
        return `rejected with ${JSON.stringify(rest)} ${trace}`;
      }
      if (observe) {
        seen.rejected.add(reason);
      }
      if (good.length === 0) {
        break;
      }
    } else {
      if (Result.isFailure(result)) {
        return `rejected (${result.failure.reason}) ${trace}`;
      }
      const after = result.success;
      log.push(event);
      if (after._tag !== stateTagOf(log) || after._tag === "NotStarted") {
        return `led to ${after._tag}, not ${stateTagOf(log)} ${trace}`;
      }
      if (after.run.seq !== event.seq) {
        return `recorded seq ${after.run.seq} ${trace}`;
      }
      if (observe) {
        note(state, event, after);
      }
      state = after;
    }
  }
  // One pass over the log checks every event against the events before it, so this is the
  // invariants after every event, at the cost of one pass and not one per event.
  const broken = brokenRunInvariants(log);
  if (broken.length > 0) {
    return `${broken.join("; ")}, in ${showLog(log)}`;
  }
  return JSON.stringify(replay(log)) === JSON.stringify(Result.succeed(state))
    ? undefined
    : `replay disagrees after ${showLog(log)}`;
};

/**
 * A failing sequence with every turn dropped that the failure does not need. The generator's own
 * shrinking changes one number at a time, and a step's start and its end are two turns, so it
 * cannot drop a step; this drops up to three turns at once.
 */
const shortest = (picks: ReadonlyArray<number>): string | undefined => {
  let best = picks;
  for (let changed = true; changed;) {
    changed = false;
    for (const width of [3, 2, 1]) {
      for (let turn = 0; turn + width <= best.length / 2; turn += 1) {
        const dropped = best.map((pick, index) =>
          index % 2 === 0 && index >= turn * 2 && index < (turn + width) * 2 ? 0 : pick,
        );
        if (
          dropped.some((pick, index) => pick !== best[index]) &&
          play(dropped, false) !== undefined
        ) {
          best = dropped;
          changed = true;
        }
      }
    }
  }
  return play(best, false);
};

describe("transition, over guided event sequences", () => {
  it.prop(
    "accepts what could arrive, rejects what could not, and keeps every run invariant",
    [TracePicks],
    ([picks]) => {
      const failure = play(picks, true) === undefined ? undefined : shortest(picks);
      expect(failure, failure).toBeUndefined();
    },
    runs,
  );

  it("reached every state and every track", () => {
    expect([...seen.states].toSorted()).toEqual(
      Object.keys(States.cases)
        .filter((tag) => tag !== "NotStarted")
        .toSorted(),
    );
    expect([...seen.tracks].toSorted()).toEqual(["CancelRequested", "Handling", "Normal"]);
  });

  it("accepted every kind of event and gave every reason for a rejection", () => {
    expect([...seen.accepted].toSorted()).toEqual(
      [
        "RunStarted",
        "StepStarted",
        "StepSucceeded",
        "StepFailed",
        "GateOpened",
        "ApprovalGranted",
        "ApprovalDenied",
        "CancellationRequested",
        "MainPhaseEnded",
        "UndoStarted",
        "UndoSucceeded",
        "UndoFailed",
        "RunSucceeded",
        "RunFailed",
        "RunCancelled",
        "RunFlaggedForAttention",
      ].toSorted(),
    );
    expect([...seen.rejected].toSorted()).toEqual([...RejectionReason.literals].toSorted());
  });

  it("reached the situations the invariants are about", () => {
    expect([...seen.situations].toSorted()).toEqual([
      "a cleanup after a failed cleanup",
      "a failed end that skips undo",
      "a failure handler after a cancel request",
      "a gate cancelled while it waited",
      "a step retried",
      "an item undone",
      "an undo retried",
      "finally after undo",
      "flagged with no finally step",
    ]);
  });
});
