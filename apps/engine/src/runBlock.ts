import type { Block, BlockInputs, BlockOutputs, StepContext } from "@aemeth/blocks";
import type { StepInputs } from "@aemeth/core";
import { namesOf, Outputs, own, StepError, valueFits } from "@aemeth/core";
import { Context, Effect, Option, Schema } from "effect";
import type { Offer } from "./services";
import { BlockServices } from "./services";

/** How one execution of a block ended. A failure is a value here: the log records it. */
export const BlockResult = Schema.Union([
  Schema.TaggedStruct("Succeeded", { outputs: Outputs }),
  Schema.TaggedStruct("Failed", { error: StepError, retryable: Schema.Boolean }),
]).annotate({ identifier: "BlockResult" });
export type BlockResult = typeof BlockResult.Type;

const errorName = /^[A-Z][a-zA-Z0-9]{0,63}$/u;
const maxMessageLength = 2000;

/** A failure the engine found, or one a block reported, in the form the log takes. */
const failed = (name: string, message: string, retryable = false): BlockResult => ({
  _tag: "Failed",
  // A name or a message the log could not hold must not stop the failure from being recorded.
  error: {
    name: errorName.test(name) ? name : "BlockFailed",
    message: message.slice(0, maxMessageLength),
  },
  retryable,
});

type Split =
  | { readonly _tag: "Ready"; readonly inputs: BlockInputs }
  | { readonly _tag: "Missing"; readonly input: string };

/** The inputs as the block takes them: required ones bare, optional ones as an `Option`. */
const split = (block: Block, inputs: StepInputs): Split => {
  const required: { [name: string]: Schema.Json } = {};
  const optional: { [name: string]: Option.Option<Schema.Json> } = {};
  for (const [name, spec] of namesOf(block.spec.inputs)) {
    const value = own(inputs, name) ?? Option.none();
    if (spec._tag === "Optional") {
      optional[name] = value;
    } else if (Option.isSome(value)) {
      required[name] = value.value;
    } else {
      return { _tag: "Missing", input: name };
    }
  }
  return { _tag: "Ready", inputs: { required, optional } };
};

/** What the block returned, if every declared output is there, fits its type, and nothing else is. */
const checked = (block: Block, outputs: BlockOutputs): BlockResult => {
  const declared = namesOf(block.spec.outputs);
  const wrong = [
    ...declared.flatMap(([name, type]) => {
      const value = own(outputs, name);
      return value !== undefined && valueFits(type, value) ? [] : [name];
    }),
    ...Object.keys(outputs).filter((name) => !Object.hasOwn(block.spec.outputs, name)),
  ];
  if (wrong.length > 0) {
    return failed(
      "OutputTypeMismatch",
      `${block.spec.id} returned outputs that do not fit its declaration: ${wrong.join(", ")}.`,
    );
  }
  return {
    _tag: "Succeeded",
    outputs: Object.fromEntries(declared.map(([name]) => [name, own(outputs, name) ?? null])),
  };
};

/** Whose services a block is never handed: the engine's own, and the workflow engine's. */
const withheld = ["@aemeth/engine/", "effect/workflow/"];

/**
 * The context a block's code runs in, before its declared services are added: everything of the
 * runtime's (the clock, the tracer, the span it runs under) and nothing of the engine's. Without
 * this a block could reach the log, or the engine itself, by asking for a service by its key.
 */
const withoutEngine = (ambient: Context.Context<never>): Context.Context<never> =>
  Context.makeUnsafe(
    new Map(
      [...ambient.mapUnsafe].filter(
        ([key]: readonly [string, unknown]) => !withheld.some((prefix) => key.startsWith(prefix)),
      ),
    ),
  );

/** The services a block declared, made for this step, or the first one nothing offers. */
const servicesFor = (block: Block, offers: ReadonlyArray<Offer>, step: StepContext) =>
  Effect.gen(function* () {
    let services = Context.empty();
    for (const key of block.uses) {
      const offered = offers.find((candidate) => candidate.key === key);
      if (offered === undefined) {
        return Option.none<Context.Context<never>>();
      }
      services = Context.merge(services, yield* offered.provide(step));
    }
    return Option.some(services);
  });

/**
 * Runs a block once: hands it its inputs and the services it declared, and turns whatever
 * happens into a result. The block's own execution is one trace span (M2, "Tracing").
 *
 * A block reaches the outside world only through the services it lists: the engine's own
 * services are taken out of its context, and the offered ones it did not list are never put in.
 * Requiring one anyway is a defect, recorded as a failure that is not retried.
 */
export const runBlock = (
  block: Block,
  inputs: StepInputs,
  step: StepContext,
): Effect.Effect<BlockResult, never, BlockServices> =>
  Effect.gen(function* () {
    const { offers } = yield* BlockServices;
    const ready = split(block, inputs);
    if (ready._tag === "Missing") {
      return failed(
        "InputMissing",
        `Required input ${ready.input} of ${block.spec.id} has no value.`,
      );
    }
    const services = yield* servicesFor(block, offers, step);
    if (Option.isNone(services)) {
      return failed(
        "ServiceNotOffered",
        `${block.spec.id} uses a service this engine does not offer.`,
      );
    }
    return yield* block.run(ready.inputs, step, services.value).pipe(
      Effect.updateContext(withoutEngine),
      Effect.map((outputs) => checked(block, outputs)),
      Effect.catch((error) => Effect.succeed(failed(error.reason, error.message, error.retryable))),
      Effect.catchDefect((defect) => Effect.succeed(failed("BlockDefect", String(defect)))),
      Effect.withSpan(`block ${block.spec.id}`, {
        attributes: {
          "aemeth.run": step.runId,
          "aemeth.step": step.step,
          "aemeth.item": Option.getOrUndefined(step.item),
          "aemeth.phase": step.phase,
          "aemeth.attempt": step.attempt,
          "aemeth.idempotencyKey": step.idempotencyKey,
          "aemeth.block": `${block.spec.id}@${block.spec.version}`,
        },
      }),
    );
  });
