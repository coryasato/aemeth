import { Result, Schema } from "effect";
import { RunEvent } from "./RunEvent";
import type { RunState } from "./RunState";
import { replay } from "./transition";

// The written form of a finished run in the archive (decision 0004, M2 decision 29): its whole
// log, the events in order, as a JSON array. Defined once here, for the engine that writes it
// and for the check that reads it back (M2 decision 13).

const Log = Schema.fromJsonString(Schema.Array(RunEvent));
const encodeLog = Schema.encodeSync(Log);
const decodeLog = Schema.decodeUnknownResult(Log, { onExcessProperty: "error" });

/** A run's whole log as the archive holds it. */
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
