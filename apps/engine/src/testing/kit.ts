import type { Block, BlockInputs, BlockOutputs, StepContext } from "@aemeth/blocks";
import { BlockFailed, implement, Secrets } from "@aemeth/blocks";
import type { BlockSpec, EventRejected, RunEvent, RunId, RunState } from "@aemeth/core";
import { followsRecipe, validate } from "@aemeth/core";
import {
  block,
  creates,
  database,
  exampleOf,
  generatedCatalog,
  integer,
  list,
  optional,
  reads,
  required,
  resource,
  struct,
  text,
} from "@aemeth/core/testing";
import { Context, Effect, Layer, Option, Result, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { WorkflowEngine } from "effect/workflow";
import type { Engine } from "../Engine";
import { layer as engineLayer, Waker } from "../Engine";
import type { Fact, RunNotFound } from "../RunLog";
import { layerMemory, RunLog } from "../RunLog";
import { RunWorkflow, RunWorkflowLayer } from "../RunWorkflow";
import { Blocks, BlockServices, offer, Recipes, secretsOffer } from "../services";

// What the engine's tests run on: the real driver, log and workflow, on the in-memory workflow
// engine, with blocks whose outcomes a test scripts. Nothing here is infrastructure.

/** One execution of a fake block: what it was given and which work it was. */
export type Execution = {
  readonly block: string;
  readonly step: StepContext;
  readonly inputs: BlockInputs;
};

/** How a fake block behaves when it is run. */
type Behaviour = (execution: Execution) => Effect.Effect<BlockOutputs, BlockFailed>;

/**
 * The service every fake block does its work through. It is offered to blocks like any other, so
 * a fake block that did not declare it would not get it.
 */
export class Stage extends Context.Service<
  Stage,
  {
    readonly perform: (
      block: string,
      inputs: BlockInputs,
    ) => Effect.Effect<BlockOutputs, BlockFailed>;
  }
>()("@aemeth/engine/testing/Stage") {}

/** A service the engine offers that no fake block declares. */
class Unlisted extends Context.Service<Unlisted, { readonly touch: Effect.Effect<void> }>()(
  "@aemeth/engine/testing/Unlisted",
) {}

/** A service some block declares and this engine does not offer. */
class Unoffered extends Context.Service<Unoffered, { readonly touch: Effect.Effect<void> }>()(
  "@aemeth/engine/testing/Unoffered",
) {}

const exported = resource("test.export");

/** The declarations the tests add to core's generated catalog. */
const extraSpecs = {
  export: block("t.export", {
    inputs: { database: required(database) },
    outputs: { export: exported },
    effects: [reads("database"), creates("export", "Expiring")],
    undo: { _tag: "NoUndo", reason: "It expires by itself." },
  }),
  import: block("t.import", { inputs: { export: required(exported) }, effects: [reads("export")] }),
  report: block("t.report", {
    inputs: { copies: optional(list(database)), made: optional(database) },
  }),
  // A gate that approves a list and a note: what was approved is part of its answer.
  choose: block("t.choose", {
    kind: "Gate",
    outputs: { chosen: list(database), note: struct({ reason: text, count: integer }) },
  }),
  sneaky: block("t.sneaky"),
  needy: block("t.needy"),
};

const fake = (spec: BlockSpec): Block =>
  implement({
    spec,
    uses: [Stage],
    run: (inputs) => Effect.flatMap(Stage, (stage) => stage.perform(spec.id, inputs)),
  });

/** The secret an export hands to an import: the test's stand-in for a signed download link. */
export const secretLink = "https://export.example/signed?token=do-not-log-me";

const blocks: ReadonlyArray<Block> = [
  ...generatedCatalog.map(fake),
  fake(extraSpecs.report),
  fake(extraSpecs.choose),
  // Stores a secret and returns a handle that names it.
  implement({
    spec: extraSpecs.export,
    uses: [Stage, Secrets],
    run: (inputs) =>
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const stage = yield* Stage;
        yield* stage.perform(extraSpecs.export.id, inputs);
        yield* secrets.put("export", secretLink);
        return { export: { kind: "test.export", id: "export" } };
      }),
  }),
  // Reads the secret back, and fails if it is not there.
  implement({
    spec: extraSpecs.import,
    uses: [Stage, Secrets],
    run: (inputs) =>
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const stage = yield* Stage;
        const link = yield* secrets.get("export");
        if (Option.isNone(link)) {
          return yield* new BlockFailed({
            reason: "ExportExpired",
            message: "No link.",
            retryable: false,
          });
        }
        return yield* stage.perform(`${extraSpecs.import.id} ${link.value}`, inputs);
      }),
  }),
  // Declares no service, and looks in the context it runs in for what it was not given: a
  // service the engine offers to other blocks, and the engine's own. The types forbid requiring
  // them, so it asks by key, as a block bent on it would. It dies saying what it found.
  implement({
    spec: extraSpecs.sneaky,
    uses: [],
    run: () =>
      Effect.flatMap(Effect.context<never>(), (context) => {
        const found = [
          Unlisted,
          RunLog,
          Blocks,
          BlockServices,
          Recipes,
          Waker,
          WorkflowEngine.WorkflowEngine,
        ].flatMap((service) => (context.mapUnsafe.has(service.key) ? [service.key] : []));
        return Effect.andThen(
          Option.match(Context.getOption(context, Unlisted), {
            onNone: () => Effect.void,
            onSome: (unlisted) => unlisted.touch,
          }),
          Effect.die(new Error(`found ${JSON.stringify(found)}`)),
        );
      }),
  }),
  implement({
    spec: extraSpecs.needy,
    uses: [Unoffered],
    run: () =>
      Effect.as(
        Effect.flatMap(Unoffered, (unoffered) => unoffered.touch),
        {},
      ),
  }),
];

const specs: ReadonlyArray<BlockSpec> = blocks.map((each) => each.spec);

/** A span as the tests read it. */
type RecordedSpan = Pick<Tracer.Span, "name" | "attributes" | "status">;

type Appending = Effect.Effect<RunEvent, EventRejected | RunNotFound>;

/** What a test holds of the engine it runs on. */
export type Kit = {
  /** Every execution of a fake block so far, in order. */
  readonly executions: Array<Execution>;
  /** Every span started so far. */
  readonly spans: Array<RecordedSpan>;
  /** How many times the engine's `Unlisted` service was reached: it never should be. */
  touched: number;
  /** What fake blocks do. The default succeeds with outputs that fit the block's declaration. */
  behaviour: Behaviour;
  /** Wraps every append the engine makes: a test can do something first, or instead. */
  onAppend: (fact: Fact, key: string, append: Appending) => Appending;
  /** How many wakes to lose before one is let through. */
  wakesToLose: number;
  /** How many wakes the engine has asked for, lost or not. */
  wakes: number;
  /** The recipe documents a run can be started from. */
  readonly recipes: Map<string, unknown>;
};

/** Outputs that fit the block's declaration, with two items in every list. */
export const fitting = (blockId: string): BlockOutputs => {
  const spec = specs.find((candidate) => candidate.id === blockId.split(" ")[0]);
  return spec === undefined
    ? {}
    : Object.fromEntries(
        Object.entries(spec.outputs).map(([name, type]) => [name, exampleOf(type, 2)]),
      );
};

export const failWith = (reason: string, retryable = false): Effect.Effect<never, BlockFailed> =>
  Effect.fail(new BlockFailed({ reason, message: `${reason} happened.`, retryable }));

const makeKit = (): Kit => ({
  executions: [],
  spans: [],
  touched: 0,
  behaviour: ({ block: blockId }) => Effect.succeed(fitting(blockId)),
  onAppend: (_fact, _key, append) => append,
  wakesToLose: 0,
  wakes: 0,
  recipes: new Map(),
});

const layerOf = (kit: Kit) => {
  const tracer = Tracer.make({
    span: (options) => {
      const span = Tracer.nativeTracer.span(options);
      kit.spans.push(span);
      return span;
    },
  });
  const log = Layer.effect(RunLog)(
    Effect.map(RunLog, (base) =>
      RunLog.of({
        ...base,
        // Asked each time the append runs, so a hook can treat a second run differently.
        append: (runId, fact, key) =>
          Effect.suspend(() => kit.onAppend(fact, key, base.append(runId, fact, key))),
      }),
    ),
  ).pipe(Layer.provide(layerMemory));
  const services = Layer.effect(BlockServices)(
    Effect.map(secretsOffer, (secrets) =>
      BlockServices.of({
        offers: [
          secrets,
          offer(Stage, (step) =>
            Effect.succeed(
              Stage.of({
                perform: (blockId, inputs) => {
                  const execution = { block: blockId, step, inputs };
                  kit.executions.push(execution);
                  return kit.behaviour(execution);
                },
              }),
            ),
          ),
          offer(Unlisted, () =>
            Effect.succeed(
              Unlisted.of({
                touch: Effect.sync(() => {
                  kit.touched += 1;
                }),
              }),
            ),
          ),
        ],
      }),
    ),
  );
  const waker = Layer.effect(Waker)(
    Effect.map(Waker, (base) =>
      Waker.of({
        wake: (runId, step) => {
          kit.wakes += 1;
          if (kit.wakesToLose > 0) {
            kit.wakesToLose -= 1;
            return Effect.void;
          }
          return base.wake(runId, step);
        },
      }),
    ),
  ).pipe(Layer.provide(Waker.layer));
  const recipes = Layer.succeed(
    Recipes,
    Recipes.of({ find: (id) => Effect.sync(() => kit.recipes.get(id)) }),
  );
  return Layer.mergeAll(engineLayer, RunWorkflowLayer).pipe(
    Layer.provideMerge(Layer.mergeAll(waker, services)),
    Layer.provideMerge(Layer.mergeAll(log, Blocks.layer(blocks), recipes)),
    Layer.provideMerge(WorkflowEngine.layerMemory),
    Layer.provideMerge(Layer.succeed(Tracer.Tracer, tracer)),
  );
};

/**
 * Lets every fiber that can run do so: the run goes on in fibers of its own. A millisecond of
 * real time, since the test clock stands still.
 */
const breathe = TestClock.withLive(Effect.sleep("1 millis"));

/** Gives the run time to do whatever it is going to do without the clock moving. */
export const settle = Effect.repeat(breathe, { times: 20 });

const isFinal = (state: RunState): boolean =>
  state._tag === "Succeeded" ||
  state._tag === "Failed" ||
  state._tag === "Cancelled" ||
  state._tag === "NeedsAttention";

/** The run's log once `done` holds of it. Fails the test if it never does. */
export const logWhen = (
  runId: RunId,
  done: (state: RunState, events: ReadonlyArray<RunEvent>) => boolean,
) =>
  Effect.gen(function* () {
    const log = yield* RunLog;
    for (let tries = 0; tries < 400; tries += 1) {
      const { events, state } = yield* log.read(runId);
      if (done(state, events)) {
        return events;
      }
      yield* breathe;
    }
    const { events, state } = yield* log.read(runId);
    return yield* Effect.die(
      new Error(
        `The run stayed ${state._tag} after ${events.map((event) => event._tag).join(", ")}`,
      ),
    );
  });

/** The run's log once it waits at a gate. */
export const waiting = (runId: RunId) =>
  logWhen(runId, (state) => state._tag === "WaitingForApproval");

/**
 * The run's log once it has ended, with every retry's delay waited out on the test clock. The
 * finished log must follow its recipe: `followsRecipe` is asked of every run the tests finish.
 */
export const finished = (runId: RunId) =>
  Effect.gen(function* () {
    const log = yield* RunLog;
    const registry = yield* Blocks;
    for (let tries = 0; tries < 400; tries += 1) {
      const { events, state } = yield* log.read(runId);
      if (isFinal(state)) {
        const valid = Result.getOrThrow(validate(yield* log.recipe(runId), registry.specs));
        const followed = followsRecipe(valid, events);
        if (Result.isFailure(followed)) {
          return yield* Effect.die(
            new Error(`The run left its recipe: ${JSON.stringify(followed.failure)}`),
          );
        }
        return events;
      }
      yield* breathe;
      yield* TestClock.adjust("1 minute");
    }
    const { events, state } = yield* log.read(runId);
    return yield* Effect.die(
      new Error(
        `The run stayed ${state._tag} after ${events.map((event) => event._tag).join(", ")}`,
      ),
    );
  });

/** How the run's workflow ended, if it has: `Stuck` with the reason when the engine gave up. */
export const workflowOutcome = (runId: RunId) =>
  Effect.gen(function* () {
    yield* breathe;
    const executionId = yield* RunWorkflow.executionId({ runId });
    const result = yield* RunWorkflow.poll(executionId);
    if (Option.isNone(result) || result.value._tag !== "Complete") {
      return "Running";
    }
    const { exit } = result.value;
    if (exit._tag === "Success") {
      return "Complete";
    }
    const stuck = exit.cause.reasons.flatMap((reason) =>
      reason._tag === "Fail" ? [reason.error.reason] : [],
    );
    return `Stuck: ${stuck.join(", ")}`;
  });

/** `"StepStarted a@1"`, `"UndoStarted e#2@1"`, `"MainPhaseEnded Failed Run"`: an event on one line. */
export const brief = (event: RunEvent): string => {
  switch (event._tag) {
    case "StepStarted":
    case "StepSucceeded":
    case "StepFailed":
    case "UndoStarted":
    case "UndoSucceeded":
    case "UndoFailed": {
      const item = event.item === undefined ? "" : `#${event.item}`;
      const error =
        event._tag === "StepFailed" || event._tag === "UndoFailed"
          ? ` ${event.error.name}${event.retryable ? " retryable" : ""}`
          : "";
      return `${event._tag} ${event.step}${item}@${event.attempt}${error}`;
    }
    case "GateOpened":
    case "ApprovalGranted":
    case "ApprovalDenied": {
      return `${event._tag} ${event.step}`;
    }
    case "MainPhaseEnded": {
      const undo = event.main.result === "Failed" ? ` ${event.main.undo}` : "";
      return `${event._tag} ${event.main.result}${undo}`;
    }
    case "RunStarted":
    case "CancellationRequested":
    case "RunSucceeded":
    case "RunFailed":
    case "RunCancelled":
    case "RunFlaggedForAttention": {
      return event._tag;
    }
  }
};

const workOf = (key: unknown, attempt: unknown) => `${String(key)} @${String(attempt)}`;

/**
 * The tracing rail (M2, "Tracing"): every execution of a block is one span, opened and closed
 * around it, that names the work. Checked at the end of every test that runs on the kit.
 */
const everyExecutionHasItsSpan = (kit: Kit): void => {
  const executed = kit.executions
    .map(({ step }) => workOf(step.idempotencyKey, step.attempt))
    .toSorted();
  const traced = kit.spans
    .filter((span) => span.name.startsWith("block "))
    .map((span) =>
      workOf(span.attributes.get("aemeth.idempotencyKey"), span.attributes.get("aemeth.attempt")),
    );
  const untraced = executed.filter((work) => !traced.includes(work));
  if (untraced.length > 0 || traced.length < executed.length) {
    throw new Error(
      `Blocks ran without a span each: ${untraced.join(", ")} (${traced.length} spans for ${executed.length} executions)`,
    );
  }
};

/**
 * Runs a test on an engine of its own. The test gets the kit to script blocks and read what
 * happened, and the engine's services to drive it.
 */
export const withEngine = <A, E>(
  test: (kit: Kit) => Effect.Effect<A, E, Engine | RunLog | Blocks | WorkflowEngine.WorkflowEngine>,
): Effect.Effect<A, E> => {
  const kit = makeKit();
  return test(kit).pipe(
    Effect.tap(() => Effect.sync(() => everyExecutionHasItsSpan(kit))),
    Effect.provide(layerOf(kit)),
  );
};
