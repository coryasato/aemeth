import { describe, expect, it } from "@effect/vitest";
import { Option, Result } from "effect";
import type { RunEvent } from "../index";
import { followsRecipe } from "../index";
import { showLog } from "../testing/events";
import { generate, generatedCatalog, Picks } from "../testing/generate";
import type { Played } from "../testing/play";
import { planOf, play, scriptFrom, scriptOf, shapeOf } from "../testing/play";
import { brokenRunInvariants } from "../testing/runInvariants";
import { picker, ValuePicks } from "../testing/values";

/**
 * `decide` played against scripts over generated recipes (M2 B2). The player does only what
 * `decide` says, so three things are checked of every run: `transition` accepts every event,
 * the finished log keeps the run invariants, and `followsRecipe`, which never calls `decide`,
 * finds that the log follows the recipe along one of the validator's paths.
 *
 * The first property takes every enumerated path of every generated recipe, with the script that
 * follows it, and must arrive at exactly that path. The second lets anything happen: retries,
 * lists of any length, a cancel at any moment, several cleanups failing.
 */

// Ten times the paths of any generated recipe: the most in 5,000 of them was 98. A mutant that
// makes the walk run away is then found by the first recipe, not after every one of ten thousand
// paths has been played.
const pathCap = 1000;

const logOf = (played: Played): string => showLog(played.log);

/** A finished run's log, or a failure that says where the run stuck. */
const finished = (played: Played): ReadonlyArray<RunEvent> => {
  expect(played._tag === "Stuck" ? `${played.why}, after ${logOf(played)}` : "Finished").toBe(
    "Finished",
  );
  return played.log;
};

describe("decide, played against scripted outcomes", () => {
  const seen = { recipes: 0, paths: 0, results: new Set<string>(), outcomes: new Set<string>() };

  it.prop(
    "takes every path the validator enumerates, and ends in that path's result",
    [Picks],
    ([picks]) => {
      const valid = planOf(
        generate(picks, { cycle: false, maxNodes: 5 }).recipe,
        generatedCatalog,
        pathCap,
      );
      seen.recipes += 1;
      for (const path of valid.paths) {
        const played = play(valid, scriptOf(valid, path));
        const log = finished(played);
        expect(brokenRunInvariants(log)).toEqual([]);
        expect(followsRecipe(valid, log), logOf(played)).toEqual(Result.succeed(Option.some(path)));
        expect(played._tag === "Finished" && played.state._tag).toBe(path.result);
        seen.paths += 1;
        seen.results.add(path.result);
        for (const entry of path.entries) {
          seen.outcomes.add(`${entry.phase} ${entry.outcome}`);
        }
      }
    },
    { arbitrary: { runs: 60, maxShrinks: 0 } },
  );

  it("reached every result and every way a step, an undo and a finally step can end", () => {
    expect(seen.paths).toBeGreaterThan(seen.recipes * 5);
    expect([...seen.results].toSorted()).toEqual([
      "Cancelled",
      "Failed",
      "NeedsAttention",
      "Succeeded",
    ]);
    expect([...seen.outcomes].toSorted()).toEqual([
      "Finally Failed",
      "Finally Succeeded",
      "Main Approved",
      "Main CancelledPartway",
      "Main CancelledWaiting",
      "Main Denied",
      "Main Failed",
      "Main Succeeded",
      "Undo Failed",
      "Undo Succeeded",
    ]);
  });

  const situations = new Map<string, number>();

  it.prop(
    "follows the recipe whatever the script does",
    [Picks, ValuePicks],
    ([picks, scriptPicks]) => {
      const valid = planOf(generate(picks).recipe, generatedCatalog, pathCap);
      const played = play(valid, scriptFrom(valid, picker(scriptPicks)));
      const log = finished(played);
      expect(brokenRunInvariants(log)).toEqual([]);
      const followed = followsRecipe(valid, log);
      const path = Result.isSuccess(followed) ? Option.getOrUndefined(followed.success) : undefined;
      expect(path === undefined ? followed : "followed", logOf(played)).toBe("followed");
      if (path === undefined || played._tag !== "Finished") {
        return;
      }
      // The path is one of the validator's, however the cleanups went.
      expect(valid.paths.map(shapeOf), logOf(played)).toContain(shapeOf(path));
      expect(played.state._tag).toBe(path.result);

      const mark = (reached: boolean, situation: string): void => {
        if (reached) {
          situations.set(situation, (situations.get(situation) ?? 0) + 1);
        }
      };
      const main = log.find((event) => event._tag === "MainPhaseEnded");
      const cancelAt = log.findIndex((event) => event._tag === "CancellationRequested");
      const mainStartAfterCancel = log.some(
        (event, index) =>
          cancelAt !== -1 &&
          index > cancelAt &&
          (event._tag === "GateOpened" || (event._tag === "StepStarted" && event.phase === "Main")),
      );
      const failedCleanups = path.entries.filter(
        (entry) => entry.phase !== "Main" && entry.outcome === "Failed",
      );
      mark(true, `ended ${played.state._tag}`);
      mark(
        log.some((event) => event._tag === "StepStarted" && event.attempt > 1),
        "a step retried",
      );
      mark(
        log.some((event) => event._tag === "StepStarted" && event.attempt === 3) &&
          log.some((event) => event._tag === "StepFailed" && event.attempt === 3),
        "a last attempt failed",
      );
      mark(
        log.some((event) => event._tag === "UndoStarted" && event.attempt > 1),
        "an undo retried",
      );
      mark(
        log.some((event) => event._tag === "UndoStarted" && event.item !== undefined),
        "an item undone",
      );
      mark(
        path.entries.some((entry) => entry.outcome === "CancelledWaiting"),
        "a gate cancelled while it waited",
      );
      mark(
        path.entries.some((entry) => entry.outcome === "CancelledPartway"),
        "a for-each cut short",
      );
      mark(
        main?._tag === "MainPhaseEnded" &&
          main.main.result === "Cancelled" &&
          log.some(
            (event, index) =>
              event._tag === "StepFailed" && event.retryable && log[index + 1] === main,
          ),
        "a retry forestalled by a cancel",
      );
      mark(
        mainStartAfterCancel && main?._tag === "MainPhaseEnded" && main.main.result === "Failed",
        "a failure handler after a cancel request",
      );
      mark(
        cancelAt !== -1 && main?._tag === "MainPhaseEnded" && main.main.result === "Succeeded",
        "a cancel that came too late",
      );
      mark(
        main?._tag === "MainPhaseEnded" &&
          main.main.result === "Failed" &&
          main.main.undo === "Skip",
        "a failed end that skips undo",
      );
      mark(failedCleanups.length > 1, "several cleanups failed");
      mark(
        path.entries.some(
          (entry) =>
            entry.phase === "Main" &&
            entry.outcome === "Succeeded" &&
            !log.some((event) => event._tag === "StepStarted" && event.step === entry.step),
        ),
        "a for-each over an empty list passed",
      );
      mark(
        log.filter((event) => event._tag === "StepStarted" && event.attempt === 1).length >
          new Set(log.flatMap((event) => (event._tag === "StepStarted" ? [event.step] : []))).size +
            4,
        "a for-each run in more than one batch",
      );
    },
    { arbitrary: { runs: 1500, maxShrinks: 0 } },
  );

  it("reached the situations that matter", () => {
    // The rarest of these (a retry forestalled by a cancel, a for-each cut short) were each
    // reached fifteen to twenty times in 1,500 runs when the test was written.
    expect([...situations.keys()].toSorted()).toEqual([
      "a cancel that came too late",
      "a failed end that skips undo",
      "a failure handler after a cancel request",
      "a for-each cut short",
      "a for-each over an empty list passed",
      "a for-each run in more than one batch",
      "a gate cancelled while it waited",
      "a last attempt failed",
      "a retry forestalled by a cancel",
      "a step retried",
      "an item undone",
      "an undo retried",
      "ended Cancelled",
      "ended Failed",
      "ended NeedsAttention",
      "ended Succeeded",
      "several cleanups failed",
    ]);
  });
});
