import { blockLabel } from "@aemeth/blocks";
import type { StepId } from "@aemeth/core";
import { Effect } from "effect";

/** Placeholder until M2: logs the block that would run a step. */
export const announceStep = (id: StepId): Effect.Effect<string> =>
  Effect.succeed(blockLabel(id)).pipe(Effect.tap((label) => Effect.logDebug(label)));
