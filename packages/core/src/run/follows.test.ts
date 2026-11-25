import { describe, expect, it } from "@effect/vitest";
import { Option, Result } from "effect";
import { departures, followsRecipe } from "../index";
import type { Parts } from "../testing/build";
import {
  chain,
  database,
  each,
  edge,
  failed,
  fromRecipe,
  item,
  list,
  recipe,
  show,
  step,
} from "../testing/build";
import {
  approved,
  cancelRequested,
  denied,
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
  stepFailed,
  stepStarted,
  stepSucceeded,
  undoFailed,
  undoStarted,
  undoSucceeded,
} from "../testing/events";
import { generatedCatalog } from "../testing/generate";
import { planOf } from "../testing/play";

type Facts = ReadonlyArray<Parts>;
type At = { item?: number; attempt?: number };

const seen = new Set<string>();

/**
 * What `followsRecipe` makes of a log: the path it took, `"follows so far"` for one that has not
 * ended, or the first event that leaves the recipe as `"seq 3 StepStarted: NotTheNextStep"`.
 */
const verdict = (plan: ReturnType<typeof planOf>, facts: Facts): string => {
  const result = followsRecipe(plan, logOf(facts));
  if (Result.isFailure(result)) {
    const { departure, event, seq } = result.failure;
    seen.add(departure);
    return `seq ${seq} ${event}: ${departure}`;
  }
  return Option.match(result.success, { onNone: () => "follows so far", onSome: show });
};

const ok = (id: string, at: At = {}): Facts => [stepStarted(id, at), stepSucceeded(id, at)];
const fails = (id: string, retryable = false, at: At = {}): Facts => [
  stepStarted(id, at),
  stepFailed(id, at, retryable),
];
const cleaned = (id: string, at: At = {}): Facts => [finallyStarted(id, at), stepSucceeded(id, at)];
const undone = (id: string, at: At = {}): Facts => [undoStarted(id, at), undoSucceeded(id, at)];
const started = (things: number): Parts => ({
  ...runStarted,
  inputs: { things: Array.from({ length: things }, () => ({ kind: "test.database", id: "d" })) },
});

describe("followsRecipe", () => {
  // a (has an undo) → n (has none) → c (has an undo), then `f` and `g` whatever happened.
  const line = planOf(
    recipe({
      start: "a",
      nodes: [
        step("a", "t.undoable"),
        step("n", "t.act"),
        step("c", "t.undoable"),
        step("f", "t.act"),
        step("g", "t.act"),
      ],
      edges: chain("a", "n", "c"),
      finally: ["f", "g"],
    }),
    generatedCatalog,
  );
  const cleanups: Facts = [...cleaned("f"), ...cleaned("g")];
  const allOk: Facts = [runStarted, ...ok("a"), ...ok("n"), ...ok("c"), mainSucceeded];

  it("gives the path of a finished run, as the validator writes it", () => {
    const path = Option.getOrThrow(
      Result.getOrThrow(followsRecipe(line, logOf([...allOk, ...cleanups, runSucceeded]))),
    );
    expect(path).toEqual({
      entries: [
        { phase: "Main", step: "a", outcome: "Succeeded" },
        { phase: "Main", step: "n", outcome: "Succeeded" },
        { phase: "Main", step: "c", outcome: "Succeeded" },
        { phase: "Finally", step: "f", outcome: "Succeeded" },
        { phase: "Finally", step: "g", outcome: "Succeeded" },
      ],
      main: { result: "Succeeded" },
      result: "Succeeded",
    });
    expect(line.paths).toContainEqual(path);
  });

  it("follows an unfinished log so far, at any point", () => {
    const whole = [...allOk, ...cleanups, runSucceeded];
    for (let length = 0; length < whole.length; length += 1) {
      expect(verdict(line, whole.slice(0, length))).toBe("follows so far");
    }
  });

  it("writes a failed run with its undos, latest first, and its finally steps", () => {
    const facts: Facts = [
      runStarted,
      ...ok("a"),
      ...ok("n"),
      ...fails("c"),
      mainFailed("Run"),
      ...undone("a"),
      ...cleanups,
      runFailed,
    ];
    expect(verdict(line, facts)).toBe(
      "a:Succeeded n:Succeeded c:Failed undo a:Succeeded finally f:Succeeded finally g:Succeeded => Failed",
    );
  });

  it("writes a failed cleanup, and the run as one that needs attention", () => {
    const main: Facts = [runStarted, ...ok("a"), ...fails("n"), mainFailed("Run")];
    expect(
      verdict(line, [
        ...main,
        undoStarted("a"),
        undoFailed("a"),
        ...cleaned("f"),
        finallyStarted("g"),
        stepFailed("g"),
        runFlagged,
      ]),
    ).toBe(
      "a:Succeeded n:Failed undo a:Failed finally f:Succeeded finally g:Failed => NeedsAttention",
    );
    // A cleanup that failed once and then succeeded did not fail.
    expect(
      verdict(line, [
        ...main,
        undoStarted("a"),
        undoFailed("a", {}, true),
        undoStarted("a", { attempt: 2 }),
        undoSucceeded("a", { attempt: 2 }),
        finallyStarted("f"),
        stepFailed("f", {}, true),
        finallyStarted("f", { attempt: 2 }),
        stepSucceeded("f", { attempt: 2 }),
        ...cleaned("g"),
        runFailed,
      ]),
    ).toBe(
      "a:Succeeded n:Failed undo a:Succeeded finally f:Succeeded finally g:Succeeded => Failed",
    );
  });

  it("finds a log that is not a run at all", () => {
    expect(verdict(line, [runStarted, stepSucceeded("a")])).toBe(
      "seq 1 StepSucceeded: RejectedByTransition",
    );
    expect(verdict(line, [stepStarted("a")])).toBe("seq 0 StepStarted: RejectedByTransition");
  });

  describe("in the main phase", () => {
    it("finds a step that is not the one the recipe leads to", () => {
      expect(verdict(line, [runStarted, ...ok("n")])).toBe("seq 1 StepStarted: NotTheNextStep");
      expect(verdict(line, [runStarted, ...ok("a"), ...ok("c")])).toBe(
        "seq 3 StepStarted: NotTheNextStep",
      );
      // After a failure the recipe leads to its end, not to the next step.
      expect(verdict(line, [runStarted, ...fails("a"), ...ok("n")])).toBe(
        "seq 3 StepStarted: NotTheNextStep",
      );
      expect(verdict(line, [...allOk.slice(0, -1), ...ok("z")])).toBe(
        "seq 7 StepStarted: NotTheNextStep",
      );
    });

    it("finds a step that began while the one before it could still be retried", () => {
      expect(verdict(line, [runStarted, ...fails("a", true), ...ok("n")])).toBe(
        "seq 3 StepStarted: StepNotOver",
      );
      expect(verdict(line, [runStarted, ...fails("a", true), mainFailed("Run")])).toBe(
        "seq 3 MainPhaseEnded: StepNotOver",
      );
    });

    it("follows a retry", () => {
      expect(
        verdict(line, [runStarted, ...fails("a", true), ...ok("a", { attempt: 2 }), ...ok("n")]),
      ).toBe("follows so far");
    });

    it("finds an end the recipe does not give", () => {
      expect(verdict(line, [runStarted, ...ok("a"), mainSucceeded])).toBe(
        "seq 3 MainPhaseEnded: WrongEnd",
      );
      expect(verdict(line, [runStarted, ...fails("a"), mainSucceeded])).toBe(
        "seq 3 MainPhaseEnded: WrongEnd",
      );
      expect(verdict(line, [runStarted, ...fails("a"), mainFailed("Skip")])).toBe(
        "seq 3 MainPhaseEnded: WrongEnd",
      );
      expect(verdict(line, [...allOk.slice(0, -1), mainFailed("Run")])).toBe(
        "seq 7 MainPhaseEnded: WrongEnd",
      );
      expect(verdict(line, [runStarted, mainSucceeded])).toBe("seq 1 MainPhaseEnded: WrongEnd");
    });

    // g: approved → a → an explicit successful end; denied → h → a failed end that skips undo.
    const gated = planOf(
      recipe({
        start: "g",
        nodes: [step("g", "t.gate"), step("a", "t.undoable"), step("h", "t.undoable")],
        edges: [
          edge("g", "Approved", "a"),
          edge("g", "Denied", "h"),
          edge("a", "Failed", failed("Run")),
          edge("h", "Succeeded", failed("Skip")),
        ],
      }),
      generatedCatalog,
    );

    it("follows the edge for each outcome, to the end the recipe names", () => {
      expect(
        verdict(gated, [
          runStarted,
          gateOpened("g"),
          approved("g"),
          ...ok("a"),
          mainSucceeded,
          runSucceeded,
        ]),
      ).toBe("g:Approved a:Succeeded => Succeeded");
      // The handler succeeded and the end skips undo: nothing is undone.
      expect(
        verdict(gated, [
          runStarted,
          gateOpened("g"),
          denied("g"),
          ...ok("h"),
          mainFailed("Skip"),
          runFailed,
        ]),
      ).toBe("g:Denied h:Succeeded => Failed");
      expect(
        verdict(gated, [runStarted, gateOpened("g"), denied("g"), ...ok("h"), mainFailed("Run")]),
      ).toBe("seq 5 MainPhaseEnded: WrongEnd");
      expect(verdict(gated, [runStarted, gateOpened("g"), approved("g"), ...ok("h")])).toBe(
        "seq 3 StepStarted: NotTheNextStep",
      );
    });

    it("finds work of the wrong kind", () => {
      expect(verdict(gated, [runStarted, stepStarted("g")])).toBe(
        "seq 1 StepStarted: WrongKindOfWork",
      );
      expect(verdict(line, [runStarted, gateOpened("a")])).toBe(
        "seq 1 GateOpened: WrongKindOfWork",
      );
      expect(verdict(line, [runStarted, stepStarted("a", { item: 0 })])).toBe(
        "seq 1 StepStarted: WrongKindOfWork",
      );
    });

    it("writes a cancel where it took effect", () => {
      expect(
        verdict(line, [runStarted, cancelRequested, mainCancelled, ...cleanups, runCancelled]),
      ).toBe("finally f:Succeeded finally g:Succeeded => Cancelled");
      expect(
        verdict(line, [
          runStarted,
          ...ok("a"),
          cancelRequested,
          mainCancelled,
          ...undone("a"),
          ...cleanups,
          runCancelled,
        ]),
      ).toBe("a:Succeeded undo a:Succeeded finally f:Succeeded finally g:Succeeded => Cancelled");
      expect(
        verdict(gated, [runStarted, gateOpened("g"), cancelRequested, mainCancelled, runCancelled]),
      ).toBe("g:CancelledWaiting => Cancelled");
      // The cancel forestalled the retry: the step did nothing, and has no entry.
      expect(
        verdict(line, [
          runStarted,
          ...ok("a"),
          ...fails("n", true),
          cancelRequested,
          mainCancelled,
          ...undone("a"),
          ...cleanups,
          runCancelled,
        ]),
      ).toBe("a:Succeeded undo a:Succeeded finally f:Succeeded finally g:Succeeded => Cancelled");
    });

    it("finds a cancelled end where the recipe has no cancellation point", () => {
      expect(verdict(line, [...allOk.slice(0, -1), cancelRequested, mainCancelled])).toBe(
        "seq 8 MainPhaseEnded: NoCancellationPoint",
      );
    });
  });

  describe("in a for-each", () => {
    const over = (policy: string) =>
      planOf(
        recipe({
          start: "a",
          inputs: { things: { type: list(database) } },
          nodes: [
            step("a", "t.undoable"),
            step("e", "t.each", { thing: item }, each(fromRecipe("things"), policy)),
            step("b", "t.act"),
            step("h", "t.act"),
            step("d", "t.eachPlain", { thing: item }, each(fromRecipe("things"), policy)),
          ],
          edges: [...chain("a", "e", "b"), edge("e", "Failed", "h")],
          finally: ["d"],
        }),
        generatedCatalog,
      );
    const going = over("Continue");
    const stopping = over("Stop");
    const items = (id: string, indexes: ReadonlyArray<number>): Facts =>
      indexes.flatMap((index) => ok(id, { item: index }));
    const cleanedItems = (indexes: ReadonlyArray<number>): Facts =>
      indexes.flatMap((index) => cleaned("d", { item: index }));

    it("is one entry, and so is the undo of its items", () => {
      expect(
        verdict(going, [
          started(2),
          ...ok("a"),
          ...items("e", [1, 0]),
          ...fails("b"),
          mainFailed("Run"),
          ...undone("e", { item: 1 }),
          ...undone("e", { item: 0 }),
          ...undone("a"),
          ...cleanedItems([0, 1]),
          runFailed,
        ]),
      ).toBe(
        "a:Succeeded e:Succeeded b:Failed undo e:Succeeded undo a:Succeeded finally d:Succeeded => Failed",
      );
    });

    it("ends failed once an item failed and the rest ran, with the undo of what succeeded", () => {
      const facts: Facts = [
        started(2),
        ...ok("a"),
        ...fails("e", false, { item: 0 }),
        ...items("e", [1]),
        ...ok("h"),
        mainSucceeded,
        ...cleanedItems([0, 1]),
        runSucceeded,
      ];
      expect(verdict(going, facts)).toBe(
        "a:Succeeded e:Failed h:Succeeded finally d:Succeeded => Succeeded",
      );
      expect(
        verdict(going, [
          ...facts.slice(0, 7),
          ...fails("h"),
          mainFailed("Run"),
          ...undone("e", { item: 1 }),
          undoStarted("a"),
          undoFailed("a"),
          ...cleanedItems([0]),
          finallyStarted("d", { item: 1 }),
          stepFailed("d", { item: 1 }),
          runFlagged,
        ]),
      ).toBe(
        "a:Succeeded e:Failed h:Failed undo e:Succeeded undo a:Failed finally d:Failed => NeedsAttention",
      );
    });

    it("finds a step that began while the for-each had items left", () => {
      expect(verdict(going, [started(2), ...ok("a"), ...items("e", [0]), ...ok("b")])).toBe(
        "seq 5 StepStarted: StepNotOver",
      );
      expect(
        verdict(going, [started(2), ...ok("a"), ...fails("e", false, { item: 0 }), ...ok("h")]),
      ).toBe("seq 5 StepStarted: StepNotOver");
      expect(
        verdict(going, [
          started(2),
          ...ok("a"),
          ...items("e", [0]),
          ...fails("e", true, { item: 1 }),
          ...ok("b"),
        ]),
      ).toBe("seq 7 StepStarted: StepNotOver");
    });

    it("finds an item that the list does not hold, and a plain start of a for-each", () => {
      expect(verdict(going, [started(2), ...ok("a"), stepStarted("e", { item: 2 })])).toBe(
        "seq 3 StepStarted: NoSuchItem",
      );
      expect(verdict(going, [started(2), ...ok("a"), stepStarted("e", { item: 1 })])).toBe(
        "follows so far",
      );
      expect(verdict(going, [started(2), ...ok("a"), stepStarted("e")])).toBe(
        "seq 3 StepStarted: WrongKindOfWork",
      );
    });

    it("stops at the first failure for good when the recipe says so", () => {
      const facts: Facts = [started(3), ...ok("a"), ...fails("e", false, { item: 0 })];
      expect(verdict(stopping, [...facts, ...ok("h")])).toBe("follows so far");
      expect(verdict(stopping, [...facts, stepStarted("e", { item: 1 })])).toBe(
        "seq 5 StepStarted: ForEachHadStopped",
      );
      expect(verdict(going, [...facts, stepStarted("e", { item: 1 })])).toBe("follows so far");
      // An item in flight when the other failed still ends, and the for-each is over then.
      expect(
        verdict(stopping, [
          started(3),
          ...ok("a"),
          stepStarted("e", { item: 0 }),
          stepStarted("e", { item: 1 }),
          stepFailed("e", { item: 0 }),
          stepSucceeded("e", { item: 1 }),
          ...ok("h"),
        ]),
      ).toBe("follows so far");
    });

    it("passes a for-each over an empty list, which leaves no event", () => {
      expect(
        verdict(going, [started(0), ...ok("a"), ...ok("b"), mainSucceeded, runSucceeded]),
      ).toBe("a:Succeeded e:Succeeded b:Succeeded finally d:Succeeded => Succeeded");
      expect(verdict(going, [started(0), ...ok("a"), ...ok("h")])).toBe(
        "seq 3 StepStarted: NotTheNextStep",
      );
      expect(verdict(going, [started(0), ...ok("a"), stepStarted("e", { item: 0 })])).toBe(
        "seq 3 StepStarted: NotTheNextStep",
      );
    });

    it("writes a for-each that a cancel cut short, and one a cancel came before", () => {
      expect(
        verdict(going, [
          started(3),
          ...ok("a"),
          ...items("e", [0]),
          cancelRequested,
          mainCancelled,
          ...undone("e", { item: 0 }),
          ...undone("a"),
          ...cleanedItems([0, 1, 2]),
          runCancelled,
        ]),
      ).toBe(
        "a:Succeeded e:CancelledPartway undo e:Succeeded undo a:Succeeded finally d:Succeeded => Cancelled",
      );
      const before: Facts = [...ok("a"), cancelRequested, mainCancelled, ...undone("a")];
      expect(verdict(going, [started(1), ...before, ...cleanedItems([0]), runCancelled])).toBe(
        "a:Succeeded undo a:Succeeded finally d:Succeeded => Cancelled",
      );
      // A for-each over an empty list is passed: the cancel took effect before the step after it.
      expect(verdict(going, [started(0), ...before, runCancelled])).toBe(
        "a:Succeeded e:Succeeded undo e:Succeeded undo a:Succeeded finally d:Succeeded => Cancelled",
      );
    });

    it("finds a for-each that ended failed and was written off as cancelled", () => {
      const facts: Facts = [
        started(1),
        ...ok("a"),
        ...fails("e", false, { item: 0 }),
        cancelRequested,
        mainCancelled,
      ];
      expect(verdict(going, facts)).toBe("seq 6 MainPhaseEnded: NoCancellationPoint");
      const bare = planOf(
        recipe({
          start: "e",
          inputs: { things: { type: list(database) } },
          nodes: [step("e", "t.each", { thing: item }, each(fromRecipe("things")))],
        }),
        generatedCatalog,
      );
      expect(
        verdict(bare, [
          started(1),
          ...fails("e", false, { item: 0 }),
          cancelRequested,
          mainCancelled,
        ]),
      ).toBe("seq 4 MainPhaseEnded: NoCancellationPoint");
      // With nothing in its list the for-each is over, and nothing is left to cancel.
      expect(verdict(bare, [started(0), cancelRequested, mainCancelled])).toBe(
        "seq 2 MainPhaseEnded: NoCancellationPoint",
      );
      expect(verdict(bare, [started(0), cancelRequested, mainSucceeded, runSucceeded])).toBe(
        "e:Succeeded => Succeeded",
      );
    });

    it("finds a finally for-each that was left with items to run", () => {
      const main: Facts = [
        started(2),
        ...ok("a"),
        ...items("e", [0, 1]),
        ...ok("b"),
        mainSucceeded,
      ];
      expect(verdict(going, [...main, ...cleanedItems([0]), runSucceeded])).toBe(
        "seq 12 RunSucceeded: StepNotOver",
      );
      expect(verdict(going, [...main, runSucceeded])).toBe("seq 10 RunSucceeded: FinallyOwed");
      expect(verdict(going, [...main, finallyStarted("d", { item: 2 })])).toBe(
        "seq 10 StepStarted: NoSuchItem",
      );
      expect(verdict(going, [...main, finallyStarted("d")])).toBe(
        "seq 10 StepStarted: WrongKindOfWork",
      );
    });
  });

  describe("in the undo phase", () => {
    const main: Facts = [runStarted, ...ok("a"), ...ok("n"), ...ok("c"), cancelRequested];
    const failedMain: Facts = [
      runStarted,
      ...ok("a"),
      ...ok("n"),
      ...fails("c"),
      mainFailed("Run"),
    ];

    it("finds an undo out of turn, and an undo of what has none", () => {
      // The cancel came too late for the main phase, so it ends as it would have; fail it instead.
      expect(verdict(line, [...main, mainSucceeded, ...cleanups, runSucceeded])).toBe(
        "a:Succeeded n:Succeeded c:Succeeded finally f:Succeeded finally g:Succeeded => Succeeded",
      );
      expect(verdict(line, [...failedMain, undoStarted("n")])).toBe(
        "seq 8 UndoStarted: UndoOutOfTurn",
      );
      const two: Facts = [runStarted, ...ok("a"), ...ok("n"), cancelRequested, mainCancelled];
      expect(verdict(line, [...two, undoStarted("n")])).toBe("seq 7 UndoStarted: UndoOutOfTurn");
      expect(verdict(line, [...two, ...undone("a"), ...cleanups, runCancelled])).toBe(
        "a:Succeeded n:Succeeded undo a:Succeeded finally f:Succeeded finally g:Succeeded => Cancelled",
      );
    });

    // Two steps with an undo in a row.
    const pair = planOf(
      recipe({
        start: "a",
        nodes: [
          step("a", "t.undoable"),
          step("c", "t.undoable"),
          step("b", "t.act"),
          step("f", "t.act"),
        ],
        edges: chain("a", "c", "b"),
        finally: ["f"],
      }),
      generatedCatalog,
    );
    const owing: Facts = [runStarted, ...ok("a"), ...ok("c"), ...fails("b"), mainFailed("Run")];

    it("wants every undo owed, latest first", () => {
      expect(verdict(pair, [...owing, undoStarted("a")])).toBe("seq 8 UndoStarted: UndoOutOfTurn");
      expect(
        verdict(pair, [...owing, ...undone("c"), ...undone("a"), ...cleaned("f"), runFailed]),
      ).toBe(
        "a:Succeeded c:Succeeded b:Failed undo c:Succeeded undo a:Succeeded finally f:Succeeded => Failed",
      );
    });

    it("finds an undo when none is owed, and items undone out of their order", () => {
      expect(verdict(pair, [...owing, ...undone("c"), ...undone("a"), undoStarted("b")])).toBe(
        "seq 12 UndoStarted: RejectedByTransition",
      );
      const three: Facts = [runStarted, ...ok("a"), ...ok("n"), ...fails("c"), mainFailed("Run")];
      expect(verdict(line, [...three, ...undone("a"), undoStarted("n")])).toBe(
        "seq 10 UndoStarted: RejectedByTransition",
      );
      const only = planOf(
        recipe({
          start: "e",
          inputs: { things: { type: list(database) } },
          nodes: [
            step("e", "t.each", { thing: item }, each(fromRecipe("things"))),
            step("n", "t.act"),
          ],
          edges: chain("e", "n"),
        }),
        generatedCatalog,
      );
      const items: Facts = [
        started(3),
        ...ok("e", { item: 0 }),
        ...ok("e", { item: 2 }),
        ...ok("e", { item: 1 }),
        ...ok("n"),
        cancelRequested,
      ];
      const cut: Facts = [...items.slice(0, 7), cancelRequested, mainCancelled];
      expect(verdict(only, [...cut, undoStarted("e", { item: 1 })])).toBe(
        "seq 9 UndoStarted: UndoOutOfTurn",
      );
      expect(verdict(only, [...cut, undoStarted("e", { item: 0 })])).toBe(
        "seq 9 UndoStarted: UndoOutOfTurn",
      );
      expect(
        verdict(only, [
          ...cut,
          ...undone("e", { item: 2 }),
          ...undone("e", { item: 1 }),
          ...undone("e", { item: 0 }),
          runCancelled,
        ]),
      ).toBe("e:Succeeded undo e:Succeeded => Cancelled");
      // Nothing is owed when nothing that succeeded has an undo.
      const plain = planOf(
        recipe({
          start: "n",
          nodes: [step("n", "t.act"), step("c", "t.undoable")],
          edges: chain("n", "c"),
        }),
        generatedCatalog,
      );
      expect(
        verdict(plain, [
          runStarted,
          ...ok("n"),
          ...fails("c"),
          mainFailed("Run"),
          undoStarted("n"),
        ]),
      ).toBe("seq 6 UndoStarted: UndoOutOfTurn");
      // Nothing is owed after a success, whatever has an undo.
      expect(verdict(only, [...items, mainSucceeded, undoStarted("e", { item: 2 })])).toBe(
        "seq 11 UndoStarted: RejectedByTransition",
      );
    });

    it("finds a run that moved on with an undo owed", () => {
      expect(verdict(pair, [...owing, finallyStarted("f")])).toBe("seq 8 StepStarted: UndoOwed");
      expect(verdict(pair, [...owing, ...undone("c"), finallyStarted("f")])).toBe(
        "seq 10 StepStarted: UndoOwed",
      );
      const bare = planOf(
        recipe({
          start: "a",
          nodes: [step("a", "t.undoable"), step("b", "t.act")],
          edges: chain("a", "b"),
        }),
        generatedCatalog,
      );
      const facts: Facts = [runStarted, ...ok("a"), ...fails("b"), mainFailed("Run")];
      expect(verdict(bare, [...facts, runFailed])).toBe("seq 6 RunFailed: UndoOwed");
      expect(verdict(bare, [...facts, ...undone("a"), runFailed])).toBe(
        "a:Succeeded b:Failed undo a:Succeeded => Failed",
      );
      expect(
        verdict(bare, [...facts, undoStarted("a"), undoFailed("a", {}, true), runFlagged]),
      ).toBe("seq 8 RunFlaggedForAttention: StepNotOver");
    });

    it("finds an undo left half tried", () => {
      const half: Facts = [...owing, undoStarted("c"), undoFailed("c", {}, true)];
      expect(verdict(pair, [...half, undoStarted("a")])).toBe("seq 10 UndoStarted: StepNotOver");
      expect(verdict(pair, [...half, undoStarted("c", { attempt: 2 })])).toBe("follows so far");
      expect(
        verdict(pair, [
          ...owing,
          ...undone("c"),
          undoStarted("a"),
          undoFailed("a", {}, true),
          finallyStarted("f"),
        ]),
      ).toBe("seq 12 StepStarted: StepNotOver");
    });

    it("owes no undo after a successful end or one that skips undo", () => {
      const skipping = planOf(
        recipe({
          start: "a",
          nodes: [step("a", "t.undoable"), step("b", "t.act")],
          edges: [edge("a", "Succeeded", "b"), edge("b", "Failed", failed("Skip"))],
        }),
        generatedCatalog,
      );
      expect(
        verdict(skipping, [runStarted, ...ok("a"), ...fails("b"), mainFailed("Skip"), runFailed]),
      ).toBe("a:Succeeded b:Failed => Failed");
    });
  });

  describe("in the finally phase", () => {
    it("finds a finally step out of turn", () => {
      expect(verdict(line, [...allOk, finallyStarted("g")])).toBe(
        "seq 8 StepStarted: FinallyOutOfTurn",
      );
      expect(verdict(line, [...allOk, ...cleaned("f"), finallyStarted("z")])).toBe(
        "seq 10 StepStarted: FinallyOutOfTurn",
      );
      expect(verdict(line, [...allOk, ...cleanups, finallyStarted("z")])).toBe(
        "seq 12 StepStarted: FinallyOutOfTurn",
      );
    });

    it("finds a finally step left half tried, and one never run", () => {
      const half: Facts = [...allOk, finallyStarted("f"), stepFailed("f", {}, true)];
      expect(verdict(line, [...half, finallyStarted("g")])).toBe("seq 10 StepStarted: StepNotOver");
      expect(verdict(line, [...half, finallyStarted("f", { attempt: 2 })])).toBe("follows so far");
      expect(
        verdict(line, [
          ...allOk,
          ...cleaned("f"),
          finallyStarted("g"),
          stepFailed("g", {}, true),
          runFlagged,
        ]),
      ).toBe("seq 12 RunFlaggedForAttention: StepNotOver");
      expect(verdict(line, [...allOk, ...cleaned("f"), runSucceeded])).toBe(
        "seq 10 RunSucceeded: FinallyOwed",
      );
      expect(verdict(line, [...allOk, runSucceeded])).toBe("seq 8 RunSucceeded: FinallyOwed");
    });

    it("goes on to the next finally step after one failed for good", () => {
      expect(
        verdict(line, [
          ...allOk,
          finallyStarted("f"),
          stepFailed("f"),
          ...cleaned("g"),
          runFlagged,
        ]),
      ).toBe(
        "a:Succeeded n:Succeeded c:Succeeded finally f:Failed finally g:Succeeded => NeedsAttention",
      );
    });
  });

  it("gave every departure above", () => {
    expect([...seen].toSorted()).toEqual([...departures].toSorted());
  });
});
