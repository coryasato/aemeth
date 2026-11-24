import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";
import { failedCleanups, notStarted, replay, transition } from "../index";
import type { Parts } from "../testing/build";
import {
  approved,
  cancelRequested,
  denied,
  eventAt,
  finallyStarted,
  gateOpened,
  logOf,
  mainCancelled,
  mainFailed,
  mainSucceeded,
  runCancelled,
  runFailed,
  runFlagged,
  runStarted,
  runSucceeded,
  stateAfter,
  stepFailed,
  stepStarted,
  stepSucceeded,
  undoFailed,
  undoStarted,
  undoSucceeded,
} from "../testing/events";

type Facts = ReadonlyArray<Parts>;

/** After `facts`, what `fact` leads to: the next state's tag, or the reason it was rejected. */
const verdict = (facts: Facts, fact: Parts): string => {
  const result = transition(stateAfter(facts), eventAt(facts.length, fact));
  return Result.isFailure(result) ? result.failure.reason : result.success._tag;
};

/** The attempts a run has recorded, as `kind step#item @attempt status`. */
const attempts = (facts: Facts): ReadonlyArray<string> => {
  const state = stateAfter(facts);
  return state._tag === "NotStarted"
    ? []
    : state.run.attempts.map((attempt) => {
        const kind = attempt._tag === "Step" ? attempt.phase : attempt._tag;
        const item =
          attempt._tag === "Gate" || attempt.item === undefined ? "" : `#${attempt.item}`;
        return `${kind} ${attempt.step}${item} @${attempt.attempt} ${attempt.status}`;
      });
};

/** What the run has recorded, or nothing before it starts. */
const runOf = (facts: Facts) => {
  const state = stateAfter(facts);
  return state._tag === "NotStarted" ? undefined : state.run;
};

const trackOf = (facts: Facts): string => {
  const state = stateAfter(facts);
  return state._tag === "Running" || state._tag === "WaitingForApproval" ? state.track : "none";
};

const run = { runId: "run1", recipe: { id: "test", version: 1 } };

/** A step that ran and succeeded, or failed. */
const ok = (step: string, item?: number): Facts => [
  stepStarted(step, { item }),
  stepSucceeded(step, { item }),
];
const fails = (step: string, retryable = false): Facts => [
  stepStarted(step),
  stepFailed(step, {}, retryable),
];

const started: Facts = [runStarted];
const aOpen: Facts = [runStarted, stepStarted("a")];
const waiting: Facts = [runStarted, gateOpened("g")];
/** Two steps succeeded, then the main phase failed: `a` and `b` are there to undo. */
const compensating: Facts = [runStarted, ...ok("a"), ...ok("b"), mainFailed("Run")];
const finalizing: Facts = [runStarted, ...ok("a"), mainSucceeded];
const ended: Facts = [runStarted, mainSucceeded, runSucceeded];

describe("transition", () => {
  describe("the first event", () => {
    it("starts the run on the normal track, with nothing attempted", () => {
      expect(transition(notStarted, eventAt(0, runStarted))).toEqual(
        Result.succeed({ _tag: "Running", run: { ...run, seq: 0, attempts: [] }, track: "Normal" }),
      );
    });

    it.each([cancelRequested, stepStarted("a"), mainSucceeded, runSucceeded])(
      "must be RunStarted: %j",
      (fact) => {
        expect(verdict([], fact)).toBe("RunNotStarted");
      },
    );

    it("has seq 0", () => {
      expect(verdict([], { ...runStarted, seq: 1 })).toBe("OutOfSequence");
    });
  });

  describe("every later event", () => {
    it("is rejected as a value that names the state, the event and why", () => {
      expect(transition(stateAfter(aOpen), eventAt(2, mainSucceeded))).toEqual(
        Result.fail({
          _tag: "EventRejected",
          reason: "AttemptsOpen",
          state: "Running",
          event: "MainPhaseEnded",
          seq: 2,
        }),
      );
    });

    it.each([
      ["skips a seq", { seq: 3 }, "OutOfSequence"],
      ["repeats a seq", { seq: 1 }, "OutOfSequence"],
      ["goes back to seq 0", { seq: 0 }, "OutOfSequence"],
      ["belongs to another run", { runId: "run2" }, "DifferentRun"],
      ["names another recipe", { recipe: { id: "other", version: 1 } }, "RecipeChanged"],
      ["names another version", { recipe: { id: "test", version: 2 } }, "RecipeChanged"],
    ])("is rejected when it %s", (_, envelope, reason) => {
      expect(verdict(aOpen, { ...cancelRequested, ...envelope })).toBe(reason);
    });

    it("is not RunStarted again, whatever seq the repeat carries", () => {
      expect(verdict(started, runStarted)).toBe("RunAlreadyStarted");
      expect(verdict(aOpen, { ...runStarted, seq: 0 })).toBe("RunAlreadyStarted");
      expect(verdict(aOpen, { ...runStarted, seq: 9 })).toBe("RunAlreadyStarted");
      expect(verdict(aOpen, { ...runStarted, runId: "run2" })).toBe("DifferentRun");
      expect(verdict(aOpen, { ...runStarted, recipe: { id: "test", version: 2 } })).toBe(
        "RecipeChanged",
      );
      expect(verdict(finalizing, runStarted)).toBe("RunAlreadyStarted");
    });

    it("records its seq", () => {
      expect(stateAfter([...aOpen, cancelRequested])).toMatchObject({ run: { ...run, seq: 2 } });
    });
  });

  describe("a final state", () => {
    it.each([
      ["Succeeded", [runStarted, mainSucceeded, runSucceeded]],
      ["Failed", [runStarted, mainFailed("Skip"), runFailed]],
      ["Cancelled", [runStarted, cancelRequested, mainCancelled, runCancelled]],
      [
        "NeedsAttention",
        [runStarted, mainSucceeded, finallyStarted("f"), stepFailed("f"), runFlagged],
      ],
    ])("%s accepts nothing", (tag, facts) => {
      expect(stateAfter(facts)._tag).toBe(tag);
      for (const fact of [cancelRequested, runStarted, stepStarted("z"), runSucceeded]) {
        expect(verdict(facts, fact)).toBe("RunAlreadyEnded");
      }
      expect(verdict(facts, { ...cancelRequested, runId: "run2" })).toBe("RunAlreadyEnded");
    });
  });

  describe("a main-phase step", () => {
    it("starts when nothing is in flight", () => {
      expect(stateAfter(aOpen)).toEqual({
        _tag: "Running",
        run: {
          ...run,
          seq: 1,
          attempts: [{ _tag: "Step", phase: "Main", step: "a", attempt: 1, status: "Open" }],
        },
        track: "Normal",
      });
    });

    it("has no item key at all when it is not a for-each", () => {
      expect(runOf(aOpen)?.attempts).toStrictEqual([
        { _tag: "Step", phase: "Main", step: "a", attempt: 1, status: "Open" },
      ]);
    });

    it("records its item when it is a for-each", () => {
      expect(stateAfter([runStarted, stepStarted("a", { item: 2 })])).toMatchObject({
        run: {
          attempts: [
            { _tag: "Step", phase: "Main", step: "a", item: 2, attempt: 1, status: "Open" },
          ],
        },
      });
    });

    it("ends as its completion says", () => {
      expect(attempts([...aOpen, stepSucceeded("a")])).toEqual(["Main a @1 Succeeded"]);
      expect(attempts([...aOpen, stepFailed("a")])).toEqual(["Main a @1 Failed"]);
      expect(attempts([...aOpen, stepFailed("a", {}, true)])).toEqual([
        "Main a @1 FailedRetryable",
      ]);
    });

    it("does not start while another step is in flight: control never forks", () => {
      expect(verdict(aOpen, stepStarted("b"))).toBe("AttemptsOpen");
      expect(verdict(aOpen, stepStarted("b", { item: 0 }))).toBe("AttemptsOpen");
    });

    it("starts at attempt 1", () => {
      expect(verdict(started, stepStarted("a", { attempt: 2 }))).toBe("AttemptOutOfOrder");
      expect(verdict(started, stepStarted("a", { item: 0, attempt: 2 }))).toBe("AttemptOutOfOrder");
    });

    it("is retried only after a failure that may be retried, with the next attempt number", () => {
      const retryable = [runStarted, ...fails("a", true)];
      expect(attempts([...retryable, stepStarted("a", { attempt: 2 })])).toEqual([
        "Main a @2 Open",
      ]);
      expect(verdict(retryable, stepStarted("a", { attempt: 3 }))).toBe("AttemptOutOfOrder");
      expect(verdict(retryable, stepStarted("a"))).toBe("AttemptOutOfOrder");
      expect(verdict([runStarted, ...fails("a")], stepStarted("a", { attempt: 2 }))).toBe(
        "AttemptOutOfOrder",
      );
      expect(verdict([runStarted, ...ok("a")], stepStarted("a", { attempt: 2 }))).toBe(
        "AttemptOutOfOrder",
      );
      expect(verdict(aOpen, stepStarted("a", { attempt: 2 }))).toBe("AttemptOutOfOrder");
      expect(verdict(aOpen, stepStarted("a"))).toBe("AttemptOutOfOrder");
    });

    it("does not run again once another step has started", () => {
      const facts = [runStarted, ...fails("a", true), ...ok("b")];
      expect(verdict(facts, stepStarted("a", { attempt: 2 }))).toBe("StepAlreadyRan");
      expect(verdict(facts, stepStarted("a"))).toBe("StepAlreadyRan");
      expect(verdict(facts, gateOpened("a"))).toBe("StepAlreadyRan");
    });

    it("runs its for-each items side by side, each with attempts of its own", () => {
      const facts = [
        runStarted,
        stepStarted("a", { item: 0 }),
        stepStarted("a", { item: 1 }),
        stepFailed("a", { item: 0 }, true),
        stepStarted("a", { item: 0, attempt: 2 }),
        stepStarted("a", { item: 2 }),
        stepSucceeded("a", { item: 1 }),
      ];
      expect(attempts(facts)).toEqual([
        "Main a#0 @2 Open",
        "Main a#1 @1 Succeeded",
        "Main a#2 @1 Open",
      ]);
      expect(verdict(facts, stepStarted("a", { item: 0, attempt: 3 }))).toBe("AttemptOutOfOrder");
      expect(verdict(facts, stepStarted("a", { item: 1, attempt: 2 }))).toBe("AttemptOutOfOrder");
      expect(verdict(facts, stepStarted("a", { item: 3, attempt: 2 }))).toBe("AttemptOutOfOrder");
      expect(verdict(facts, stepStarted("b", { item: 0 }))).toBe("AttemptsOpen");
    });

    it("is a for-each throughout or not at all", () => {
      expect(verdict([runStarted, stepStarted("a", { item: 0 })], stepStarted("a"))).toBe(
        "StepAlreadyRan",
      );
      expect(verdict(aOpen, stepStarted("a", { item: 0 }))).toBe("StepAlreadyRan");
      expect(verdict([runStarted, ...fails("a", true)], stepStarted("a", { item: 0 }))).toBe(
        "StepAlreadyRan",
      );
    });

    it("is not a gate that already ran", () => {
      const facts = [...waiting, approved("g")];
      expect(verdict(facts, stepStarted("g"))).toBe("StepAlreadyRan");
      expect(verdict(facts, stepStarted("g", { item: 0 }))).toBe("StepAlreadyRan");
    });

    it("carries the key of its run, step and item, in the forward phase", () => {
      const key = (idempotencyKey: string, item?: number) => ({
        ...stepStarted("a", { item }),
        idempotencyKey,
      });
      expect(verdict(started, key("run1:a:Forward"))).toBe("Running");
      expect(verdict(started, key("run1:a:Forward:3", 3))).toBe("Running");
      expect(verdict(started, key("run1:a:Undo"))).toBe("WrongIdempotencyKey");
      expect(verdict(started, key("run1:b:Forward"))).toBe("WrongIdempotencyKey");
      expect(verdict(started, key("run2:a:Forward"))).toBe("WrongIdempotencyKey");
      expect(verdict(started, key("run1:a:Forward:0"))).toBe("WrongIdempotencyKey");
      expect(verdict(started, key("run1:a:Forward", 0))).toBe("WrongIdempotencyKey");
      expect(verdict(started, key("run1:a:Forward:1", 0))).toBe("WrongIdempotencyKey");
    });

    it("starts only in the main phase", () => {
      expect(verdict(compensating, stepStarted("c"))).toBe("WrongPhase");
      expect(verdict(finalizing, stepStarted("c"))).toBe("WrongPhase");
      expect(verdict(started, finallyStarted("f"))).toBe("WrongPhase");
    });

    it("does not start while a gate waits", () => {
      expect(verdict(waiting, stepStarted("a"))).toBe("GateWaiting");
      expect(verdict(waiting, finallyStarted("f"))).toBe("GateWaiting");
      expect(verdict(waiting, { ...stepStarted("a"), idempotencyKey: "run1:a:Undo" })).toBe(
        "GateWaiting",
      );
    });
  });

  describe("a completion", () => {
    const itemOpen = [runStarted, stepStarted("a", { item: 1 })];

    it.each([
      ["another step", aOpen, stepSucceeded("b")],
      ["another attempt", aOpen, stepSucceeded("a", { attempt: 2 })],
      ["an item of a step that has none", aOpen, stepSucceeded("a", { item: 0 })],
      ["another item", itemOpen, stepFailed("a", { item: 0 })],
      ["no item of a for-each", itemOpen, stepFailed("a")],
      ["an attempt that already ended", [...aOpen, stepSucceeded("a")], stepSucceeded("a")],
      ["a failed attempt", [...aOpen, stepFailed("a", {}, true)], stepFailed("a")],
      ["a step, as an undo", aOpen, undoSucceeded("a")],
      ["a step, as an undo that failed", aOpen, undoFailed("a")],
      ["a step, as a gate", aOpen, approved("a")],
      ["a gate, as a step", waiting, stepSucceeded("g")],
      ["a gate, as an undo", waiting, undoFailed("g")],
      ["nothing at all", started, stepSucceeded("a")],
      ["an undo, as a step", [...compensating, undoStarted("b")], stepSucceeded("b")],
      ["an undo, as a step that failed", [...compensating, undoStarted("b")], stepFailed("b")],
      ["another undo", [...compensating, undoStarted("b")], undoSucceeded("a")],
      [
        "another attempt of an undo",
        [...compensating, undoStarted("b")],
        undoFailed("b", { attempt: 2 }),
      ],
      ["a step that succeeded, as its undo", compensating, undoSucceeded("b")],
    ])("is rejected when it names %s", (_, facts, fact) => {
      expect(verdict(facts, fact)).toBe("NoOpenAttempt");
    });

    it("leaves the other attempts as they were", () => {
      const facts = [
        runStarted,
        stepStarted("a", { item: 0 }),
        stepStarted("a", { item: 1 }),
        stepFailed("a", { item: 1 }),
      ];
      expect(attempts(facts)).toEqual(["Main a#0 @1 Open", "Main a#1 @1 Failed"]);
    });
  });

  describe("the track", () => {
    it.each([
      ["stays normal after a success", [runStarted, ...ok("a"), stepStarted("b")], "Normal"],
      ["stays normal after an approval", [...waiting, approved("g"), stepStarted("b")], "Normal"],
      [
        "becomes handling after a failure",
        [runStarted, ...fails("a"), stepStarted("b")],
        "Handling",
      ],
      [
        "becomes handling after a failure that could have been retried",
        [runStarted, ...fails("a", true), stepStarted("b")],
        "Handling",
      ],
      ["becomes handling after a denial", [...waiting, denied("g"), stepStarted("b")], "Handling"],
      ["becomes handling at a gate too", [runStarted, ...fails("a"), gateOpened("g")], "Handling"],
      [
        "stays normal on a retry",
        [runStarted, ...fails("a", true), stepStarted("a", { attempt: 2 })],
        "Normal",
      ],
      [
        "stays normal while a for-each goes on past a failed item",
        [
          runStarted,
          stepStarted("a", { item: 0 }),
          stepFailed("a", { item: 0 }),
          stepStarted("a", { item: 1 }),
        ],
        "Normal",
      ],
      [
        "becomes handling after a for-each with a failed item",
        [
          runStarted,
          ...ok("a", 0),
          stepStarted("a", { item: 1 }),
          stepFailed("a", { item: 1 }),
          stepStarted("b"),
        ],
        "Handling",
      ],
      [
        "stays normal after an item failed and its retry succeeded",
        [
          runStarted,
          stepStarted("a", { item: 0 }),
          stepFailed("a", { item: 0 }, true),
          stepStarted("a", { item: 0, attempt: 2 }),
          stepSucceeded("a", { item: 0, attempt: 2 }),
          stepStarted("b"),
        ],
        "Normal",
      ],
      [
        "stays handling once the handler's steps succeed",
        [runStarted, ...fails("a"), ...ok("b"), stepStarted("c")],
        "Handling",
      ],
      [
        "stays handling through a gate",
        [runStarted, ...fails("a"), gateOpened("g"), approved("g")],
        "Handling",
      ],
    ])("%s", (_, facts, track) => {
      expect(trackOf(facts)).toBe(track);
    });
  });

  describe("a cancel request", () => {
    it("is recorded on the normal track, running or at a gate", () => {
      expect(trackOf([...started, cancelRequested])).toBe("CancelRequested");
      expect(trackOf([...aOpen, cancelRequested])).toBe("CancelRequested");
      expect(trackOf([...waiting, cancelRequested])).toBe("CancelRequested");
      expect(trackOf([...waiting, cancelRequested, cancelRequested])).toBe("CancelRequested");
      expect(stateAfter([...waiting, cancelRequested])._tag).toBe("WaitingForApproval");
    });

    it("changes nothing in a failure handler", () => {
      const handling = [runStarted, ...fails("a"), stepStarted("b")];
      expect(trackOf([...handling, cancelRequested])).toBe("Handling");
      expect(trackOf([runStarted, ...fails("a"), gateOpened("g"), cancelRequested])).toBe(
        "Handling",
      );
    });

    it("changes nothing during cleanup, beyond the seq", () => {
      for (const facts of [compensating, finalizing]) {
        expect(stateAfter([...facts, cancelRequested])).toEqual({
          ...stateAfter(facts),
          run: { ...runOf(facts), seq: facts.length },
        });
      }
    });

    it("stops new main-phase work: a step, an item, a retry or a gate", () => {
      const requested = [runStarted, ...ok("a"), cancelRequested];
      expect(verdict(requested, stepStarted("b"))).toBe("CancellationPending");
      expect(verdict(requested, gateOpened("g"))).toBe("CancellationPending");
      const retryable = [runStarted, stepStarted("a"), cancelRequested, stepFailed("a", {}, true)];
      expect(verdict(retryable, stepStarted("a", { attempt: 2 }))).toBe("CancellationPending");
      const partway = [runStarted, stepStarted("a", { item: 0 }), cancelRequested];
      expect(verdict(partway, stepStarted("a", { item: 1 }))).toBe("CancellationPending");
      expect(verdict([...started, cancelRequested], stepStarted("a"))).toBe("CancellationPending");
    });

    it("lets the work in flight end", () => {
      const partway = [runStarted, stepStarted("a", { item: 0 }), cancelRequested];
      expect(verdict(partway, stepSucceeded("a", { item: 0 }))).toBe("Running");
      expect(verdict([...waiting, cancelRequested], approved("g"))).toBe("Running");
      expect(trackOf([...waiting, cancelRequested, approved("g")])).toBe("CancelRequested");
    });

    it("does not stop the failure handler of a step that was in flight and failed", () => {
      const failed = [runStarted, stepStarted("a"), cancelRequested, stepFailed("a")];
      expect(trackOf([...failed, stepStarted("b")])).toBe("Handling");
      expect(trackOf([...failed, gateOpened("g")])).toBe("Handling");
      expect(trackOf([...waiting, cancelRequested, denied("g"), stepStarted("b")])).toBe(
        "Handling",
      );
      expect(verdict([...failed, stepStarted("b"), stepSucceeded("b")], stepStarted("c"))).toBe(
        "Running",
      );
    });

    it("reports a broken start as broken, before it reports the cancel", () => {
      const requested = [runStarted, ...ok("a"), cancelRequested];
      expect(verdict(requested, stepStarted("b", { attempt: 2 }))).toBe("AttemptOutOfOrder");
    });
  });

  describe("a gate", () => {
    it("opens when nothing is in flight, and the run waits", () => {
      expect(stateAfter(waiting)).toEqual({
        _tag: "WaitingForApproval",
        run: {
          ...run,
          seq: 1,
          attempts: [{ _tag: "Gate", step: "g", attempt: 1, status: "Open" }],
        },
        track: "Normal",
      });
    });

    it.each([
      ["a step is in flight", aOpen, gateOpened("g"), "AttemptsOpen"],
      ["its step already ran", [runStarted, ...ok("a")], gateOpened("a"), "StepAlreadyRan"],
      ["its step is running", aOpen, gateOpened("a"), "AttemptsOpen"],
      ["it is not attempt 1", started, gateOpened("g", 2), "AttemptOutOfOrder"],
      ["a gate waits", waiting, gateOpened("h"), "GateWaiting"],
      ["the main phase ended", compensating, gateOpened("g"), "WrongPhase"],
      ["the finally phase began", finalizing, gateOpened("g"), "WrongPhase"],
    ])("does not open when %s", (_, facts, fact, reason) => {
      expect(verdict(facts, fact)).toBe(reason);
    });

    it("does not open again once it was answered", () => {
      expect(verdict([...waiting, denied("g")], gateOpened("g"))).toBe("StepAlreadyRan");
    });

    it("is answered once, by the event that names it", () => {
      expect(attempts([...waiting, approved("g")])).toEqual(["Gate g @1 Approved"]);
      expect(attempts([...waiting, denied("g")])).toEqual(["Gate g @1 Denied"]);
      expect(stateAfter([...waiting, approved("g")])._tag).toBe("Running");
      expect(stateAfter([...waiting, denied("g")])._tag).toBe("Running");
      expect(verdict(waiting, approved("h"))).toBe("NoOpenAttempt");
      expect(verdict(waiting, denied("g", 2))).toBe("NoOpenAttempt");
      expect(verdict([...waiting, approved("g")], approved("g"))).toBe("NoOpenAttempt");
      expect(verdict([...waiting, approved("g")], denied("g"))).toBe("NoOpenAttempt");
      expect(verdict([...waiting, approved("g"), mainSucceeded], denied("g"))).toBe(
        "NoOpenAttempt",
      );
    });

    it("leaves earlier attempts as they were when it is answered", () => {
      expect(attempts([runStarted, ...ok("a"), gateOpened("g"), approved("g")])).toEqual([
        "Main a @1 Succeeded",
        "Gate g @1 Approved",
      ]);
    });
  });

  describe("the end of the main phase", () => {
    it.each([
      [mainSucceeded, { _tag: "Finalizing", main: "Succeeded" }],
      [mainFailed("Skip"), { _tag: "Finalizing", main: "Failed" }],
      [mainFailed("Run"), { _tag: "Compensating", main: "Failed" }],
    ])("%j leads to %j", (fact, expected) => {
      expect(stateAfter([runStarted, ...ok("a"), fact])).toEqual({
        ...expected,
        run: { ...runOf([runStarted, ...ok("a")]), seq: 3 },
      });
    });

    it("may follow the first event: a for-each over nothing leaves no trace", () => {
      expect(verdict(started, mainSucceeded)).toBe("Finalizing");
    });

    it("waits for the work in flight", () => {
      expect(verdict(aOpen, mainSucceeded)).toBe("AttemptsOpen");
      expect(verdict(aOpen, mainFailed("Run"))).toBe("AttemptsOpen");
      expect(verdict(aOpen, mainFailed("Skip"))).toBe("AttemptsOpen");
      expect(verdict(waiting, mainSucceeded)).toBe("AttemptsOpen");
      expect(verdict([...waiting, cancelRequested], mainFailed("Run"))).toBe("AttemptsOpen");
      expect(verdict([...aOpen, cancelRequested], mainCancelled)).toBe("AttemptsOpen");
    });

    it("happens once", () => {
      expect(verdict(compensating, mainFailed("Run"))).toBe("WrongPhase");
      expect(verdict(finalizing, mainSucceeded)).toBe("WrongPhase");
    });

    it("is Cancelled only after a cancel requested on the normal track", () => {
      expect(verdict(started, mainCancelled)).toBe("NotCancelled");
      expect(verdict(waiting, mainCancelled)).toBe("NotCancelled");
      expect(verdict([runStarted, ...ok("a")], mainCancelled)).toBe("NotCancelled");
      expect(verdict([runStarted, ...fails("a"), ...ok("b"), cancelRequested], mainCancelled)).toBe(
        "NotCancelled",
      );
      expect(verdict([...started, cancelRequested], mainCancelled)).toBe("Compensating");
      expect(stateAfter([runStarted, ...ok("a"), cancelRequested, mainCancelled])).toMatchObject({
        _tag: "Compensating",
        main: "Cancelled",
      });
    });

    it("is not Cancelled when the step it stopped at failed or was denied: the run failed", () => {
      const failed = [runStarted, stepStarted("a"), cancelRequested, stepFailed("a")];
      expect(verdict(failed, mainCancelled)).toBe("NotCancelled");
      expect(verdict(failed, mainFailed("Run"))).toBe("Compensating");
      expect(verdict([...waiting, cancelRequested, denied("g")], mainCancelled)).toBe(
        "NotCancelled",
      );
      expect(verdict([runStarted, ...fails("a"), cancelRequested], mainCancelled)).toBe(
        "NotCancelled",
      );
    });

    it("is Cancelled when the step it stopped at could have been retried: a cancel comes before the next attempt", () => {
      const before = [runStarted, stepStarted("a"), cancelRequested, stepFailed("a", {}, true)];
      const after = [runStarted, ...fails("a", true), cancelRequested];
      for (const facts of [before, after]) {
        expect(verdict(facts, stepStarted("a", { attempt: 2 }))).toBe("CancellationPending");
        expect(verdict(facts, mainCancelled)).toBe("Compensating");
        expect(verdict(facts, mainFailed("Run"))).toBe("Compensating");
      }
    });

    it("is Cancelled after a for-each was cut short, failed items or not", () => {
      const partway = [
        runStarted,
        ...ok("z"),
        stepStarted("a", { item: 0 }),
        cancelRequested,
        stepFailed("a", { item: 0 }),
      ];
      expect(verdict(partway, mainCancelled)).toBe("Compensating");
    });

    it("may still be Succeeded or Failed after a cancel request that found nothing to stop", () => {
      const requested = [runStarted, stepStarted("a"), cancelRequested, stepSucceeded("a")];
      expect(verdict(requested, mainSucceeded)).toBe("Finalizing");
      expect(verdict(requested, mainFailed("Run"))).toBe("Compensating");
    });

    it("leaves a gate that was answered as it was when the run is cancelled", () => {
      const facts = [...waiting, approved("g"), cancelRequested, mainCancelled];
      expect(attempts(facts)).toEqual(["Gate g @1 Approved"]);
    });

    it("closes a gate that was waiting when the run is cancelled", () => {
      const facts = [runStarted, ...ok("a"), gateOpened("g"), cancelRequested, mainCancelled];
      expect(stateAfter(facts)._tag).toBe("Compensating");
      expect(attempts(facts)).toEqual(["Main a @1 Succeeded", "Gate g @1 Cancelled"]);
    });
  });

  describe("an undo", () => {
    it("is recorded after the work it undoes", () => {
      expect(stateAfter([...compensating, undoStarted("b")])).toMatchObject({
        _tag: "Compensating",
        main: "Failed",
        run: {
          seq: 6,
          attempts: [
            { _tag: "Step", step: "a" },
            { _tag: "Step", step: "b" },
            { _tag: "Undo", step: "b", attempt: 1, status: "Open" },
          ],
        },
      });
      expect(attempts([...compensating, undoStarted("b"), undoSucceeded("b")])).toEqual([
        "Main a @1 Succeeded",
        "Main b @1 Succeeded",
        "Undo b @1 Succeeded",
      ]);
    });

    it("runs only in the undo phase", () => {
      expect(verdict([runStarted, ...ok("a")], undoStarted("a"))).toBe("WrongPhase");
      expect(verdict([runStarted, ...ok("a"), gateOpened("g")], undoStarted("a"))).toBe(
        "WrongPhase",
      );
      expect(verdict(finalizing, undoStarted("a"))).toBe("WrongPhase");
      expect(verdict([runStarted, ...ok("a"), mainFailed("Skip")], undoStarted("a"))).toBe(
        "WrongPhase",
      );
      expect(
        verdict([...compensating, finallyStarted("f"), stepSucceeded("f")], undoStarted("b")),
      ).toBe("WrongPhase");
    });

    it("carries a key that differs from its step's", () => {
      const key = (idempotencyKey: string) => ({ ...undoStarted("b"), idempotencyKey });
      expect(verdict(compensating, key("run1:b:Undo"))).toBe("Compensating");
      expect(verdict(compensating, key("run1:b:Forward"))).toBe("WrongIdempotencyKey");
      expect(verdict(compensating, key("run1:a:Undo"))).toBe("WrongIdempotencyKey");
      expect(verdict(compensating, key("run1:b:Undo:0"))).toBe("WrongIdempotencyKey");
      expect(verdict(finalizing, key("run1:b:Forward"))).toBe("WrongPhase");
    });

    it("runs one at a time", () => {
      expect(verdict([...compensating, undoStarted("b")], undoStarted("a"))).toBe("AttemptsOpen");
    });

    it("is only of work that succeeded in the main phase", () => {
      const facts = [
        runStarted,
        ...ok("a"),
        gateOpened("g"),
        approved("g"),
        ...ok("e", 0),
        stepStarted("e", { item: 1 }),
        stepFailed("e", { item: 1 }),
        ...fails("b"),
        mainFailed("Run"),
      ];
      expect(verdict(facts, undoStarted("b"))).toBe("NothingToUndo");
      expect(verdict(facts, undoStarted("g"))).toBe("NothingToUndo");
      expect(verdict(facts, undoStarted("z"))).toBe("NothingToUndo");
      expect(verdict(facts, undoStarted("e", { item: 1 }))).toBe("NothingToUndo");
      expect(verdict(facts, undoStarted("e", { item: 2 }))).toBe("NothingToUndo");
      expect(verdict(facts, undoStarted("e"))).toBe("NothingToUndo");
      expect(verdict(facts, undoStarted("a", { item: 0 }))).toBe("NothingToUndo");
      expect(verdict(facts, undoStarted("e", { item: 0 }))).toBe("Compensating");
      expect(verdict(facts, undoStarted("a"))).toBe("Compensating");
    });

    it("is not of a finally step", () => {
      const facts = [...compensating, finallyStarted("f"), stepSucceeded("f")];
      expect(verdict(facts, undoStarted("f"))).toBe("WrongPhase");
    });

    it("runs in reverse order, and may pass over work that has no undo", () => {
      const three = [runStarted, ...ok("a"), ...ok("b"), ...ok("c"), mainFailed("Run")];
      const undone = (step: string) => [undoStarted(step), undoSucceeded(step)];
      expect(verdict([...three, ...undone("c"), ...undone("b")], undoStarted("a"))).toBe(
        "Compensating",
      );
      expect(verdict([...three, ...undone("c")], undoStarted("a"))).toBe("Compensating");
      expect(verdict([...three, ...undone("a")], undoStarted("b"))).toBe("UndoOutOfOrder");
      expect(verdict([...three, ...undone("b")], undoStarted("c"))).toBe("UndoOutOfOrder");
      expect(verdict([...three, ...undone("c"), ...undone("a")], undoStarted("b"))).toBe(
        "UndoOutOfOrder",
      );
    });

    it("undoes work at most once", () => {
      const undone = [...compensating, undoStarted("b"), undoSucceeded("b")];
      expect(verdict(undone, undoStarted("b"))).toBe("AttemptOutOfOrder");
      expect(verdict(undone, undoStarted("b", { attempt: 2 }))).toBe("AttemptOutOfOrder");
      expect(verdict([...undone, undoStarted("a"), undoSucceeded("a")], undoStarted("b"))).toBe(
        "UndoOutOfOrder",
      );
    });

    it("is retried only in place, after a failure that may be retried", () => {
      const failed = [...compensating, undoStarted("b"), undoFailed("b", {}, true)];
      const retried = [...failed, undoStarted("b", { attempt: 2 })];
      expect(attempts(retried)).toEqual([
        "Main a @1 Succeeded",
        "Main b @1 Succeeded",
        "Undo b @2 Open",
      ]);
      expect(verdict(retried, undoSucceeded("b", { attempt: 2 }))).toBe("Compensating");
      expect(verdict(retried, undoSucceeded("b"))).toBe("NoOpenAttempt");
      expect(verdict(failed, undoStarted("b", { attempt: 3 }))).toBe("AttemptOutOfOrder");
      expect(verdict(failed, undoStarted("b"))).toBe("AttemptOutOfOrder");
      expect(
        verdict(
          [...compensating, undoStarted("b"), undoFailed("b")],
          undoStarted("b", { attempt: 2 }),
        ),
      ).toBe("AttemptOutOfOrder");
      expect(
        verdict(
          [...failed, undoStarted("a"), undoSucceeded("a")],
          undoStarted("b", { attempt: 2 }),
        ),
      ).toBe("UndoOutOfOrder");
      expect(verdict(compensating, undoStarted("b", { attempt: 2 }))).toBe("AttemptOutOfOrder");
      expect(verdict(failed, undoStarted("a", { attempt: 2 }))).toBe("AttemptOutOfOrder");
    });

    it("does not stop the undos after it when it fails", () => {
      const failed = [...compensating, undoStarted("b"), undoFailed("b")];
      expect(attempts(failed)).toEqual([
        "Main a @1 Succeeded",
        "Main b @1 Succeeded",
        "Undo b @1 Failed",
      ]);
      expect(verdict(failed, undoStarted("a"))).toBe("Compensating");
      expect(verdict(failed, finallyStarted("f"))).toBe("Finalizing");
    });

    it("is per item of a for-each, in reverse item order, whatever order the items ended in", () => {
      const facts = [
        runStarted,
        ...ok("a"),
        stepStarted("e", { item: 0 }),
        stepStarted("e", { item: 2 }),
        stepStarted("e", { item: 1 }),
        stepSucceeded("e", { item: 1 }),
        stepSucceeded("e", { item: 2 }),
        stepSucceeded("e", { item: 0 }),
        ...ok("b"),
        cancelRequested,
        mainCancelled,
      ];
      const undone = (step: string, item?: number) => [
        undoStarted(step, { item }),
        undoSucceeded(step, { item }),
      ];
      const reverse = [...undone("b"), ...undone("e", 2), ...undone("e", 1), ...undone("e", 0)];
      expect(verdict([...facts, ...reverse], undoStarted("a"))).toBe("Compensating");
      expect(attempts([...facts, ...undone("e", 2)]).at(-1)).toBe("Undo e#2 @1 Succeeded");
      expect(verdict([...facts, ...undone("e", 1)], undoStarted("e", { item: 2 }))).toBe(
        "UndoOutOfOrder",
      );
      expect(verdict([...facts, ...undone("e", 1)], undoStarted("e", { item: 1 }))).toBe(
        "AttemptOutOfOrder",
      );
      expect(verdict([...facts, ...undone("e", 1)], undoStarted("e", { item: 0 }))).toBe(
        "Compensating",
      );
      expect(verdict([...facts, ...undone("e", 0)], undoStarted("b"))).toBe("UndoOutOfOrder");
      expect(verdict([...facts, ...undone("a")], undoStarted("e", { item: 0 }))).toBe(
        "UndoOutOfOrder",
      );
    });
  });

  describe("a finally step", () => {
    it("ends the undo phase when it starts, and keeps the main result", () => {
      expect(stateAfter([...compensating, finallyStarted("f")])).toMatchObject({
        _tag: "Finalizing",
        main: "Failed",
        run: { seq: 6, attempts: [{}, {}, { _tag: "Step", phase: "Finally", step: "f" }] },
      });
      const cancelled = [runStarted, cancelRequested, mainCancelled, finallyStarted("f")];
      expect(stateAfter(cancelled)).toMatchObject({ _tag: "Finalizing", main: "Cancelled" });
    });

    it("waits for the undo in flight", () => {
      expect(verdict([...compensating, undoStarted("b")], finallyStarted("f"))).toBe(
        "AttemptsOpen",
      );
    });

    it("follows the rules of a main-phase step", () => {
      const open = [...finalizing, finallyStarted("f")];
      expect(attempts(open)).toEqual(["Main a @1 Succeeded", "Finally f @1 Open"]);
      expect(stateAfter(open)).toMatchObject({ _tag: "Finalizing", main: "Succeeded" });
      expect(verdict(open, finallyStarted("h"))).toBe("AttemptsOpen");
      expect(verdict(open, finallyStarted("f"))).toBe("AttemptOutOfOrder");
      expect(verdict(finalizing, finallyStarted("a"))).toBe("StepAlreadyRan");
      expect(verdict(finalizing, finallyStarted("f", { attempt: 2 }))).toBe("AttemptOutOfOrder");
      expect(verdict(finalizing, { ...finallyStarted("f"), idempotencyKey: "run1:f:Undo" })).toBe(
        "WrongIdempotencyKey",
      );
      const failed = [...open, stepFailed("f", {}, true)];
      expect(attempts([...failed, finallyStarted("f", { attempt: 2 })])).toEqual([
        "Main a @1 Succeeded",
        "Finally f @2 Open",
      ]);
      expect(
        verdict(
          [...failed, finallyStarted("h"), stepSucceeded("h")],
          finallyStarted("f", { attempt: 2 }),
        ),
      ).toBe("StepAlreadyRan");
    });

    it("runs its for-each items side by side", () => {
      const facts = [
        ...finalizing,
        finallyStarted("f", { item: 0 }),
        finallyStarted("f", { item: 1 }),
      ];
      expect(attempts(facts)).toEqual([
        "Main a @1 Succeeded",
        "Finally f#0 @1 Open",
        "Finally f#1 @1 Open",
      ]);
      expect(verdict(facts, finallyStarted("f"))).toBe("StepAlreadyRan");
    });

    it("does not stop the finally steps after it when it fails", () => {
      const failed = [...finalizing, finallyStarted("f"), stepFailed("f")];
      expect(verdict(failed, finallyStarted("h"))).toBe("Finalizing");
      expect(stateAfter(failed)._tag).toBe("Finalizing");
    });

    it("is not held back by a cancel request, however early it was made", () => {
      const facts = [runStarted, cancelRequested, mainCancelled, cancelRequested];
      expect(verdict(facts, finallyStarted("f"))).toBe("Finalizing");
    });
  });

  describe("the final event", () => {
    const finalFacts = [runSucceeded, runFailed, runCancelled, runFlagged];
    const cancelled = [runStarted, cancelRequested, mainCancelled];
    const failedUndo = [...compensating, undoStarted("b"), undoFailed("b")];
    const failedFinally = [...finalizing, finallyStarted("f"), stepFailed("f")];

    it.each([
      ["a success", finalizing, ["Succeeded", 0, 0, 0]],
      ["a failure that was undone", compensating, [0, "Failed", 0, 0]],
      ["a failure that skipped undo", [runStarted, mainFailed("Skip")], [0, "Failed", 0, 0]],
      ["a cancel", cancelled, [0, 0, "Cancelled", 0]],
      [
        "a cancel, after finally",
        [...cancelled, finallyStarted("f"), stepSucceeded("f")],
        [0, 0, "Cancelled", 0],
      ],
      ["a failed undo", failedUndo, [0, 0, 0, "NeedsAttention"]],
      [
        "a failed undo, after finally",
        [...failedUndo, finallyStarted("f"), stepSucceeded("f")],
        [0, 0, 0, "NeedsAttention"],
      ],
      ["a failed finally step", failedFinally, [0, 0, 0, "NeedsAttention"]],
      [
        "a failed finally item",
        [...finalizing, finallyStarted("f", { item: 0 }), stepFailed("f", { item: 0 })],
        [0, 0, 0, "NeedsAttention"],
      ],
      [
        "an undo that failed, could have been retried and was not",
        [...compensating, undoStarted("b"), undoFailed("b", {}, true)],
        [0, 0, 0, "NeedsAttention"],
      ],
      [
        "an undo that failed and then succeeded",
        [
          ...compensating,
          undoStarted("b"),
          undoFailed("b", {}, true),
          undoStarted("b", { attempt: 2 }),
          undoSucceeded("b", { attempt: 2 }),
        ],
        [0, "Failed", 0, 0],
      ],
      [
        "a finally step that failed and then succeeded",
        [
          ...finalizing,
          finallyStarted("f"),
          stepFailed("f", {}, true),
          finallyStarted("f", { attempt: 2 }),
          stepSucceeded("f", { attempt: 2 }),
        ],
        ["Succeeded", 0, 0, 0],
      ],
      [
        "a main-phase failure and a denial, which are not cleanups",
        [runStarted, ...fails("a"), gateOpened("g"), denied("g"), mainFailed("Skip")],
        [0, "Failed", 0, 0],
      ],
    ])("after %s, is the one that agrees", (_, facts, expected) => {
      expect(finalFacts.map((fact) => verdict(facts, fact))).toEqual(
        expected.map((tag) => (tag === 0 ? "FinalResultMismatch" : tag)),
      );
    });

    it("keeps the run, and how the main phase ended when it flags the run", () => {
      expect(stateAfter([...failedUndo, runFlagged])).toEqual({
        _tag: "NeedsAttention",
        run: { ...runOf(failedUndo), seq: 8 },
        main: "Failed",
      });
      expect(stateAfter([...compensating, runFailed])).toEqual({
        _tag: "Failed",
        run: { ...runOf(compensating), seq: 6 },
      });
      expect(stateAfter([...cancelled, runCancelled])).toEqual({
        _tag: "Cancelled",
        run: { ...run, seq: 3, attempts: [] },
      });
      expect(stateAfter([...finalizing, runSucceeded])).toEqual({
        _tag: "Succeeded",
        run: { ...runOf(finalizing), seq: 4 },
      });
    });

    it("waits for the main phase to end, and for the work in flight", () => {
      for (const fact of finalFacts) {
        expect(verdict(started, fact)).toBe("WrongPhase");
        expect(verdict(waiting, fact)).toBe("WrongPhase");
        expect(verdict([...compensating, undoStarted("b")], fact)).toBe("AttemptsOpen");
        expect(verdict([...finalizing, finallyStarted("f")], fact)).toBe("AttemptsOpen");
      }
    });
  });

  describe("failedCleanups", () => {
    it("lists the undos and finally steps whose latest attempt failed", () => {
      const facts = [
        runStarted,
        ...ok("a"),
        ...ok("b"),
        ...ok("c"),
        ...fails("d"),
        mainFailed("Run"),
        undoStarted("c"),
        undoFailed("c", {}, true),
        undoStarted("b"),
        undoSucceeded("b"),
        undoStarted("a"),
        undoFailed("a"),
        finallyStarted("f"),
        stepFailed("f"),
        finallyStarted("h"),
        stepSucceeded("h"),
      ];
      const state = stateAfter(facts);
      expect(state._tag === "NotStarted" ? [] : failedCleanups(state.run)).toMatchObject([
        { _tag: "Undo", step: "c", status: "FailedRetryable" },
        { _tag: "Undo", step: "a", status: "Failed" },
        { _tag: "Step", phase: "Finally", step: "f", status: "Failed" },
      ]);
    });
  });

  describe("replay", () => {
    it("gives the state a log leads to", () => {
      expect(replay([])).toEqual(Result.succeed(notStarted));
      expect(replay(logOf(ended))).toEqual(Result.succeed(stateAfter(ended)));
      expect(replay(logOf(compensating))).toEqual(Result.succeed(stateAfter(compensating)));
    });

    it("stops at the first event that does not fit", () => {
      expect(replay(logOf([runStarted, stepStarted("a"), mainSucceeded, runSucceeded]))).toEqual(
        Result.fail({
          _tag: "EventRejected",
          reason: "AttemptsOpen",
          state: "Running",
          event: "MainPhaseEnded",
          seq: 2,
        }),
      );
    });
  });
});
