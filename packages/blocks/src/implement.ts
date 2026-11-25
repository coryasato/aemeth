import type {
  AttemptNumber,
  BlockSpec,
  IdempotencyKey,
  ItemIndex,
  KeyPhase,
  RunId,
  StepId,
} from "@aemeth/core";
import type { Option } from "effect";
import { Context, Effect, Schema } from "effect";

// The contract between a block's code and the engine that runs it (M2). A declaration says what
// a block is; an implementation is the code beside it.

/**
 * How a block fails. `reason` is the typed error's name, such as `RunTagMismatch`, which the log
 * records as the error's `name`, and `retryable` says the same work may be tried again. A block
 * never throws: anything else it does wrong is the engine's to record, as a failure that is not
 * retried.
 */
export class BlockFailed extends Schema.TaggedError<
  BlockFailed,
  { readonly brand: unique symbol }
>()("BlockFailed", {
  reason: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

/**
 * Which piece of work a block is doing. Every attempt of the same work, and every run of one
 * attempt after a crash, has the same `idempotencyKey`: a block uses it so that doing the work
 * twice has one effect.
 */
export type StepContext = {
  readonly runId: RunId;
  readonly step: StepId;
  /** The place of a for-each item in its list. */
  readonly item: Option.Option<ItemIndex>;
  /** `Undo` when the block runs as another step's undo. */
  readonly phase: KeyPhase;
  readonly attempt: AttemptNumber;
  readonly idempotencyKey: IdempotencyKey;
};

/**
 * What a block is given, in the written form of values. A `Required` input is always there. An
 * `Optional` one is `None` when the step does not bind it or its source produced nothing.
 */
export type BlockInputs = {
  readonly required: { readonly [name: string]: Schema.Json };
  readonly optional: { readonly [name: string]: Option.Option<Schema.Json> };
};

/** What a block returns, by output name. The engine checks each against its declared type. */
export type BlockOutputs = { readonly [name: string]: Schema.Json };

/**
 * A block the engine can run: its declaration, the keys of the services it uses, and its code
 * with those services still to be handed over.
 */
export type Block = {
  readonly spec: BlockSpec;
  readonly uses: ReadonlyArray<string>;
  readonly run: (
    inputs: BlockInputs,
    step: StepContext,
    services: Context.Context<never>,
  ) => Effect.Effect<BlockOutputs, BlockFailed>;
};

// The one place a service's types are not spelled out: any service may be declared.
// oxlint-disable-next-line typescript/no-explicit-any
type AnyService = Context.Key<any, any>;

/**
 * Makes a block from its declaration and its code. `uses` lists the services the code reaches the
 * outside world through, and `run` is typed to need exactly those: code that uses a service it
 * does not list does not compile. The engine then provides the listed services and no others.
 */
export const implement = <const Uses extends ReadonlyArray<AnyService>>(options: {
  readonly spec: BlockSpec;
  readonly uses: Uses;
  readonly run: (
    inputs: BlockInputs,
    step: StepContext,
  ) => Effect.Effect<BlockOutputs, BlockFailed, Context.Service.Identifier<Uses[number]>>;
}): Block => ({
  spec: options.spec,
  uses: options.uses.map((service) => service.key),
  run: (inputs, step, services) =>
    Effect.provideContext(
      options.run(inputs, step),
      // The engine builds `services` from `uses`, so it holds what `run` needs. The types of the
      // services were given up when the block joined a list of blocks of every kind.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      services as Context.Context<Context.Service.Identifier<Uses[number]>>,
    ),
});

/**
 * Holds what one block must hand to a later one and nobody else may read, such as an export's
 * download link (M2 decision 16). A secret belongs to its run, is in no event, and is deleted
 * when the run ends. The block's output names it: `{ kind, id: <name> }`.
 */
export class Secrets extends Context.Service<
  Secrets,
  {
    readonly put: (name: string, value: string) => Effect.Effect<void>;
    readonly get: (name: string) => Effect.Effect<Option.Option<string>>;
  }
>()("@aemeth/blocks/Secrets") {}
