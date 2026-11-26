import type { RunId } from "@aemeth/core";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

/** The archive could not be written or read. Nothing says the object is there. */
export class ArchiveFailed extends Schema.TaggedError<
  ArchiveFailed,
  { readonly brand: unique symbol }
>()("ArchiveFailed", { message: Schema.String }) {}

/**
 * Where finished runs are kept outside the objects that produced them (decision 0004): one
 * object per run, written once.
 */
export class Archive extends Context.Service<
  Archive,
  {
    /**
     * Writes the object if nothing is at its key, and says whether it wrote. An object already
     * there is left as it is: the first write is the archive.
     */
    readonly putOnce: (key: string, text: string) => Effect.Effect<boolean, ArchiveFailed>;
    readonly get: (key: string) => Effect.Effect<string | undefined, ArchiveFailed>;
  }
>()("@aemeth/engine/Archive") {}

/** Where a run's log is archived. */
export const archiveKey = (runId: RunId): string => `runs/${runId}.json`;

export { archiveText, replayArchive } from "@aemeth/core";
