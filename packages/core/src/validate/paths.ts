import { Option, Result } from "effect";
import type { StepId } from "../ids";
import type { Outcome } from "../Recipe";
import type { ResolvedRecipe, ResolvedStep } from "./model";
import { isSuccess, outcomesOf } from "./model";

/**
 * How a main-path step ended on a path. A cancel takes effect only between steps (M1 decision
 * 17), so besides its block's outcomes a step can end in two ways: `CancelledWaiting` for a gate
 * that was cancelled while it waited, and `CancelledPartway` for a for-each whose running items
 * finished and whose remaining items never started (decision 19).
 */
export type MainOutcome = Outcome | "CancelledWaiting" | "CancelledPartway";
export type CleanupOutcome = "Succeeded" | "Failed";

/**
 * One thing a run did. A for-each step is one entry whatever its number of items, and so is the
 * undo of its succeeded items.
 */
export type PathEntry =
  | { readonly phase: "Main"; readonly step: StepId; readonly outcome: MainOutcome }
  | { readonly phase: "Undo"; readonly step: StepId; readonly outcome: CleanupOutcome }
  | { readonly phase: "Finally"; readonly step: StepId; readonly outcome: CleanupOutcome };

/** How the main phase ended. Only a failed end chooses whether the undo phase runs (decision 15). */
export type MainEnd =
  | { readonly result: "Succeeded" }
  | { readonly result: "Failed"; readonly undo: "Run" | "Skip" }
  | { readonly result: "Cancelled" };

export type RunResult = "Succeeded" | "Failed" | "Cancelled" | "NeedsAttention";

/** What one run could do: its main phase, its undo phase and its `finally` phase. */
export type Path = {
  readonly entries: ReadonlyArray<PathEntry>;
  readonly main: MainEnd;
  /** The main result, replaced by `NeedsAttention` if any undo or `finally` step failed. */
  readonly result: RunResult;
};

/** A path entry that still holds its step, so later stages need not look it up again. */
export type WalkedEntry =
  | { readonly phase: "Main"; readonly node: ResolvedStep; readonly outcome: MainOutcome }
  | {
      readonly phase: "Undo" | "Finally";
      readonly node: ResolvedStep;
      readonly outcome: CleanupOutcome;
    };

export type WalkedPath = {
  readonly entries: ReadonlyArray<WalkedEntry>;
  readonly main: MainEnd;
  readonly result: RunResult;
};

type MainEntry = Extract<WalkedEntry, { readonly phase: "Main" }>;
type MainPhase = { readonly entries: ReadonlyArray<MainEntry>; readonly main: MainEnd };
type Track = "Normal" | "Handling";

const cancelled: MainEnd = { result: "Cancelled" };

/**
 * Every way the main phase can go from `node` on. On the normal track each step has a
 * cancellation point before it, a gate has one while it waits and a for-each has one partway.
 * Once a `Failed` or `Denied` edge has been followed the run is being handled and has none
 * (decision 18).
 */
function* mainPhases(
  resolved: ResolvedRecipe,
  node: ResolvedStep,
  track: Track,
  entries: ReadonlyArray<MainEntry>,
): Generator<MainPhase> {
  if (track === "Normal") {
    yield { entries, main: cancelled };
    if (node.block.kind === "Gate") {
      yield {
        entries: [...entries, { phase: "Main", node, outcome: "CancelledWaiting" }],
        main: cancelled,
      };
    }
    if (Option.isSome(node.forEach)) {
      yield {
        entries: [...entries, { phase: "Main", node, outcome: "CancelledPartway" }],
        main: cancelled,
      };
    }
  }
  for (const outcome of outcomesOf(node.block.kind)) {
    const next: ReadonlyArray<MainEntry> = [...entries, { phase: "Main", node, outcome }];
    const target = resolved.edges.get(node.step.id)?.get(outcome);
    if (target === undefined) {
      const main: MainEnd = isSuccess(outcome)
        ? { result: "Succeeded" }
        : { result: "Failed", undo: "Run" };
      yield { entries: next, main };
    } else if (target._tag === "End") {
      const main: MainEnd =
        target.result === "Succeeded"
          ? { result: "Succeeded" }
          : { result: "Failed", undo: target.undo };
      yield { entries: next, main };
    } else {
      yield* mainPhases(resolved, target.step, isSuccess(outcome) ? track : "Handling", next);
    }
  }
}

/**
 * Whether the step's undo runs after it ended this way. A step is undone if it succeeded. A
 * for-each is undone per item (decision 16), so it has an undo entry however it ended: some of
 * its items may have succeeded before it failed or was cancelled partway.
 */
const isUndone = (entry: MainEntry): boolean =>
  Option.isSome(entry.node.undo) &&
  (entry.outcome === "Succeeded" || Option.isSome(entry.node.forEach));

type Cleanup = { readonly phase: "Undo" | "Finally"; readonly node: ResolvedStep };

/** The cleanups a main phase leaves owing: undo in reverse order unless skipped, then every `finally` step. */
const cleanupsAfter = (resolved: ResolvedRecipe, phase: MainPhase): ReadonlyArray<Cleanup> => {
  const undoRuns =
    phase.main.result === "Cancelled" ||
    (phase.main.result === "Failed" && phase.main.undo === "Run");
  const undone = undoRuns ? phase.entries.filter(isUndone).toReversed() : [];
  return [
    ...undone.map((entry): Cleanup => ({ phase: "Undo", node: entry.node })),
    ...resolved.finally.map((node): Cleanup => ({ phase: "Finally", node })),
  ];
};

/**
 * How the cleanups of one main phase are spread over paths.
 *
 * `OneFailure` (decision 25) gives one path on which every cleanup succeeds and one per cleanup
 * on which only that cleanup fails: n + 1 paths for n cleanups. `EveryCombination` gives each
 * cleanup both outcomes independently: 2^n paths. Every cleanup is attempted either way
 * (decision 3). The validator uses `OneFailure`; `EveryCombination` exists so a property test can
 * show that no invariant tells the two apart.
 */
export type CleanupOutcomes = "OneFailure" | "EveryCombination";

function* everyCombination(
  cleanups: ReadonlyArray<Cleanup>,
  done: ReadonlyArray<WalkedEntry>,
): Generator<ReadonlyArray<WalkedEntry>> {
  const [cleanup, ...rest] = cleanups;
  if (cleanup === undefined) {
    yield done;
  } else {
    yield* everyCombination(rest, [...done, { ...cleanup, outcome: "Succeeded" }]);
    yield* everyCombination(rest, [...done, { ...cleanup, outcome: "Failed" }]);
  }
}

function* oneFailure(cleanups: ReadonlyArray<Cleanup>): Generator<ReadonlyArray<WalkedEntry>> {
  yield cleanups.map((cleanup): WalkedEntry => ({ ...cleanup, outcome: "Succeeded" }));
  for (const failing of cleanups.keys()) {
    yield cleanups.map((cleanup, index): WalkedEntry => ({
      ...cleanup,
      outcome: index === failing ? "Failed" : "Succeeded",
    }));
  }
}

function* walk(resolved: ResolvedRecipe, outcomes: CleanupOutcomes): Generator<WalkedPath> {
  for (const phase of mainPhases(resolved, resolved.start, "Normal", [])) {
    const owed = cleanupsAfter(resolved, phase);
    for (const cleanups of outcomes === "OneFailure"
      ? oneFailure(owed)
      : everyCombination(owed, [])) {
      const failed = cleanups.some((entry) => entry.outcome === "Failed");
      yield {
        entries: [...phase.entries, ...cleanups],
        main: phase.main,
        result: failed ? "NeedsAttention" : phase.main.result,
      };
    }
  }
}

export type TooManyPaths = { readonly _tag: "TooManyPaths"; readonly cap: number };

/**
 * Stage 6 of validation: every path through the recipe, in all three phases. The walk is lazy
 * and counts as it goes, so it stops as soon as there are more than `cap` paths: the cap bounds
 * the work itself. Only for a graph with no cycle.
 */
export const enumeratePaths = (
  resolved: ResolvedRecipe,
  cap: number,
  outcomes: CleanupOutcomes = "OneFailure",
): Result.Result<ReadonlyArray<WalkedPath>, TooManyPaths> => {
  const paths: Array<WalkedPath> = [];
  for (const path of walk(resolved, outcomes)) {
    if (paths.length >= cap) {
      return Result.fail({ _tag: "TooManyPaths", cap });
    }
    paths.push(path);
  }
  return Result.succeed(paths);
};

const toEntry = (entry: WalkedEntry): PathEntry => {
  const step = entry.node.step.id;
  switch (entry.phase) {
    case "Main": {
      return { phase: "Main", step, outcome: entry.outcome };
    }
    case "Undo": {
      return { phase: "Undo", step, outcome: entry.outcome };
    }
    case "Finally": {
      return { phase: "Finally", step, outcome: entry.outcome };
    }
  }
};

/** The path as data, with its steps named by id. */
export const toPath = (walked: WalkedPath): Path => ({
  entries: walked.entries.map(toEntry),
  main: walked.main,
  result: walked.result,
});
