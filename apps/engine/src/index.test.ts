import { StepId } from "@aemeth/core";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { announceStep } from "./index";

describe("announceStep", () => {
  it.effect("returns the block label", () =>
    Effect.gen(function* () {
      const label = yield* Schema.decodeEffect(StepId)("export").pipe(Effect.flatMap(announceStep));
      expect(label).toBe("block for step export");
    }),
  );
});
