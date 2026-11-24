import { Schema } from "effect";
import type { BlockSpec } from "../BlockSpec";
import type { Recipe } from "../Recipe";
import {
  block,
  creates,
  database,
  destroys,
  each,
  edge,
  failed,
  fromInput,
  fromRecipe,
  item,
  list,
  maybeFromStep,
  noUndo,
  optional,
  reads,
  recipe,
  required,
  step,
  succeeded,
  undoWith,
  writes,
} from "./build";

// Recipes for property tests, built constructively from a list of numbers: `Arbitrary.filter`
// stalls on anything that rejects small values (M1 Part A findings), so nothing is filtered.
// Every edge goes from a lower to a higher node, which makes the graph acyclic by construction;
// a cycle, when asked for, is one extra edge back to an ancestor.

/** The numbers a recipe is built from. Each choice takes the next one, modulo its options. */
export const Picks = Schema.Array(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9999 })),
).check(Schema.isMinLength(64), Schema.isMaxLength(64));

export const generatedCatalog: ReadonlyArray<BlockSpec> = [
  block("t.act"),
  block("t.check", { kind: "Check" }),
  block("t.gate", { kind: "Gate" }),
  block("t.undoable", { undo: undoWith("t.act") }),
  block("t.each", {
    inputs: { thing: required(database) },
    effects: [writes("thing")],
    undo: undoWith("t.uneach", { thing: fromInput("thing") }),
  }),
  block("t.uneach", {
    inputs: { thing: required(database) },
    effects: [writes("thing")],
    undo: noUndo,
  }),
  block("t.eachPlain", { inputs: { thing: required(database) }, effects: [reads("thing")] }),
  block("t.make", {
    outputs: { database },
    effects: [creates("database", "Temporary")],
    undo: noUndo,
  }),
  block("t.write", {
    inputs: { target: required(database) },
    effects: [writes("target")],
    undo: noUndo,
  }),
  block("t.drop", {
    inputs: { database: optional(database) },
    effects: [destroys("database")],
    undo: noUndo,
  }),
];

const kinds = [
  "Plain",
  "Check",
  "Gate",
  "Undoable",
  "Each",
  "EachPlain",
  "Make",
  "Write",
  "Drop",
] as const;
/** What a main-path step can be. `Drop` is only for `finally` steps. */
const mainKinds = kinds.filter((kind) => kind !== "Drop");
type Kind = (typeof kinds)[number];

const blockOf: Record<Kind, string> = {
  Plain: "t.act",
  Check: "t.check",
  Gate: "t.gate",
  Undoable: "t.undoable",
  Each: "t.each",
  EachPlain: "t.eachPlain",
  Make: "t.make",
  Write: "t.write",
  Drop: "t.drop",
};

type GeneratedStep = {
  readonly id: string;
  readonly kind: Kind;
  readonly isGate: boolean;
  readonly isForEach: boolean;
  readonly hasUndo: boolean;
};

export type Generated = {
  readonly recipe: Recipe;
  readonly main: ReadonlyArray<GeneratedStep>;
  readonly finally: ReadonlyArray<string>;
};

const describe = (id: string, kind: Kind): GeneratedStep => ({
  id,
  kind,
  isGate: kind === "Gate",
  isForEach: kind === "Each" || kind === "EachPlain",
  hasUndo: kind === "Undoable" || kind === "Each",
});

const node = ({ id, isForEach, kind }: GeneratedStep, policy: number, made: string) => {
  if (isForEach) {
    return step(
      id,
      blockOf[kind],
      { thing: item },
      each(fromRecipe("things"), policy === 0 ? "Stop" : "Continue"),
    );
  }
  if (kind === "Write") {
    return step(id, blockOf[kind], { target: fromRecipe("target") });
  }
  return kind === "Drop"
    ? step(id, blockOf[kind], { database: maybeFromStep(made, "database") })
    : step(id, blockOf[kind]);
};

/**
 * A recipe of one to `maxNodes` main-path steps and up to two `finally` steps that passes every
 * stage up to the paths. Its steps may break the always-on rules, and it asserts up to three
 * rules of its own that it may break too, so the invariants have something to find. With `cycle`,
 * the last step also has an edge back to itself or to one of its ancestors.
 */
export const generate = (
  picks: ReadonlyArray<number>,
  options: { readonly cycle: boolean; readonly maxNodes?: number } = { cycle: false },
): Generated => {
  let cursor = 0;
  const next = (choices: number): number => {
    const pick = picks[cursor % picks.length] ?? 0;
    cursor += 1;
    return pick % choices;
  };
  const choose = <A>(from: ReadonlyArray<A>, fallback: A): A => from[next(from.length)] ?? fallback;

  const count = 1 + next(options.maxNodes ?? 6);
  const main = Array.from({ length: count }, (_, index) =>
    describe(`n${index}`, choose(mainKinds, "Plain")),
  );
  const free = main.map((generated) =>
    generated.isGate ? ["Approved", "Denied"] : ["Succeeded", "Failed"],
  );
  const take = (from: number, slot: string): void => {
    free[from] = (free[from] ?? []).filter((outcome) => outcome !== slot);
  };
  const edges: Array<ReturnType<typeof edge>> = [];
  const parent: Array<number> = [0];

  // A tree first, so every step is reached from `n0`.
  for (let index = 1; index < count; index += 1) {
    const candidates = free.flatMap((slots, from) =>
      from < index && slots.length > 0 ? [from] : [],
    );
    const from = choose(candidates, 0);
    const slot = choose(free[from] ?? [], "Succeeded");
    take(from, slot);
    parent[index] = from;
    edges.push(edge(`n${from}`, slot, `n${index}`));
  }

  if (options.cycle) {
    const last = count - 1;
    const ancestors = [last];
    for (let at = last; at !== 0; at = parent[at] ?? 0) {
      ancestors.push(parent[at] ?? 0);
    }
    const slot = choose(free[last] ?? [], "Failed");
    take(last, slot);
    edges.push(edge(`n${last}`, slot, `n${choose(ancestors, last)}`));
  }

  // Then the outcomes still free: left to the default, sent to an explicit end, or joined to a
  // later step.
  for (const [from, slots] of free.entries()) {
    for (const slot of slots) {
      const choice = next(6);
      const later = count - 1 - from;
      if (choice === 2 && (slot === "Succeeded" || slot === "Approved")) {
        edges.push(edge(`n${from}`, slot, succeeded));
      } else if (choice === 3) {
        edges.push(edge(`n${from}`, slot, failed(next(2) === 0 ? "Run" : "Skip")));
      } else if (choice >= 4 && later > 0) {
        edges.push(edge(`n${from}`, slot, `n${from + 1 + next(later)}`));
      }
    }
  }

  // A `finally` step may destroy what the first `Make` step created, if there is one.
  const made = main.find((generated) => generated.kind === "Make")?.id;
  const finallyKinds: ReadonlyArray<Kind> =
    made === undefined ? ["Plain", "EachPlain"] : ["Plain", "EachPlain", "Drop"];
  const last = Array.from({ length: next(3) }, (_, index) =>
    describe(`f${index}`, choose(finallyKinds, "Plain")),
  );

  const anyStep = () => choose(main, describe("n0", "Plain")).id;
  const rules = [
    () => ({ rule: "RequiredForSuccess", step: anyStep() }),
    () => ({ rule: "AfterFailure", step: anyStep(), then: anyStep() }),
    () => ({ rule: "OnlyAfter", step: last[0]?.id ?? anyStep(), requires: [anyStep()] }),
    () => ({ rule: "OnlyAfter", step: last[1]?.id ?? anyStep(), requires: [last[0]?.id ?? "n0"] }),
    () => ({ rule: "NeverWritten", input: "things" }),
    () => ({ rule: "NoWriteBeforeApproval", input: "target" }),
    () => ({ rule: "CleanedUp", step: made ?? "n0", output: "database" }),
  ];
  const invariants = Array.from({ length: next(4) }, () =>
    choose(rules, () => ({ rule: "NeverWritten", input: "things" }))(),
  ).filter((invariant) => invariant.rule !== "CleanedUp" || made !== undefined);

  return {
    recipe: recipe({
      start: "n0",
      inputs: { things: { type: list(database) }, target: { type: database } },
      nodes: [...main, ...last].map((generated) => node(generated, next(2), made ?? "n0")),
      edges,
      finally: last.map((generated) => generated.id),
      invariants,
    }),
    main,
    finally: last.map((generated) => generated.id),
  };
};
