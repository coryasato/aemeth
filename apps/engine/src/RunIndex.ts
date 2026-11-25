import { RecipeRef, RunId } from "@aemeth/core";
import type { Effect } from "effect";
import { Context, Schema } from "effect";

/** The index could not be written or read. */
export class IndexFailed extends Schema.TaggedError<
  IndexFailed,
  { readonly brand: unique symbol }
>()("IndexFailed", { message: Schema.String }) {}

/** How a run ended, as the index records it: the tag of its final state. */
export const FinalState = Schema.Literals(["Succeeded", "Failed", "Cancelled", "NeedsAttention"]);
export type FinalState = typeof FinalState.Type;

/**
 * A run's row in the index. `result` is what a record block wrote, such as the rows a drill
 * compared; the engine itself never writes it.
 */
export const RunRow = Schema.Struct({
  id: RunId,
  recipe: RecipeRef,
  state: Schema.Union([Schema.Literal("Running"), FinalState]),
  startedAt: Schema.Int,
  endedAt: Schema.NullOr(Schema.Int),
  archiveKey: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.Json),
}).annotate({ identifier: "RunRow" });
export type RunRow = typeof RunRow.Type;

/**
 * The index of runs (decision 0004): one row per run, for listing and for finding a finished
 * run's archive without waking its objects. The log stays the source of truth for a run; the
 * index says only that it started, how it ended and where its archive is.
 */
export class RunIndex extends Context.Service<
  RunIndex,
  {
    /** Records a run that has started. A run already there is left as it is. */
    readonly started: (run: {
      readonly runId: RunId;
      readonly recipe: RecipeRef;
      readonly at: number;
    }) => Effect.Effect<void, IndexFailed>;
    /** Records how a run ended and where its log is archived. */
    readonly ended: (run: {
      readonly runId: RunId;
      readonly state: FinalState;
      readonly at: number;
      readonly archiveKey: string;
    }) => Effect.Effect<void, IndexFailed>;
    readonly find: (runId: RunId) => Effect.Effect<RunRow | undefined, IndexFailed>;
  }
>()("@aemeth/engine/RunIndex") {}
