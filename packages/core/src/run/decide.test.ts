import { describe, expect, it } from "@effect/vitest";
import type { Decision } from "../index";
import { decide, maxSideBySide } from "../index";
import type { Parts } from "../testing/build";
import {
  chain,
  each,
  edge,
  failed,
  fromRecipe,
  item,
  list,
  recipe,
  step,
  succeeded,
} from "../testing/build";
import { database } from "../testing/build";
import {
  approved,
  cancelRequested,
  denied,
  finallyStarted,
  gateOpened,
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
import { generatedCatalog } from "../testing/generate";
import { planOf } from "../testing/play";

type Facts = ReadonlyArray<Parts>;

/** `"RunSteps Main e#0@1 e#1@1"`, `"RunUndo a@2"`, `"EndMainPhase Failed Skip"`: a decision on one line. */
const show = (decision: Decision): string => {
  const place = (id: string, work: { readonly item?: number; readonly attempt: number }) =>
    `${id}${work.item === undefined ? "" : `#${work.item}`}@${work.attempt}`;
  switch (decision._tag) {
    case "RunSteps": {
      const works = decision.work.map((work) => place(decision.step.step.id, work));
      return `RunSteps ${decision.phase} ${works.join(" ")}`;
    }
    case "RunUndo": {
      return `RunUndo ${place(decision.step.step.id, decision.work)} with ${decision.undo.block.id}`;
    }
    case "OpenGate":
    case "AwaitGate": {
      return `${decision._tag} ${decision.step.step.id}`;
    }
    case "EndMainPhase": {
      const undo = decision.main.result === "Failed" ? ` ${decision.main.undo}` : "";
      return `EndMainPhase ${decision.main.result}${undo}`;
    }
    case "EndRun": {
      return `EndRun ${decision.event}`;
    }
    case "AwaitStart":
    case "AwaitWork":
    case "Ended": {
      return decision._tag;
    }
  }
};

const ok = (id: string, at: { item?: number; attempt?: number } = {}): Facts => [
  stepStarted(id, at),
  stepSucceeded(id, at),
];
const fails = (
  id: string,
  retryable: boolean,
  at: { item?: number; attempt?: number } = {},
): Facts => [stepStarted(id, at), stepFailed(id, at, retryable)];
const undone = (id: string, at: { item?: number } = {}): Facts => [
  undoStarted(id, at),
  undoSucceeded(id, at),
];

describe("decide", () => {
  // a (has an undo) → b, then `f` whatever happened.
  const line = planOf(
    recipe({
      start: "a",
      nodes: [step("a", "t.undoable"), step("b", "t.act"), step("f", "t.act"), step("g", "t.act")],
      edges: chain("a", "b"),
      finally: ["f", "g"],
    }),
    generatedCatalog,
  );
  const on = (plan: typeof line, facts: Facts, size = 0): string =>
    show(decide(plan, stateAfter(facts), () => size));

  it("waits for a run that has not started and has nothing for one that ended", () => {
    expect(on(line, [])).toBe("AwaitStart");
    const cleanups: Facts = [
      finallyStarted("f"),
      stepSucceeded("f"),
      finallyStarted("g"),
      stepSucceeded("g"),
    ];
    expect(
      on(line, [runStarted, ...ok("a"), ...ok("b"), mainSucceeded, ...cleanups, runSucceeded]),
    ).toBe("Ended");
    expect(on(line, [runStarted, ...fails("a", false), mainFailed(), ...cleanups, runFailed])).toBe(
      "Ended",
    );
    expect(on(line, [runStarted, cancelRequested, mainCancelled, ...cleanups, runCancelled])).toBe(
      "Ended",
    );
    expect(
      on(line, [
        runStarted,
        mainSucceeded,
        finallyStarted("f"),
        stepFailed("f"),
        finallyStarted("g"),
        stepSucceeded("g"),
        runFlagged,
      ]),
    ).toBe("Ended");
  });

  it("returns the step itself, its block and all, so the engine looks nothing up", () => {
    expect(decide(line, stateAfter([runStarted]), () => 0)).toEqual({
      _tag: "RunSteps",
      phase: "Main",
      step: line.resolved.start,
      work: [{ attempt: 1 }],
    });
    const [a] = line.resolved.main;
    expect(
      decide(
        line,
        stateAfter([runStarted, ...ok("a"), ...fails("b", false), mainFailed()]),
        () => 0,
      ),
    ).toEqual({
      _tag: "RunUndo",
      step: a,
      undo: a?.undo.pipe((undo) => (undo._tag === "Some" ? undo.value : undefined)),
      work: { attempt: 1 },
    });
    expect(decide(line, stateAfter([runStarted, ...ok("a"), ...ok("b")]), () => 0)).toEqual({
      _tag: "EndMainPhase",
      main: { result: "Succeeded" },
    });
  });

  describe("in the main phase", () => {
    it("runs the steps in the recipe's order, one at a time", () => {
      expect(on(line, [runStarted])).toBe("RunSteps Main a@1");
      expect(on(line, [runStarted, stepStarted("a")])).toBe("AwaitWork");
      expect(on(line, [runStarted, ...ok("a")])).toBe("RunSteps Main b@1");
      expect(on(line, [runStarted, ...ok("a"), stepStarted("b")])).toBe("AwaitWork");
      expect(on(line, [runStarted, ...ok("a"), ...ok("b")])).toBe("EndMainPhase Succeeded");
    });

    it("tries a step again after a failure that may be retried, and not after one that may not", () => {
      expect(on(line, [runStarted, ...fails("a", true)])).toBe("RunSteps Main a@2");
      expect(on(line, [runStarted, ...fails("a", true), ...fails("a", true, { attempt: 2 })])).toBe(
        "RunSteps Main a@3",
      );
      expect(on(line, [runStarted, ...fails("a", true), stepStarted("a", { attempt: 2 })])).toBe(
        "AwaitWork",
      );
      expect(on(line, [runStarted, ...fails("a", false)])).toBe("EndMainPhase Failed Run");
      expect(on(line, [runStarted, ...fails("a", true), ...ok("a", { attempt: 2 })])).toBe(
        "RunSteps Main b@1",
      );
    });

    // g: approved → a → the end the recipe names; denied → h, the handler → a failed end that
    // skips undo. a failed → h too.
    const gated = planOf(
      recipe({
        start: "g",
        nodes: [
          step("g", "t.gate"),
          step("a", "t.undoable"),
          step("h", "t.act"),
          step("z", "t.act"),
        ],
        edges: [
          edge("g", "Approved", "a"),
          edge("g", "Denied", "h"),
          edge("a", "Succeeded", succeeded),
          edge("a", "Failed", "h"),
          edge("h", "Succeeded", failed("Skip")),
          edge("h", "Failed", "z"),
          edge("z", "Succeeded", failed("Run")),
        ],
      }),
      generatedCatalog,
    );

    it("opens a gate, waits at it, and goes where its outcome leads", () => {
      expect(on(gated, [runStarted])).toBe("OpenGate g");
      expect(on(gated, [runStarted, gateOpened("g")])).toBe("AwaitGate g");
      expect(on(gated, [runStarted, gateOpened("g"), approved("g")])).toBe("RunSteps Main a@1");
      expect(on(gated, [runStarted, gateOpened("g"), denied("g")])).toBe("RunSteps Main h@1");
    });

    it("ends where the recipe says: at an explicit end, or the default for the outcome", () => {
      const toA: Facts = [runStarted, gateOpened("g"), approved("g")];
      expect(on(gated, [...toA, ...ok("a")])).toBe("EndMainPhase Succeeded");
      expect(on(gated, [...toA, ...fails("a", false), ...ok("h")])).toBe(
        "EndMainPhase Failed Skip",
      );
      expect(on(gated, [...toA, ...fails("a", false), ...fails("h", false), ...ok("z")])).toBe(
        "EndMainPhase Failed Run",
      );
      expect(
        on(gated, [...toA, ...fails("a", false), ...fails("h", false), ...fails("z", false)]),
      ).toBe("EndMainPhase Failed Run");
    });

    it("ends cancelled before the next step, at a gate and before a retry", () => {
      expect(on(line, [runStarted, cancelRequested])).toBe("EndMainPhase Cancelled");
      expect(on(line, [runStarted, ...ok("a"), cancelRequested])).toBe("EndMainPhase Cancelled");
      expect(on(line, [runStarted, ...fails("a", true), cancelRequested])).toBe(
        "EndMainPhase Cancelled",
      );
      expect(on(gated, [runStarted, cancelRequested])).toBe("EndMainPhase Cancelled");
      expect(on(gated, [runStarted, gateOpened("g"), cancelRequested])).toBe(
        "EndMainPhase Cancelled",
      );
    });

    it("lets work in flight end first, and a run that has no step left end as it would have", () => {
      expect(on(line, [runStarted, stepStarted("a"), cancelRequested])).toBe("AwaitWork");
      expect(on(line, [runStarted, ...ok("a"), ...ok("b"), cancelRequested])).toBe(
        "EndMainPhase Succeeded",
      );
      expect(on(line, [runStarted, ...fails("a", false), cancelRequested])).toBe(
        "EndMainPhase Failed Run",
      );
    });

    it("runs a failure handler to its end whatever was cancelled", () => {
      const denial: Facts = [runStarted, gateOpened("g"), cancelRequested, denied("g")];
      expect(on(gated, denial)).toBe("RunSteps Main h@1");
      expect(on(gated, [...denial, ...fails("h", true), cancelRequested])).toBe(
        "RunSteps Main h@2",
      );
      expect(on(gated, [...denial, ...ok("h"), cancelRequested])).toBe("EndMainPhase Failed Skip");
      const failure: Facts = [
        runStarted,
        gateOpened("g"),
        approved("g"),
        stepStarted("a"),
        cancelRequested,
        stepFailed("a"),
      ];
      expect(on(gated, failure)).toBe("RunSteps Main h@1");
      expect(on(gated, [...failure, ...fails("h", false)])).toBe("RunSteps Main z@1");
    });
  });

  describe("in a for-each", () => {
    const over = (policy: string, next: "b" | "g" = "b") =>
      planOf(
        recipe({
          start: "e",
          inputs: { things: { type: list(database) } },
          nodes: [
            step("e", "t.each", { thing: item }, each(fromRecipe("things"), policy)),
            ...(next === "b" ? [step("b", "t.act")] : []),
            step("g", "t.gate"),
            step("h", "t.act"),
          ],
          edges: [
            edge("e", "Succeeded", next),
            edge("e", "Failed", "h"),
            ...(next === "b" ? [edge("b", "Succeeded", "g")] : []),
          ],
        }),
        generatedCatalog,
      );
    const going = over("Continue");
    const stopping = over("Stop");
    const batch = (items: ReadonlyArray<number>): Facts =>
      items.flatMap((index) => ok("e", { item: index }));

    it("starts at most four items side by side, in order", () => {
      expect(maxSideBySide).toBe(4);
      expect(on(going, [runStarted], 6)).toBe("RunSteps Main e#0@1 e#1@1 e#2@1 e#3@1");
      expect(on(going, [runStarted], 4)).toBe("RunSteps Main e#0@1 e#1@1 e#2@1 e#3@1");
      expect(on(going, [runStarted], 1)).toBe("RunSteps Main e#0@1");
      expect(on(going, [runStarted, ...batch([0, 1, 2, 3])], 6)).toBe("RunSteps Main e#4@1 e#5@1");
      expect(on(going, [runStarted, ...batch([0, 1, 2, 3])], 9)).toBe(
        "RunSteps Main e#4@1 e#5@1 e#6@1 e#7@1",
      );
    });

    it("waits while any item is in flight", () => {
      expect(on(going, [runStarted, ...batch([0, 1]), stepStarted("e", { item: 2 })], 6)).toBe(
        "AwaitWork",
      );
    });

    it("goes on along the Succeeded edge once every item succeeded", () => {
      expect(on(going, [runStarted, ...batch([0, 1, 2, 3])], 4)).toBe("RunSteps Main b@1");
      expect(on(going, [runStarted, ...batch([0])], 1)).toBe("RunSteps Main b@1");
    });

    it("passes a for-each over an empty list without a word", () => {
      expect(on(going, [runStarted], 0)).toBe("RunSteps Main b@1");
      expect(on(over("Continue", "g"), [runStarted], 0)).toBe("OpenGate g");
    });

    it("retries an item, before it starts new ones", () => {
      const facts: Facts = [
        runStarted,
        ...batch([0]),
        ...fails("e", true, { item: 1 }),
        ...batch([2, 3]),
      ];
      expect(on(going, facts, 8)).toBe("RunSteps Main e#1@2 e#4@1 e#5@1 e#6@1");
      expect(on(going, facts, 4)).toBe("RunSteps Main e#1@2");
      expect(on(stopping, facts, 4)).toBe("RunSteps Main e#1@2");
    });

    it("runs every item when it continues past a failure, and then fails", () => {
      const facts: Facts = [runStarted, ...fails("e", false, { item: 0 }), ...batch([1, 2, 3])];
      expect(on(going, facts, 6)).toBe("RunSteps Main e#4@1 e#5@1");
      expect(on(going, [...facts, ...batch([4, 5])], 6)).toBe("RunSteps Main h@1");
    });

    it("starts nothing more once an item failed for good, when it stops at a failure", () => {
      const facts: Facts = [
        runStarted,
        ...fails("e", false, { item: 0 }),
        ...fails("e", true, { item: 1 }),
        ...batch([2, 3]),
      ];
      expect(on(stopping, facts, 6)).toBe("RunSteps Main h@1");
      expect(on(stopping, [...facts.slice(0, 5), stepStarted("e", { item: 2 })], 6)).toBe(
        "AwaitWork",
      );
    });

    it("is cut short by a cancel: no further item and no retry", () => {
      expect(on(going, [runStarted, ...batch([0, 1, 2, 3]), cancelRequested], 6)).toBe(
        "EndMainPhase Cancelled",
      );
      expect(
        on(
          going,
          [runStarted, ...batch([0]), ...fails("e", true, { item: 1 }), cancelRequested],
          2,
        ),
      ).toBe("EndMainPhase Cancelled");
      expect(on(going, [runStarted, stepStarted("e", { item: 0 }), cancelRequested], 6)).toBe(
        "AwaitWork",
      );
    });

    it("is not cancelled once it is over: the run goes where its outcome leads", () => {
      expect(on(going, [runStarted, ...batch([0, 1]), cancelRequested], 2)).toBe(
        "EndMainPhase Cancelled",
      );
      expect(
        on(
          going,
          [runStarted, ...fails("e", false, { item: 0 }), ...batch([1]), cancelRequested],
          2,
        ),
      ).toBe("RunSteps Main h@1");
      expect(
        on(stopping, [runStarted, ...fails("e", false, { item: 0 }), cancelRequested], 6),
      ).toBe("RunSteps Main h@1");
    });

    it("passes a for-each over an empty list under a cancel too: the cancel waits for a step", () => {
      expect(on(going, [runStarted, cancelRequested], 0)).toBe("EndMainPhase Cancelled");
      expect(on(going, [runStarted, stepStarted("b"), cancelRequested], 0)).toBe("AwaitWork");
      expect(on(going, [runStarted, ...ok("b"), cancelRequested], 0)).toBe(
        "EndMainPhase Cancelled",
      );
      expect(
        on(going, [runStarted, ...ok("b"), gateOpened("g"), approved("g"), cancelRequested], 0),
      ).toBe("EndMainPhase Succeeded");
      expect(on(over("Continue", "g"), [runStarted, gateOpened("g"), cancelRequested], 0)).toBe(
        "EndMainPhase Cancelled",
      );
    });

    // Two for-each steps in a row, then `b`.
    const twice = planOf(
      recipe({
        start: "e",
        inputs: { things: { type: list(database) } },
        nodes: [
          step("e", "t.each", { thing: item }, each(fromRecipe("things"))),
          step("d", "t.eachPlain", { thing: item }, each(fromRecipe("things"))),
          step("b", "t.act"),
        ],
        edges: chain("e", "d", "b"),
      }),
      generatedCatalog,
    );

    it("sees through several empty lists in a row, to the end if there is nothing else", () => {
      expect(on(twice, [runStarted, cancelRequested], 0)).toBe("EndMainPhase Cancelled");
      expect(on(twice, [runStarted, ...ok("b"), cancelRequested], 0)).toBe(
        "EndMainPhase Succeeded",
      );
      expect(on(twice, [runStarted, stepStarted("b"), cancelRequested], 0)).toBe("AwaitWork");
      const only = planOf(
        recipe({
          start: "e",
          inputs: { things: { type: list(database) } },
          nodes: [step("e", "t.each", { thing: item }, each(fromRecipe("things")))],
        }),
        generatedCatalog,
      );
      expect(on(only, [runStarted, cancelRequested], 0)).toBe("EndMainPhase Succeeded");
      expect(on(only, [runStarted, cancelRequested], 1)).toBe("EndMainPhase Cancelled");
    });
  });

  describe("in the undo phase", () => {
    // Three steps with an undo, the second a for-each, and one without.
    const undoable = planOf(
      recipe({
        start: "a",
        inputs: { things: { type: list(database) } },
        nodes: [
          step("a", "t.undoable"),
          step("e", "t.each", { thing: item }, each(fromRecipe("things"))),
          step("n", "t.act"),
          step("c", "t.undoable"),
          step("f", "t.act"),
        ],
        edges: chain("a", "e", "n", "c"),
        finally: ["f"],
      }),
      generatedCatalog,
    );
    const main: Facts = [
      runStarted,
      ...ok("a"),
      // The items in the order they happened to start, which is not their order.
      ...ok("e", { item: 1 }),
      ...ok("e", { item: 0 }),
      ...fails("e", false, { item: 2 }),
      mainFailed("Run"),
    ];

    it("undoes what succeeded and has an undo, latest first, item by item", () => {
      expect(on(undoable, main, 3)).toBe("RunUndo e#1@1 with t.uneach");
      expect(on(undoable, [...main, ...undone("e", { item: 1 })], 3)).toBe(
        "RunUndo e#0@1 with t.uneach",
      );
      expect(
        on(undoable, [...main, ...undone("e", { item: 1 }), ...undone("e", { item: 0 })], 3),
      ).toBe("RunUndo a@1 with t.act");
    });

    it("undoes items by their place in the list, not by the order they started", () => {
      const facts: Facts = [
        runStarted,
        ...ok("e", { item: 0 }),
        ...ok("e", { item: 2 }),
        ...ok("e", { item: 1 }),
        ...ok("e", { item: 3 }),
        cancelRequested,
        mainCancelled,
      ];
      const only = planOf(
        recipe({
          start: "e",
          inputs: { things: { type: list(database) } },
          nodes: [step("e", "t.each", { thing: item }, each(fromRecipe("things")))],
        }),
        generatedCatalog,
      );
      const order = ["3", "2", "1", "0"].map((_, done, all) =>
        on(
          only,
          [
            ...facts,
            ...all.slice(0, done).flatMap((index) => undone("e", { item: Number(index) })),
          ],
          8,
        ),
      );
      expect(order).toEqual([
        "RunUndo e#3@1 with t.uneach",
        "RunUndo e#2@1 with t.uneach",
        "RunUndo e#1@1 with t.uneach",
        "RunUndo e#0@1 with t.uneach",
      ]);
    });

    it("skips what has no undo and what did not succeed", () => {
      const facts: Facts = [
        runStarted,
        ...ok("a"),
        ...ok("n"),
        ...fails("c", false),
        mainFailed("Run"),
      ];
      const skipping = planOf(
        recipe({
          start: "a",
          nodes: [step("a", "t.undoable"), step("n", "t.act"), step("c", "t.undoable")],
          edges: chain("a", "n", "c"),
        }),
        generatedCatalog,
      );
      expect(on(skipping, facts)).toBe("RunUndo a@1 with t.act");
      expect(on(skipping, [...facts, ...undone("a")])).toBe("EndRun RunFailed");
    });

    it("waits for the undo in flight, and tries one again that may be retried", () => {
      expect(on(undoable, [...main, undoStarted("e", { item: 1 })], 3)).toBe("AwaitWork");
      const once: Facts = [
        ...main,
        undoStarted("e", { item: 1 }),
        undoFailed("e", { item: 1 }, true),
      ];
      expect(on(undoable, once, 3)).toBe("RunUndo e#1@2 with t.uneach");
      expect(
        on(
          undoable,
          [
            ...once,
            undoStarted("e", { item: 1, attempt: 2 }),
            undoFailed("e", { item: 1, attempt: 2 }, true),
          ],
          3,
        ),
      ).toBe("RunUndo e#1@3 with t.uneach");
      expect(
        on(
          undoable,
          [
            ...main,
            ...undone("e", { item: 1 }),
            undoStarted("e", { item: 0 }),
            undoFailed("e", { item: 0 }, true),
          ],
          3,
        ),
      ).toBe("RunUndo e#0@2 with t.uneach");
    });

    it("goes on to the next undo after one failed for good, and then to the finally steps", () => {
      const failedOne: Facts = [
        ...main,
        undoStarted("e", { item: 1 }),
        undoFailed("e", { item: 1 }),
      ];
      expect(on(undoable, failedOne, 3)).toBe("RunUndo e#0@1 with t.uneach");
      const all: Facts = [...failedOne, ...undone("e", { item: 0 }), ...undone("a")];
      expect(on(undoable, all, 3)).toBe("RunSteps Finally f@1");
      expect(on(undoable, [...all, finallyStarted("f"), stepSucceeded("f")], 3)).toBe(
        "EndRun RunFlaggedForAttention",
      );
    });

    it("undoes after a cancel too, and nothing when nothing succeeded", () => {
      expect(on(undoable, [runStarted, ...ok("a"), cancelRequested, mainCancelled], 3)).toBe(
        "RunUndo a@1 with t.act",
      );
      expect(on(undoable, [runStarted, cancelRequested, mainCancelled], 3)).toBe(
        "RunSteps Finally f@1",
      );
    });
  });

  describe("in the finally phase", () => {
    const cleanup = (policy: string) =>
      planOf(
        recipe({
          start: "a",
          inputs: { things: { type: list(database) } },
          nodes: [
            step("a", "t.act"),
            step("f", "t.act"),
            step("e", "t.eachPlain", { thing: item }, each(fromRecipe("things"), policy)),
            step("g", "t.act"),
          ],
          finally: ["f", "e", "g"],
        }),
        generatedCatalog,
      );
    const going = cleanup("Continue");
    const begun: Facts = [runStarted, ...ok("a"), mainSucceeded];
    const finallyOk = (id: string, at: { item?: number; attempt?: number } = {}): Facts => [
      finallyStarted(id, at),
      stepSucceeded(id, at),
    ];
    const finallyFails = (id: string, retryable: boolean, at: { item?: number } = {}): Facts => [
      finallyStarted(id, at),
      stepFailed(id, at, retryable),
    ];

    it("runs every finally step in the recipe's order, after any main result", () => {
      expect(on(going, begun, 2)).toBe("RunSteps Finally f@1");
      expect(on(going, [...begun, finallyStarted("f")], 2)).toBe("AwaitWork");
      expect(on(going, [...begun, ...finallyOk("f")], 2)).toBe("RunSteps Finally e#0@1 e#1@1");
      expect(
        on(
          going,
          [
            ...begun,
            ...finallyOk("f"),
            ...finallyOk("e", { item: 0 }),
            ...finallyOk("e", { item: 1 }),
          ],
          2,
        ),
      ).toBe("RunSteps Finally g@1");
      expect(on(going, [runStarted, ...fails("a", false), mainFailed("Skip")], 2)).toBe(
        "RunSteps Finally f@1",
      );
    });

    it("passes a for-each over an empty list", () => {
      expect(on(going, [...begun, ...finallyOk("f")], 0)).toBe("RunSteps Finally g@1");
    });

    it("retries a finally step, and goes on to the next after one failed for good", () => {
      expect(on(going, [...begun, ...finallyFails("f", true)], 2)).toBe("RunSteps Finally f@2");
      expect(on(going, [...begun, ...finallyFails("f", false)], 2)).toBe(
        "RunSteps Finally e#0@1 e#1@1",
      );
      const failedItem: Facts = [
        ...begun,
        ...finallyOk("f"),
        ...finallyFails("e", false, { item: 0 }),
      ];
      expect(on(going, [...failedItem, ...finallyOk("e", { item: 1 })], 2)).toBe(
        "RunSteps Finally g@1",
      );
      expect(on(cleanup("Stop"), [...failedItem, ...finallyOk("e", { item: 1 })], 6)).toBe(
        "RunSteps Finally g@1",
      );
      expect(on(going, [...failedItem, ...finallyOk("e", { item: 1 })], 6)).toBe(
        "RunSteps Finally e#2@1 e#3@1 e#4@1 e#5@1",
      );
    });

    it("is never cancelled", () => {
      expect(on(going, [...begun, cancelRequested], 2)).toBe("RunSteps Finally f@1");
      expect(on(going, [...begun, ...finallyFails("f", true), cancelRequested], 2)).toBe(
        "RunSteps Finally f@2",
      );
    });

    it("ends the run with the main result, or flags it if any cleanup failed for good", () => {
      const all = (first: Facts): Facts => [...first, ...finallyOk("f"), ...finallyOk("g")];
      expect(on(going, all(begun))).toBe("EndRun RunSucceeded");
      expect(on(going, all([runStarted, ...fails("a", false), mainFailed("Skip")]))).toBe(
        "EndRun RunFailed",
      );
      expect(on(going, all([runStarted, ...fails("a", false), mainFailed("Run")]))).toBe(
        "EndRun RunFailed",
      );
      expect(on(going, all([runStarted, cancelRequested, mainCancelled]))).toBe(
        "EndRun RunCancelled",
      );
      expect(on(going, [...begun, ...finallyFails("f", false), ...finallyOk("g")])).toBe(
        "EndRun RunFlaggedForAttention",
      );
      expect(
        on(going, [
          ...begun,
          ...finallyFails("f", true),
          ...finallyOk("f", { attempt: 2 }),
          ...finallyOk("g"),
        ]),
      ).toBe("EndRun RunSucceeded");
    });

    it("ends a run with no finally steps straight from the undo phase", () => {
      const bare = planOf(
        recipe({
          start: "a",
          nodes: [step("a", "t.undoable"), step("b", "t.act")],
          edges: chain("a", "b"),
        }),
        generatedCatalog,
      );
      const facts: Facts = [runStarted, ...ok("a"), ...fails("b", false), mainFailed("Run")];
      expect(on(bare, facts)).toBe("RunUndo a@1 with t.act");
      expect(on(bare, [...facts, ...undone("a")])).toBe("EndRun RunFailed");
      expect(on(bare, [...facts, undoStarted("a"), undoFailed("a")])).toBe(
        "EndRun RunFlaggedForAttention",
      );
      expect(on(bare, [runStarted, ...ok("a"), ...ok("b"), mainSucceeded])).toBe(
        "EndRun RunSucceeded",
      );
    });
  });
});
