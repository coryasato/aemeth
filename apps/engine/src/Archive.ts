import type { RunId, RunState } from "@aemeth/core";
import { replay, RunEvent } from "@aemeth/core";
import { Context, Result, Schema } from "effect";
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

const Log = Schema.fromJsonString(Schema.Array(RunEvent));
const encodeLog = Schema.encodeSync(Log);
const decodeLog = Schema.decodeUnknownResult(Log, { onExcessProperty: "error" });

/** A run's whole log as the archive holds it: the events, in order, as JSON. */
export const archiveText = (events: ReadonlyArray<RunEvent>): string => encodeLog(events);

/**
 * The state an archived log replays to, through the same `transition` the engine used, or why
 * it does not: the text is not a log, or `transition` refuses one of its events.
 */
export const replayArchive = (text: string): Result.Result<RunState, string> => {
  const events = decodeLog(text);
  if (Result.isFailure(events)) {
    return Result.fail(String(events.failure));
  }
  return Result.mapError(replay(events.success), (rejected) => JSON.stringify(rejected));
};
