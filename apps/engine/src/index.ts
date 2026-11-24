import { blockSpecs } from "@aemeth/blocks";
import type { BlockId, Version } from "@aemeth/core";
import { Effect, Result } from "effect";

/** Placeholder until M2: logs the title of the block that would run a step. */
export const announceBlock = (id: BlockId, version: Version): Effect.Effect<string> =>
  Effect.succeed(
    Result.match(blockSpecs, {
      onFailure: () => "the block declarations do not decode",
      onSuccess: (specs) =>
        specs.find((spec) => spec.id === id && spec.version === version)?.title ??
        `unknown block ${id}@${version}`,
    }),
  ).pipe(Effect.tap((title) => Effect.logDebug(title)));
