import { Result, Schema } from "effect";
import type { BlockSpec } from "../BlockSpec";
import type { DataType } from "../DataType";
import { namesOf } from "../ids";
import type { Recipe } from "../Recipe";
import type { Decision, RunEvent, RunState, Work } from "../run/index";
import {
  decide,
  notStarted,
  RunEvent as RunEventSchema,
  sizeOf,
  transition,
  valuesOf,
} from "../run/index";
import type { Path, ResolvedStep, ValidRecipe } from "../validate/index";
import { limits } from "../validate/model";
import { enumeratePaths, toPath } from "../validate/paths";
import { checkStructure } from "../validate/structure";
import type { Json, Parts } from "./build";

// A run played in memory, for the property test of `decide` (M2 B2): the player does what
// `decide` says and nothing else, a script says how each piece of work turns out, and every event
// goes through `transition`. It is the engine's loop with no engine.

/**
 * A recipe with its names looked up and its paths enumerated, whatever its invariants say: the
 * generated recipes break some on purpose, and a run does not depend on them. Throws past `cap`
 * paths, so that a property test fails at once on a walk gone wrong and does not play every path
 * of it.
 *
 * Nothing is worked out until it is first read. A test file may then name its recipes where it
 * is loaded and still do the work inside its tests: otherwise the mutation run could not tell
 * which test covers a mutant of the validator, and would run every test for each of them.
 */
export const planOf = (
  recipe: Recipe,
  blocks: ReadonlyArray<BlockSpec>,
  cap = limits.paths,
): ValidRecipe => {
  let made: Pick<ValidRecipe, "resolved" | "paths"> | undefined;
  const make = () => {
    const resolved = Result.getOrThrow(checkStructure(recipe, blocks));
    const paths = Result.getOrThrow(enumeratePaths(resolved, cap));
    return { resolved, paths: paths.map(toPath) };
  };
  const plan = () => (made ??= make());
  return {
    recipe,
    get resolved() {
      return plan().resolved;
    },
    get paths() {
      return plan().paths;
    },
  };
};

/** A value of the type, with `length` items in every list. */
export const exampleOf = (type: DataType, length: number): Json => {
  switch (type._tag) {
    case "Text": {
      return "text";
    }
    case "Integer":
    case "Duration":
    case "Timestamp": {
      return 7;
    }
    case "Boolean": {
      return true;
    }
    case "Resource": {
      return { kind: type.kind, id: "id-1" };
    }
    case "List": {
      return Array.from({ length }, () => exampleOf(type.item, length));
    }
    case "Struct": {
      return Object.fromEntries(
        namesOf(type.fields).map(([name, field]) => [name, exampleOf(field, length)]),
      );
    }
  }
};

/** Inputs for a run of the recipe, with `length` items in every list. */
export const exampleInputs = (recipe: Recipe, length: number): Parts =>
  Object.fromEntries(
    namesOf(recipe.inputs).map(([name, input]) => [name, exampleOf(input.type, length)]),
  );

export type WorkOutcome = "Succeeded" | "FailedRetryable" | "Failed";
export type GateOutcome = "Approved" | "Denied" | "CancelledWaiting";
type Place = { readonly step: string; readonly item: number | undefined; readonly attempt: number };

/** How a run goes: its inputs, how each piece of work turns out, and when it is cancelled. */
export type Script = {
  readonly inputs: Parts;
  /** How many items a step's list outputs hold. */
  readonly length: number;
  readonly step: (phase: "Main" | "Finally", at: Place) => WorkOutcome;
  readonly gate: (step: string) => GateOutcome;
  readonly undo: (at: Place) => WorkOutcome;
  /**
   * Whether a cancel is requested here: before what `decide` has just said is done, or, for work,
   * while it is in flight. Asked once before every decision is acted on, and once more while work
   * is in flight.
   */
  readonly cancel: (at: {
    readonly turn: number;
    readonly decision: Decision;
    readonly inFlight: boolean;
  }) => boolean;
};

/** The attempts a step is given before its failure is final (M2 decision 9). */
export const maxAttempts = 3;

export type Played =
  | { readonly _tag: "Finished"; readonly log: ReadonlyArray<RunEvent>; readonly state: RunState }
  | { readonly _tag: "Stuck"; readonly log: ReadonlyArray<RunEvent>; readonly why: string };

const decodeEvent = Schema.decodeUnknownSync(RunEventSchema, { onExcessProperty: "error" });
const runId = "run1";
const by = "ada@example.com";
const error = { name: "Broke", message: "It broke." };

const placeOf = (step: ResolvedStep, work: Work) =>
  work.item === undefined
    ? { step: step.step.id, attempt: work.attempt }
    : { step: step.step.id, item: work.item, attempt: work.attempt };
const keyOf = (step: ResolvedStep, phase: string, work: Work): string =>
  work.item === undefined
    ? `${runId}:${step.step.id}:${phase}`
    : `${runId}:${step.step.id}:${phase}:${work.item}`;
const outputsOf = (block: BlockSpec, length: number): Parts =>
  Object.fromEntries(namesOf(block.outputs).map(([name, type]) => [name, exampleOf(type, length)]));

const failure = (outcome: WorkOutcome, attempt: number) => ({
  error,
  // The failure of the last attempt allowed is final, whatever the block said.
  retryable: outcome === "FailedRetryable" && attempt < maxAttempts,
});

/**
 * Plays a run of the recipe to its end. `Stuck` if `transition` rejects an event `decide` led to,
 * if `decide` waits for something the player never leaves waiting, or if the run does not end
 * within `turns` decisions.
 */
export const play = (
  valid: ValidRecipe,
  script: Script,
  choose: typeof decide = decide,
  turns = 400,
): Played => {
  const log: Array<RunEvent> = [];
  let state: RunState = notStarted;
  let stuck: string | undefined;

  const append = (fact: Parts): void => {
    if (stuck !== undefined) {
      return;
    }
    const event = decodeEvent({
      eventSchemaVersion: 1,
      runId,
      seq: log.length,
      at: 1_795_000_000_000 + log.length,
      recipe: { id: valid.recipe.id, version: valid.recipe.version },
      ...fact,
    });
    const next = transition(state, event);
    if (Result.isFailure(next)) {
      stuck = `${next.failure.reason}: ${event._tag} in ${state._tag} at seq ${event.seq}`;
    } else {
      log.push(event);
      state = next.success;
    }
  };
  const cancel = (): void => append({ _tag: "CancellationRequested", by });
  append({ _tag: "RunStarted", inputs: script.inputs });
  for (let turn = 0; turn < turns && stuck === undefined; turn += 1) {
    const values = valuesOf(log);
    const decision = choose(valid, state, (step) => sizeOf(valid.resolved, step, values));
    if (script.cancel({ turn, decision, inFlight: false })) {
      cancel();
      continue;
    }
    switch (decision._tag) {
      case "RunSteps": {
        const { phase, step, work } = decision;
        // Every start first, then every end: the items of a for-each run side by side.
        for (const one of work) {
          append({
            _tag: "StepStarted",
            phase,
            ...placeOf(step, one),
            idempotencyKey: keyOf(step, "Forward", one),
          });
        }
        if (script.cancel({ turn, decision, inFlight: true })) {
          cancel();
        }
        for (const one of work) {
          const at = { step: step.step.id, item: one.item, attempt: one.attempt };
          const outcome = script.step(phase, at);
          append(
            outcome === "Succeeded"
              ? {
                  _tag: "StepSucceeded",
                  ...placeOf(step, one),
                  outputs: outputsOf(step.block, script.length),
                }
              : { _tag: "StepFailed", ...placeOf(step, one), ...failure(outcome, one.attempt) },
          );
        }
        break;
      }
      case "OpenGate": {
        append({ _tag: "GateOpened", step: decision.step.step.id, attempt: 1 });
        break;
      }
      case "AwaitGate": {
        const step = decision.step.step.id;
        const outcome = script.gate(step);
        if (outcome === "CancelledWaiting") {
          cancel();
        } else if (outcome === "Approved") {
          const outputs = outputsOf(decision.step.block, script.length);
          append({ _tag: "ApprovalGranted", step, attempt: 1, by, outputs });
        } else {
          append({ _tag: "ApprovalDenied", step, attempt: 1, by });
        }
        break;
      }
      case "EndMainPhase": {
        append({ _tag: "MainPhaseEnded", main: decision.main });
        break;
      }
      case "RunUndo": {
        const { step, work } = decision;
        const at = { step: step.step.id, item: work.item, attempt: work.attempt };
        append({
          _tag: "UndoStarted",
          ...placeOf(step, work),
          idempotencyKey: keyOf(step, "Undo", work),
        });
        const outcome = script.undo(at);
        append(
          outcome === "Succeeded"
            ? { _tag: "UndoSucceeded", ...placeOf(step, work) }
            : { _tag: "UndoFailed", ...placeOf(step, work), ...failure(outcome, work.attempt) },
        );
        break;
      }
      case "EndRun": {
        append({ _tag: decision.event });
        return stuck === undefined
          ? { _tag: "Finished", log, state }
          : { _tag: "Stuck", log, why: stuck };
      }
      case "AwaitStart":
      case "AwaitWork":
      case "Ended": {
        stuck = `decide said ${decision._tag} in ${state._tag}`;
        break;
      }
    }
  }
  return { _tag: "Stuck", log, why: stuck ?? `no end within ${turns} decisions` };
};

const never = (): boolean => false;

/** Whether the decision begins a main-path step: its gate, or its first piece of work. */
const begins = (decision: Decision): boolean =>
  decision._tag === "OpenGate" ||
  (decision._tag === "RunSteps" &&
    decision.phase === "Main" &&
    decision.work.some((work) => (work.item ?? 0) === 0));

/**
 * The script that takes one of the validator's paths: each step ends as its entry says, a cancel
 * is requested where the path is cut, and each cleanup that fails on the path fails. Every list
 * has five items, one more than run side by side, so that a for-each can be cancelled partway.
 */
export const scriptOf = (valid: ValidRecipe, path: Path): Script => {
  const length = 5;
  const outcomeOf = (phase: "Main" | "Undo" | "Finally", step: string) =>
    path.entries.find((entry) => entry.phase === phase && entry.step === step)?.outcome;
  const mainSteps = path.entries.filter((entry) => entry.phase === "Main").length;
  /** A step that fails does so on its first item, and for good. */
  const failing = (phase: "Main" | "Finally", at: Place): WorkOutcome =>
    outcomeOf(phase, at.step) === "Failed" && (at.item ?? 0) === 0 ? "Failed" : "Succeeded";
  /** An undo that fails does so on the first item it is asked to undo, and for good. */
  const undoFailed = new Set<string>();
  const undoing = (at: Place): WorkOutcome => {
    if (outcomeOf("Undo", at.step) !== "Failed" || undoFailed.has(at.step)) {
      return "Succeeded";
    }
    undoFailed.add(at.step);
    return "Failed";
  };
  let started = 0;
  return {
    inputs: exampleInputs(valid.recipe, length),
    length,
    step: (phase, at) => failing(phase, at),
    gate: (step) => {
      const outcome = outcomeOf("Main", step);
      return outcome === "Denied" || outcome === "CancelledWaiting" ? outcome : "Approved";
    },
    undo: undoing,
    cancel:
      path.main.result === "Cancelled"
        ? ({ decision, inFlight }) => {
            if (inFlight) {
              return false;
            }
            // Partway: before the second batch of a for-each that the path cuts short.
            if (
              decision._tag === "RunSteps" &&
              decision.phase === "Main" &&
              outcomeOf("Main", decision.step.step.id) === "CancelledPartway" &&
              !begins(decision)
            ) {
              return true;
            }
            // Between steps: before the step after the path's last, counting each step once.
            if (!begins(decision)) {
              return false;
            }
            started += 1;
            return started > mainSteps;
          }
        : never,
  };
};

/**
 * A script from a list of numbers: lists of zero to six items, work that succeeds six times in
 * ten and otherwise fails, for good or not, gates that are mostly approved, and at most one
 * cancel, before a decision or while work is in flight.
 */
export const scriptFrom = (valid: ValidRecipe, next: (choices: number) => number): Script => {
  const length = next(7);
  const cancelTurn = next(2) === 0 ? -1 : next(8);
  const cancelInFlight = next(2) === 0;
  const work = (): WorkOutcome => {
    const pick = next(10);
    return pick < 6 ? "Succeeded" : pick < 8 ? "FailedRetryable" : "Failed";
  };
  return {
    inputs: exampleInputs(valid.recipe, length),
    length,
    step: work,
    gate: () => {
      const pick = next(10);
      return pick < 6 ? "Approved" : pick < 9 ? "Denied" : "CancelledWaiting";
    },
    undo: work,
    cancel: ({ decision, inFlight, turn }) =>
      turn === cancelTurn && inFlight === (cancelInFlight && decision._tag === "RunSteps"),
  };
};

/** Whether the log has this fact's tag, for coverage. */
export const has = (log: ReadonlyArray<RunEvent>, tag: RunEvent["_tag"]): boolean =>
  log.some((event) => event._tag === tag);

/** The path with every cleanup's outcome set aside: what a run can match however its cleanups went. */
export const shapeOf = (path: Path): string =>
  JSON.stringify({
    entries: path.entries.map((entry) =>
      entry.phase === "Main" ? entry : { phase: entry.phase, step: entry.step },
    ),
    main: path.main,
  });
