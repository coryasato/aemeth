import { RunId } from "@aemeth/core";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { makeRunId } from "./index";

describe("makeRunId", () => {
  it.effect("is 26 lower-case letters and digits, and a run id", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_795_000_000_000);
      const ids = yield* Effect.forEach(Array.from({ length: 50 }), () => makeRunId);
      for (const id of ids) {
        expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/u);
        expect(Schema.is(RunId)(id)).toBe(true);
      }
      expect(new Set(ids).size).toBe(50);
    }),
  );

  it.effect("sorts by the time it was made", () =>
    Effect.gen(function* () {
      const at = (time: number) => Effect.andThen(TestClock.setTime(time), makeRunId);
      const made = yield* Effect.forEach(
        [0, 1, 31, 32, 1_795_000_000_000, 1_795_000_000_001, 2 ** 48 - 1],
        at,
      );
      expect(made.toSorted()).toEqual(made);
      // Ten characters of time, 32 to the place: worked out by hand at the edges.
      const edges = yield* Effect.forEach([0, 1, 31, 32, 2 ** 48 - 1], at);
      expect(edges.map((id) => id.slice(0, 10))).toEqual([
        "0000000000",
        "0000000001",
        "000000000z",
        "0000000010",
        "7zzzzzzzzz",
      ]);
    }),
  );
});
