import type { Option } from "effect";
import type {
  BlockInput,
  BlockKind,
  BlockSpec,
  BlockSpecProblem,
  Lifetime,
  UndoSource,
} from "../BlockSpec";
import type { DataType } from "../DataType";
import type { BlockId, Name, StepId, Version } from "../ids";
import type { EdgeTarget, InvariantRef, LiteralValue, Outcome, Recipe, Step } from "../Recipe";

/** The caps of M1 decision 11, in one place so the builder can show them. */
export type Limits = {
  readonly nodes: number;
  readonly edgesIntoNode: number;
  readonly paths: number;
};

export const limits: Limits = { nodes: 64, edgesIntoNode: 8, paths: 10_000 };

/** Where in a recipe document something was found. */
export type Place =
  | { readonly _tag: "Start" }
  | { readonly _tag: "Finally" }
  | { readonly _tag: "Edge"; readonly from: StepId; readonly on: Outcome }
  | { readonly _tag: "Input"; readonly step: StepId; readonly input: Name }
  | { readonly _tag: "ForEachOver"; readonly step: StepId }
  | { readonly _tag: "Invariant"; readonly index: number; readonly rule: InvariantRef["rule"] };

/** Stage 2: what is wrong with a recipe's shape, before any type or path is looked at. */
export type StructureError =
  | { readonly _tag: "DuplicateStepId"; readonly step: StepId }
  | { readonly _tag: "UnknownStep"; readonly step: StepId; readonly at: Place }
  | { readonly _tag: "UnknownRecipeInput"; readonly name: Name; readonly at: Place }
  | {
      readonly _tag: "UnknownStepOutput";
      readonly step: StepId;
      readonly output: Name;
      readonly at: Place;
    }
  | {
      readonly _tag: "UnknownBlock";
      readonly step: StepId;
      readonly block: BlockId;
      readonly version: Version;
    }
  | {
      readonly _tag: "UnknownUndoBlock";
      readonly step: StepId;
      readonly block: BlockId;
      readonly version: Version;
    }
  | {
      readonly _tag: "UndoBlockIsGate";
      readonly step: StepId;
      readonly block: BlockId;
      readonly version: Version;
    }
  /** Two declarations in the catalog share an id and a version. Reported once per extra one. */
  | { readonly _tag: "DuplicateBlock"; readonly block: BlockId; readonly version: Version }
  /** The step an invariant calls its gate is not a gate. */
  | { readonly _tag: "InvariantGateIsNotGate"; readonly step: StepId; readonly at: Place }
  | {
      /** Reported once per block and problem, however many steps use the block. */
      readonly _tag: "BlockInconsistent";
      readonly block: BlockId;
      readonly version: Version;
      readonly problem: BlockSpecProblem;
    }
  | { readonly _tag: "UnknownBlockInput"; readonly step: StepId; readonly input: Name }
  | { readonly _tag: "StartIsFinally"; readonly step: StepId }
  | { readonly _tag: "Unreachable"; readonly step: StepId }
  | { readonly _tag: "FinallyStepHasEdge"; readonly step: StepId }
  | { readonly _tag: "FinallyStepRepeated"; readonly step: StepId }
  | { readonly _tag: "FinallyStepUsesStepOutput"; readonly step: StepId; readonly at: Place }
  | { readonly _tag: "FinallyStepIsGate"; readonly step: StepId }
  | { readonly _tag: "ForEachGate"; readonly step: StepId }
  | { readonly _tag: "DuplicateEdge"; readonly from: StepId; readonly on: Outcome }
  | {
      readonly _tag: "OutcomeDoesNotFitKind";
      readonly from: StepId;
      readonly on: Outcome;
      readonly kind: BlockKind;
    }
  | { readonly _tag: "ForEachItemOutsideForEach"; readonly at: Place };

/** Stage 3: the recipe is larger than the caps allow. */
export type SizeError =
  | { readonly _tag: "TooManyNodes"; readonly count: number; readonly cap: number }
  | {
      readonly _tag: "TooManyEdgesInto";
      readonly step: StepId;
      readonly count: number;
      readonly cap: number;
    };

/** One step of a main path and how it ended, as far as an edge is concerned. */
export type Hop = { readonly step: StepId; readonly outcome: Outcome };

/** Stage 5: a value does not fit where it is sent, or is not there on every path. */
export type WiringError =
  | { readonly _tag: "RequiredInputNotBound"; readonly step: StepId; readonly input: Name }
  | {
      readonly _tag: "TypeMismatch";
      readonly at: Place;
      readonly expected: DataType;
      readonly actual: DataType;
    }
  | {
      readonly _tag: "LiteralDoesNotFit";
      readonly step: StepId;
      readonly input: Name;
      readonly expected: DataType;
    }
  | { readonly _tag: "ForEachOverNotList"; readonly step: StepId; readonly actual: DataType }
  | {
      readonly _tag: "ForEachOverNotAllowed";
      readonly step: StepId;
      readonly binding: "Literal" | "OptionalStepOutput";
    }
  | { readonly _tag: "OptionalOutputOutsideFinally"; readonly step: StepId; readonly input: Name }
  | { readonly _tag: "OptionalOutputIntoRequired"; readonly step: StepId; readonly input: Name }
  | {
      /** `path` leads from `start` to the step at `at` without `producer` having succeeded. */
      readonly _tag: "OutputNotGuaranteed";
      readonly at: Place;
      readonly producer: StepId;
      readonly path: ReadonlyArray<Hop>;
    }
  | { readonly _tag: "UndoInputUnknown"; readonly step: StepId; readonly input: Name }
  | { readonly _tag: "UndoInputNotFed"; readonly step: StepId; readonly input: Name }
  | { readonly _tag: "UndoOptionalIntoRequired"; readonly step: StepId; readonly input: Name }
  | {
      readonly _tag: "UndoTypeMismatch";
      readonly step: StepId;
      readonly input: Name;
      readonly expected: DataType;
      readonly actual: DataType;
    }
  | {
      /**
       * The undo block changes something its step did not: it writes what the step neither wrote
       * nor created, or destroys what the step did not create.
       */
      readonly _tag: "UndoChangesUntouched";
      readonly step: StepId;
      readonly input: Name;
    };

/** Whether the producing block declares that it creates this output, and for how long. */
export type Created = Lifetime | "NotCreated";

/** A binding whose target was found, with the type it carries. */
export type ResolvedBinding =
  | { readonly _tag: "RecipeInput"; readonly name: Name; readonly type: DataType }
  | {
      readonly _tag: "StepOutput";
      readonly step: StepId;
      readonly output: Name;
      /** A list when the producing step is a for-each. */
      readonly type: DataType;
      readonly created: Created;
    }
  | {
      readonly _tag: "OptionalStepOutput";
      readonly step: StepId;
      readonly output: Name;
      readonly type: DataType;
      readonly created: Created;
    }
  | { readonly _tag: "ForEachItem" }
  | { readonly _tag: "Literal"; readonly value: LiteralValue };

export type ResolvedInput = {
  readonly input: Name;
  readonly spec: BlockInput;
  readonly binding: ResolvedBinding;
};

export type ResolvedUndo = {
  readonly block: BlockSpec;
  readonly inputs: { readonly [name: Name]: UndoSource };
};

export type ResolvedForEach = {
  readonly over: Exclude<ResolvedBinding, { readonly _tag: "ForEachItem" }>;
  readonly onItemFailure: "Stop" | "Continue";
};

/** A step with everything it names looked up. */
export type ResolvedStep = {
  readonly step: Step;
  readonly track: "Main" | "Finally";
  readonly block: BlockSpec;
  readonly undo: Option.Option<ResolvedUndo>;
  /** One entry per input the step binds. */
  readonly inputs: ReadonlyArray<ResolvedInput>;
  readonly forEach: Option.Option<ResolvedForEach>;
};

/** Where an edge leads, with its step looked up. */
export type Target =
  | { readonly _tag: "Step"; readonly step: ResolvedStep }
  | Exclude<EdgeTarget, { readonly _tag: "Step" }>;

/** What stage 2 hands on: a recipe in which every name resolves. */
export type ResolvedRecipe = {
  readonly recipe: Recipe;
  readonly start: ResolvedStep;
  /** The main-path steps, in document order. */
  readonly main: ReadonlyArray<ResolvedStep>;
  /** The `finally` steps, in the order they run. */
  readonly finally: ReadonlyArray<ResolvedStep>;
  /** Where each step goes on each outcome it has an edge for. */
  readonly edges: ReadonlyMap<StepId, ReadonlyMap<Outcome, Target>>;
};

/** The outcomes a block of this kind can end with. */
export const outcomesOf = (kind: BlockKind): readonly [Outcome, Outcome] =>
  kind === "Gate" ? ["Approved", "Denied"] : ["Succeeded", "Failed"];

/** Whether an outcome lets the next step rely on this step's outputs. */
export const isSuccess = (outcome: Outcome): boolean =>
  outcome === "Succeeded" || outcome === "Approved";

/** Whether a block declares that it creates one of its outputs, and for how long. */
export const createdAs = (block: BlockSpec, output: Name): Created =>
  block.effects.flatMap((effect) =>
    effect._tag === "Creates" && effect.output === output ? [effect.lifetime] : [],
  )[0] ?? "NotCreated";
