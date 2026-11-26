import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";
import {
  logOf,
  mainSucceeded,
  runStarted,
  runSucceeded,
  stepStarted,
  stepSucceeded,
} from "../testing/events";
import { archiveText, replayArchive } from "./archive";

const succeeded = logOf([
  runStarted,
  stepStarted("a"),
  stepSucceeded("a"),
  mainSucceeded,
  runSucceeded,
]);

const failureOf = (text: string): string => {
  const replayed = replayArchive(text);
  return Result.isFailure(replayed) ? replayed.failure : `replayed to ${replayed.success._tag}`;
};

describe("the archive's written form", () => {
  it("is the log as a JSON array, and replays to the state the log ends in", () => {
    const text = archiveText(succeeded);
    expect(JSON.parse(text)).toMatchObject(
      succeeded.map((event) => ({ _tag: event._tag, seq: event.seq, runId: event.runId })),
    );
    const replayed = Result.getOrThrow(replayArchive(text));
    expect(replayed._tag).toBe("Succeeded");
    expect(replayed._tag === "Succeeded" && replayed.run.runId).toBe("run1");
  });

  it("replays a log cut short to the state it was in", () => {
    expect(Result.getOrThrow(replayArchive(archiveText(succeeded.slice(0, 3))))._tag).toBe(
      "Running",
    );
  });

  it("does not replay text that is not a log", () => {
    expect(failureOf("not json")).not.toMatch(/^replayed/u);
    expect(failureOf("{}")).not.toMatch(/^replayed/u);
    // An event with a field the schema does not know is not an event.
    const extra = JSON.stringify([{ ...JSON.parse(archiveText(succeeded))[0], extra: 1 }]);
    expect(failureOf(extra)).not.toMatch(/^replayed/u);
  });

  it("does not replay a log that `transition` refuses, and says which event", () => {
    // The step's success before its start.
    const text = archiveText(logOf([runStarted, stepSucceeded("a")]));
    const failure = failureOf(text);
    expect(failure).not.toMatch(/^replayed/u);
    expect(JSON.parse(failure)).toMatchObject({ _tag: "EventRejected" });
  });
});
