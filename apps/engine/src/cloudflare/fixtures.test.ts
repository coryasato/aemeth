import { Secrets } from "@aemeth/blocks";
import type { StepContext } from "@aemeth/blocks";
import { idempotencyKey, RunId, StepId, validateDocument } from "@aemeth/core";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Option, Result, Schema } from "effect";
import { fixtureBlocks, fixtureRecipes, gatedRecipe } from "./fixtures";

const runId = Schema.decodeSync(RunId)("run-1");
const work = Schema.decodeSync(StepId)("work");

describe("the fixtures of a stage that is thrown away", () => {
  it.effect("the recipe passes the validator against the fake blocks", () =>
    Effect.gen(function* () {
      const blocks = yield* fixtureBlocks;
      const result = validateDocument(
        gatedRecipe,
        blocks.map((block) => block.spec),
      );
      expect(Result.isFailure(result) ? JSON.stringify(result.failure) : "valid").toBe("valid");
      expect(fixtureRecipes.map((recipe) => recipe.id)).toEqual(["test-gated"]);
    }),
  );

  it.effect("the work block says how many times the same attempt was run", () =>
    Effect.gen(function* () {
      const blocks = yield* fixtureBlocks;
      const block = blocks.find((each) => each.spec.id === "test.work");
      const kept = new Map<string, string>();
      const services = Context.make(
        Secrets,
        Secrets.of({
          put: (name, value) => Effect.sync(() => void kept.set(name, value)),
          get: (name) => Effect.sync(() => Option.fromUndefinedOr(kept.get(name))),
        }),
      );
      const step = (attempt: number): StepContext => ({
        runId,
        step: work,
        item: Option.none(),
        phase: "Forward",
        attempt,
        idempotencyKey: idempotencyKey(runId, work, "Forward", undefined),
      });
      const run = (attempt: number) =>
        block === undefined
          ? Effect.die(new Error("no test.work"))
          : block.run({ required: {}, optional: { for: Option.some(0) } }, step(attempt), services);
      expect(block?.uses).toEqual([Secrets.key]);
      expect(yield* run(1)).toEqual({ executions: 1 });
      // The Worker died during the first execution: the same attempt runs again.
      expect(yield* run(1)).toEqual({ executions: 2 });
      // A retry is another attempt, and counts for itself.
      expect(yield* run(2)).toEqual({ executions: 1 });
    }),
  );
});
