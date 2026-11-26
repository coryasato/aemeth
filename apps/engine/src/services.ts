import type { Block, StepContext } from "@aemeth/blocks";
import { D1Api, RecordUnavailable, RunRecord, Secrets } from "@aemeth/blocks";
import type { BlockId, BlockSpec, Version } from "@aemeth/core";
import { Context, Duration, Effect, Layer } from "effect";
import { RunIndex } from "./RunIndex";
import { RunLog } from "./RunLog";

/**
 * The blocks this engine can run. A recipe is validated against their declarations, so a run
 * never reaches a step whose block has no code here.
 */
export class Blocks extends Context.Service<
  Blocks,
  {
    readonly specs: ReadonlyArray<BlockSpec>;
    readonly find: (id: BlockId, version: Version) => Block | undefined;
  }
>()("@aemeth/engine/Blocks") {
  static readonly layer = (blocks: ReadonlyArray<Block>): Layer.Layer<Blocks> =>
    Layer.succeed(
      Blocks,
      Blocks.of({
        specs: blocks.map((block) => block.spec),
        find: (id, version) =>
          blocks.find((block) => block.spec.id === id && block.spec.version === version),
      }),
    );
}

/**
 * The recipe documents a run can be started from, by id. In M2 these are the files bundled with
 * the Worker. A run keeps the document it started with (M2 decision 17), so this is read once
 * per run.
 */
export class Recipes extends Context.Service<
  Recipes,
  { readonly find: (id: string) => Effect.Effect<unknown> }
>()("@aemeth/engine/Recipes") {}

/**
 * One service the engine offers to blocks, made for the step that is about to run. A block gets
 * it only if its implementation lists it in `uses`.
 */
export type Offer = {
  readonly key: string;
  readonly provide: (step: StepContext) => Effect.Effect<Context.Context<never>>;
};

/** Offers a service to the blocks that declare it. */
export const offer = <Identifier, Shape>(
  service: Context.Key<Identifier, Shape>,
  make: (step: StepContext) => Effect.Effect<Shape>,
): Offer => ({
  key: service.key,
  provide: (step) => Effect.map(make(step), (made) => Context.make(service, made)),
});

/** Every service a block can be given. Nothing else of the engine's reaches a block. */
export class BlockServices extends Context.Service<
  BlockServices,
  { readonly offers: ReadonlyArray<Offer> }
>()("@aemeth/engine/BlockServices") {}

/** A run's secrets, kept in its log outside the events (M2 decision 16). */
export const secretsOffer: Effect.Effect<Offer, never, RunLog> = Effect.map(RunLog, (log) =>
  offer(Secrets, ({ runId }) =>
    Effect.succeed(
      Secrets.of({
        // A step runs only for a run whose log exists.
        put: (name, value) => Effect.orDie(log.putSecret(runId, name, value)),
        get: (name) => Effect.orDie(log.secret(runId, name)),
      }),
    ),
  ),
);

/** The run's row in the index, for a record block (M2, "Persistence"). */
export const runRecordOffer: Effect.Effect<Offer, never, RunIndex> = Effect.map(RunIndex, (index) =>
  offer(RunRecord, ({ runId }) =>
    Effect.succeed(
      RunRecord.of({
        write: (result) =>
          index
            .record({ runId, result })
            .pipe(Effect.mapError((error) => new RecordUnavailable({ message: error.message }))),
      }),
    ),
  ),
);

/** Cloudflare's D1 API, for the drill's blocks, with the engine's own token (M2 decision 12). */
export const d1Offer = (api: D1Api["Service"]): Offer => offer(D1Api, () => Effect.succeed(api));

/**
 * How often a step, a `finally` step or an undo is tried, and how long the engine waits before
 * each further attempt (M2 decision 9). A recipe cannot change it yet.
 */
export const retryPolicy = {
  maxAttempts: 3,
  delays: [Duration.seconds(5), Duration.seconds(30)],
} as const;

/** The wait before an attempt: none before the first. */
export const delayBefore = (attempt: number): Duration.Duration =>
  attempt <= 1
    ? Duration.zero
    : (retryPolicy.delays[Math.min(attempt, retryPolicy.maxAttempts) - 2] ?? Duration.zero);
