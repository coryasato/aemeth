import type { Block, BlockInputs, BlockOutputs, StepContext } from "@aemeth/blocks";
import { BlockFailed, drillBlocks, implement, R2Api, R2Failed, Secrets } from "@aemeth/blocks";
import type { FakeD1 } from "@aemeth/blocks/testing";
import { makeFakeD1 } from "@aemeth/blocks/testing";
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
import { Archive, ArchiveFailed, archiveKey, archiveText, replayArchive } from "../Archive";
import { layer as engineLayer, Waker } from "../Engine";
import type { RunRow } from "../RunIndex";
import { IndexFailed, RunIndex } from "../RunIndex";
import type { Fact, RunNotFound } from "../RunLog";
import { isFinal, layerMemory, RunLog } from "../RunLog";
import { RunWorkflow, RunWorkflowLayer } from "../RunWorkflow";
import {
  Blocks,
  BlockServices,
  d1Offer,
  offer,
  r2Offer,
  Recipes,
  runRecordOffer,
  secretsOffer,
} from "../services";

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
  /** The archive: every object written, by key. */
  readonly archive: Map<string, string>;
  /** How many writes to the archive were asked for, refused or not. */
  archiveWrites: number;
  /** The index of runs, by run id. */
  readonly index: Map<string, RunRow>;
  /** How many of the next writes to the archive or the index fail. */
  recordFaults: number;
  /** How many of the next archive writes are cut off after the object is stored. */
  archiveCuts: number;
  /** Set by a test that leaves a finished run without its archive on purpose. */
  unarchivedOnPurpose: boolean;
  /** The fake D1 API the drill's blocks are given. */
  d1: FakeD1 | undefined;
  /** A step of the drill whose block fails for good, before it does anything. */
  drillFault: string | undefined;
};

/** The name the archive check reads the kit's archive by, over the fake R2 API. */
export const archiveBucket = "aemeth-archive";

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
  archive: new Map(),
  archiveWrites: 0,
  index: new Map(),
  recordFaults: 0,
  archiveCuts: 0,
  unarchivedOnPurpose: false,
  d1: undefined,
  drillFault: undefined,
});

/** Whether this write is one of those a test told to fail. Asked when the write runs. */
const faulted = (kit: Kit): boolean => {
  if (kit.recordFaults <= 0) {
    return false;
  }
  kit.recordFaults -= 1;
  return true;
};

/** The archive in memory, with the rule the bucket has: an object is written once. */
const archiveOf = (kit: Kit) =>
  Layer.succeed(
    Archive,
    Archive.of({
      putOnce: (key, text) =>
        Effect.suspend(() => {
          kit.archiveWrites += 1;
          if (faulted(kit)) {
            return Effect.fail(new ArchiveFailed({ message: "The archive is away." }));
          }
          if (kit.archive.has(key)) {
            return Effect.succeed(false);
          }
          kit.archive.set(key, text);
          if (kit.archiveCuts > 0) {
            // Stored, and then the Worker dies before the workflow hears of it.
            kit.archiveCuts -= 1;
            return Effect.interrupt;
          }
          return Effect.succeed(true);
        }),
      get: (key) => Effect.sync(() => kit.archive.get(key)),
    }),
  );

/** The index in memory. */
const indexOf = (kit: Kit) =>
  Layer.succeed(
    RunIndex,
    RunIndex.of({
      started: ({ runId, recipe, at }) =>
        Effect.suspend(() => {
          if (faulted(kit)) {
            return Effect.fail(new IndexFailed({ message: "The index is away." }));
          }
          if (!kit.index.has(runId)) {
            kit.index.set(runId, {
              id: runId,
              recipe,
              state: "Running",
              startedAt: at,
              endedAt: null,
              archiveKey: null,
              result: null,
            });
          }
          return Effect.void;
        }),
      ended: ({ runId, state, at, archiveKey }) =>
        Effect.suspend(() => {
          const row = kit.index.get(runId);
          if (faulted(kit) || row === undefined) {
            return Effect.fail(new IndexFailed({ message: "The index is away." }));
          }
          kit.index.set(runId, { ...row, state, endedAt: at, archiveKey });
          return Effect.void;
        }),
      record: ({ runId, result }) =>
        Effect.suspend(() => {
          const row = kit.index.get(runId);
          if (faulted(kit) || row === undefined) {
            return Effect.fail(new IndexFailed({ message: "The index is away." }));
          }
          kit.index.set(runId, { ...row, result });
          return Effect.void;
        }),
      find: (runId) => Effect.sync(() => kit.index.get(runId)),
    }),
  );

/**
 * The fake blocks and the drill's real ones. A drill block fails for good, doing nothing, when
 * its step is the kit's `drillFault`: the test-only fault of M2 Part D, D3.
 */
const drillOf = (kit: Kit) =>
  Layer.unwrap(
    Effect.map(drillBlocks, (drill) =>
      Blocks.layer([
        ...blocks,
        ...drill.map((each): Block => ({
          ...each,
          run: (inputs, step, services) =>
            kit.drillFault === step.step
              ? Effect.fail(
                  new BlockFailed({
                    reason: "PlantedFault",
                    message: `The test failed ${step.step}.`,
                    retryable: false,
                  }),
                )
              : each.run(inputs, step, services),
        })),
      ]),
    ),
  );

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
    Effect.gen(function* () {
      const secrets = yield* secretsOffer;
      const record = yield* runRecordOffer;
      const d1 = yield* makeFakeD1;
      kit.d1 = d1;
      return BlockServices.of({
        offers: [
          secrets,
          record,
          d1Offer(d1.api),
          // The archive check reads the engine's own archive, as it does when the stage drills
          // itself; any other bucket is not there.
          r2Offer(
            R2Api.of({
              get: (bucket, key) =>
                bucket === archiveBucket
                  ? Effect.sync(() => Option.fromUndefinedOr(kit.archive.get(key)))
                  : Effect.fail(
                      new R2Failed({
                        reason: "Refused",
                        operation: "get",
                        message: `10006 There is no bucket ${bucket}.`,
                      }),
                    ),
            }),
          ),
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
      });
    }),
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
    Layer.provideMerge(Layer.mergeAll(log, drillOf(kit), recipes, archiveOf(kit), indexOf(kit))),
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

/**
 * The run's row in the index once it says the run has ended, with the clock moved on for the
 * retries of a write that failed. Fails the test if it never does.
 */
export const indexed = (kit: Kit, runId: RunId) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 400; tries += 1) {
      const row = kit.index.get(runId);
      if (row !== undefined && row.state !== "Running") {
        return row;
      }
      yield* breathe;
      yield* TestClock.adjust("5 seconds");
    }
    return yield* Effect.die(new Error(`The index never said that ${runId} ended.`));
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
 * The archive rail (decision 0004): a run whose log has reached a final state has one object in
 * the archive, which is its whole log and replays through `transition` to the state the index
 * records. Checked at the end of every test that runs on the kit, for every run it started.
 */
const everyFinishedRunIsArchived = (kit: Kit) =>
  Effect.gen(function* () {
    const log = yield* RunLog;
    for (const { id } of kit.index.values()) {
      const { events, state } = yield* Effect.orDie(log.read(id));
      if (!isFinal(state)) {
        continue;
      }
      const row = yield* indexed(kit, id);
      const text = kit.archive.get(archiveKey(id));
      const replayed = text === undefined ? undefined : replayArchive(text);
      if (
        text !== archiveText(events) ||
        replayed === undefined ||
        Result.isFailure(replayed) ||
        replayed.success._tag !== row.state ||
        row.state !== state._tag ||
        row.archiveKey !== archiveKey(id) ||
        row.endedAt !== events.at(-1)?.at
      ) {
        return yield* Effect.die(
          new Error(`The archive of ${id} does not match its log: ${JSON.stringify(row)}`),
        );
      }
    }
  });

/**
 * Runs a test on an engine of its own. The test gets the kit to script blocks and read what
 * happened, and the engine's services to drive it.
 */
export const withEngine = <A, E>(
  test: (
    kit: Kit,
  ) => Effect.Effect<
    A,
    E,
    Engine | RunLog | Blocks | Archive | RunIndex | WorkflowEngine.WorkflowEngine
  >,
): Effect.Effect<A, E> => {
  const kit = makeKit();
  return test(kit).pipe(
    Effect.tap(() => Effect.sync(() => everyExecutionHasItsSpan(kit))),
    Effect.tap(() => (kit.unarchivedOnPurpose ? Effect.void : everyFinishedRunIsArchived(kit))),
    Effect.provide(layerOf(kit)),
  );
};
