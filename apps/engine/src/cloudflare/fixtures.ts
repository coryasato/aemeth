import type { Block, StepContext } from "@aemeth/blocks";
import { BlockFailed, D1Api, D1Failed, implement, Secrets } from "@aemeth/blocks";
import { BlockSpec, Recipe, RunId } from "@aemeth/core";
import { recipeFiles } from "@aemeth/recipes";
import { Context, Duration, Effect, Option, Schedule, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { Archive, archiveKey } from "../Archive";
import { RunIndex, RunRow } from "../RunIndex";

// What a stage that is thrown away carries besides the real blocks and recipes: two fake blocks
// and a recipe of them, so the integration tests can take a run through a gate, a deploy and a
// kill without touching anything real; and the restore drill with a gate in front and a fault a
// test sets for the run (M2 Part D, D3). `staging` and `production` do not have them.

const declarations = [
  {
    id: "test.work",
    version: 1,
    title: "Wait, and count how often this work was run",
    kind: "Action",
    inputs: { for: { _tag: "Optional", type: { _tag: "Duration" } } },
    outputs: { executions: { _tag: "Integer" } },
    effects: [],
    undo: { _tag: "NothingToUndo" },
    rerun: "SafeWithIdempotencyKey",
  },
  {
    id: "test.gate",
    version: 1,
    title: "Wait for a person",
    kind: "Gate",
    inputs: {},
    outputs: {},
    effects: [],
    undo: { _tag: "NothingToUndo" },
    rerun: "SafeWithIdempotencyKey",
  },
] as const;

const decodeSpecs = Schema.decodeUnknownEffect(Schema.Tuple([BlockSpec, BlockSpec]), {
  onExcessProperty: "error",
});

/**
 * `work` waits as long as the run was told to, a gate, then `after`. `work` is slow enough to be
 * killed partway, and says in its output how many times it took to finish.
 */
export const gatedRecipe = {
  format: 1,
  id: "test-gated",
  version: 1,
  title: "A slow step, a gate and a step after it",
  description: "For the integration tests of a stage that is thrown away. It touches nothing.",
  start: "work",
  inputs: { workFor: { type: { _tag: "Duration" } } },
  nodes: [
    {
      _tag: "Step",
      id: "work",
      block: "test.work",
      version: 1,
      inputs: { for: { _tag: "RecipeInput", name: "workFor" } },
    },
    { _tag: "Step", id: "ok", block: "test.gate", version: 1, inputs: {} },
    { _tag: "Step", id: "after", block: "test.work", version: 1, inputs: {} },
  ],
  edges: [
    { from: "work", on: "Succeeded", to: { _tag: "Step", id: "ok" } },
    { from: "ok", on: "Approved", to: { _tag: "Step", id: "after" } },
  ],
  finally: [],
  invariants: [],
} as const;

const decodeRecipe = Schema.decodeUnknownEffect(Recipe, { onExcessProperty: "error" });

/**
 * The restore drill with a gate, `hold`, in front: a test sets the run's fault while the run
 * waits there, so the fault is in place before the first step. Made from the recipe file, so it
 * is the drill as deployed.
 */
export const heldDrill: Effect.Effect<Recipe> = Effect.gen(function* () {
  const drill = yield* decodeRecipe(recipeFiles.find((each) => each.id === "restore-drill"));
  return yield* decodeRecipe({
    ...drill,
    id: "test-drill",
    version: 1,
    title: "The restore drill, held at a gate first",
    description: "For the integration tests of a stage that is thrown away.",
    start: "hold",
    nodes: [
      { _tag: "Step", id: "hold", block: "test.gate", version: 1, inputs: {} },
      ...drill.nodes,
    ],
    edges: [
      { from: "hold", on: "Approved", to: { _tag: "Step", id: drill.start } },
      ...drill.edges,
    ],
  });
}).pipe(Effect.orDie);

/** The recipes of a stage that is thrown away, by id. */
export const fixtureRecipes: Effect.Effect<ReadonlyArray<{ readonly id: string }>> = Effect.map(
  heldDrill,
  (drill) => [gatedRecipe, drill],
);

/**
 * What a test makes a run of the drill do, on a stage that is thrown away (M2 Part D, D3):
 *
 * - `Fail`: the step fails for good, before its block does anything.
 * - `Kill`: the step's block does its work, then holds, once, until the test releases the run
 *   (`POST /test/runs/:id/release`) or twenty minutes pass: the test kills it there with a
 *   deploy, and the step runs again after the restart without holding.
 * - `WriteBeforeExport`: a row is written to the database between the export's first figures
 *   and the export, once. Only a stage's sample database is given to these runs: the write is
 *   the test's, and the declaration of `d1.exportDatabase` is not changed for it.
 * - `LoseCreate`: every create of the temporary database makes it, or finds it made, and then
 *   answers as if Cloudflare were away.
 */
export const Fault = Schema.Union([
  Schema.TaggedStruct("Fail", { step: Schema.String }),
  Schema.TaggedStruct("Kill", { step: Schema.String }),
  Schema.TaggedStruct("WriteBeforeExport", {}),
  Schema.TaggedStruct("LoseCreate", {}),
]);
export type Fault = typeof Fault.Type;

const decodeFault = Schema.decodeUnknownEffect(Schema.fromJsonString(Fault));

/** Where a test's marks for a run are kept, in the stage's archive bucket, beside no run's log. */
const markKey = (runId: string, what: string): string => `test/${runId}/${what}`;

/** What a test asks about a step of a run with a fault: how often its block ran, and whether it held. */
export const StepMarks = Schema.Struct({ executions: Schema.Int, held: Schema.Boolean });

/** The longest a block is run again under one test: enough for any kill the suite makes. */
const mostExecutions = 10;

/** Counts one more execution of the step's block, as the first key not yet written. */
const counted = (archive: Archive["Service"], step: StepContext) =>
  Effect.gen(function* () {
    for (let execution = 1; execution <= mostExecutions; execution += 1) {
      if (yield* archive.putOnce(markKey(step.runId, `executions/${step.step}/${execution}`), "")) {
        return;
      }
    }
  });

const testFailure = (message: string) =>
  new BlockFailed({ reason: "TestFaultUnreadable", message, retryable: true });

/** The bucket was away while the test's fault wrote: as Cloudflare being away, tried again. */
const away = (error: { readonly message: string }) =>
  new D1Failed({ reason: "Unavailable", operation: "test", message: error.message });

/** The D1 API as the fault has it for this step: changed only for the two faults of the API. */
const d1Under = (
  fault: Fault,
  api: D1Api["Service"],
  archive: Archive["Service"],
  step: StepContext,
): D1Api["Service"] => {
  if (fault._tag === "WriteBeforeExport") {
    return D1Api.of({
      ...api,
      exportDatabase: (database) =>
        Effect.gen(function* () {
          const wrote = yield* archive
            .get(markKey(step.runId, "wrote"))
            .pipe(Effect.mapError(away));
          // Marked only once the row is there, so a write that failed is tried again; the row's
          // key is the run's, so a second write after a lost mark changes nothing.
          if (wrote === undefined) {
            yield* api.query(
              database,
              "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
              [`written-during-${step.runId}`, "a write between the first figures and the export"],
            );
            yield* archive.putOnce(markKey(step.runId, "wrote"), "").pipe(Effect.mapError(away));
          }
          return yield* api.exportDatabase(database);
        }),
    });
  }
  if (fault._tag === "LoseCreate") {
    return D1Api.of({
      ...api,
      create: (name) =>
        api.create(name).pipe(
          Effect.catchIf(
            (error) => error.reason === "AlreadyExists",
            () => Effect.void,
          ),
          Effect.andThen(
            Effect.fail(
              new D1Failed({
                reason: "Unavailable",
                operation: "create",
                message: "The test lost the answer.",
              }),
            ),
          ),
        ),
    });
  }
  return api;
};

/**
 * The drill's blocks as a stage that is thrown away runs them: each reads the fault a test set
 * for its run, if any, and does what it says. A run with no fault runs the blocks as they are.
 */
export const faultyDrill = (
  blocks: ReadonlyArray<Block>,
  archive: Archive["Service"],
): ReadonlyArray<Block> =>
  blocks.map((block): Block => ({
    ...block,
    run: (inputs, step, services) =>
      Effect.gen(function* () {
        const text = yield* archive
          .get(markKey(step.runId, "fault"))
          .pipe(Effect.mapError((error) => testFailure(error.message)));
        if (text === undefined) {
          return yield* block.run(inputs, step, services);
        }
        const fault = yield* decodeFault(text).pipe(
          Effect.mapError(() => testFailure("The test's fault does not decode.")),
        );
        if (fault._tag === "Fail" && fault.step === step.step) {
          return yield* new BlockFailed({
            reason: "PlantedFault",
            message: `The test failed ${step.step}.`,
            retryable: false,
          });
        }
        const killed = fault._tag === "Kill" && fault.step === step.step;
        if (killed) {
          yield* counted(archive, step).pipe(
            Effect.mapError((error) => testFailure(error.message)),
          );
        }
        const given = Option.match(Context.getOption(services, D1Api), {
          onNone: () => services,
          onSome: (api) => Context.add(services, D1Api, d1Under(fault, api, archive, step)),
        });
        const outputs = yield* block.run(inputs, step, given);
        if (killed) {
          const first = yield* archive
            .putOnce(markKey(step.runId, `held/${step.step}`), "")
            .pipe(Effect.mapError((error) => testFailure(error.message)));
          if (first) {
            yield* archive.get(markKey(step.runId, "released")).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (released) => released !== undefined,
              }),
              Effect.timeout("20 minutes"),
              Effect.ignore,
            );
          }
        }
        return outputs;
      }),
  }));

/**
 * The fake blocks. `test.work` counts its executions in the run's secrets before it waits, so a
 * second execution of the same attempt, after the Worker was killed during the first, returns 2:
 * the log shows one attempt, and the output shows that the block ran twice.
 */
export const fixtureBlocks: Effect.Effect<ReadonlyArray<Block>> = Effect.gen(function* () {
  // The declarations are written a few lines above: one that does not decode is a defect.
  const [work, gate] = yield* Effect.orDie(decodeSpecs(declarations));
  return [
    implement({
      spec: work,
      uses: [Secrets],
      run: (inputs, step) =>
        Effect.gen(function* () {
          const secrets = yield* Secrets;
          const name = `executions/${step.idempotencyKey}/${step.attempt}`;
          const before = Number(Option.getOrElse(yield* secrets.get(name), () => "0"));
          yield* secrets.put(name, String(before + 1));
          const millis = Option.getOrNull(inputs.optional["for"] ?? Option.none());
          yield* Effect.sleep(Duration.millis(typeof millis === "number" ? millis : 0));
          return { executions: before + 1 };
        }),
    }),
    // A gate has no code: the engine opens it and waits.
    implement({ spec: gate, uses: [], run: () => Effect.succeed({}) }),
  ];
});

const decodeRunId = Schema.decodeUnknownOption(RunId);

/** What `GET /test/runs/:id/record` answers with: the run's row in the index and its archive. */
export const RecordResponse = Schema.Struct({
  row: Schema.NullOr(RunRow),
  archive: Schema.NullOr(Schema.String),
});

/**
 * Routes that exist only on a stage that is thrown away, so a test can see what the engine
 * keeps outside a run's log, try to write over it, and set a run's fault:
 *
 * - `GET /test/runs/:id/record`: the run's row in the index, and the text of its archive.
 * - `POST /test/runs/:id/archive`: writes the request's body to the run's archive key as the
 *   engine would, and says whether anything was written.
 * - `POST /test/runs/:id/fault`: sets the run's `Fault`, once.
 * - `POST /test/runs/:id/release`: lets a step held by `Kill` go on.
 * - `GET /test/runs/:id/steps/:step`: the `StepMarks` of a step of a run with a fault.
 */
export const fixtureApi = (
  method: string,
  segments: ReadonlyArray<string>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  Archive | RunIndex | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const [, runs, id, what, ...rest] = segments;
    const runId = decodeRunId(id);
    const [step, ...beyond] = rest;
    if (
      method === "GET" &&
      runs === "runs" &&
      what === "steps" &&
      Option.isSome(runId) &&
      step !== undefined &&
      beyond.length === 0
    ) {
      const archive = yield* Archive;
      const marked = (key: string) =>
        Effect.map(archive.get(markKey(runId.value, key)), (found) => found !== undefined);
      let executions = 0;
      while (
        executions < mostExecutions &&
        (yield* marked(`executions/${step}/${executions + 1}`))
      ) {
        executions += 1;
      }
      return yield* HttpServerResponse.schemaJson(StepMarks)({
        executions,
        held: yield* marked(`held/${step}`),
      });
    }
    if (runs !== "runs" || Option.isNone(runId) || rest.length > 0 || beyond.length > 0) {
      return HttpServerResponse.jsonUnsafe({ error: "NotFound" }, { status: 404 });
    }
    const archive = yield* Archive;
    const index = yield* RunIndex;
    const key = archiveKey(runId.value);
    if (method === "GET" && what === "record") {
      const row = yield* index.find(runId.value);
      const text = yield* archive.get(key);
      return yield* HttpServerResponse.schemaJson(RecordResponse)({
        row: row ?? null,
        archive: text ?? null,
      });
    }
    if (method === "POST" && what === "fault") {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text;
      const fault = yield* Effect.option(decodeFault(text));
      if (Option.isNone(fault)) {
        return HttpServerResponse.jsonUnsafe({ error: "NotAFault" }, { status: 400 });
      }
      const written = yield* archive.putOnce(markKey(runId.value, "fault"), text);
      return HttpServerResponse.jsonUnsafe({ written });
    }
    if (method === "POST" && what === "release") {
      const written = yield* archive.putOnce(markKey(runId.value, "released"), "");
      return HttpServerResponse.jsonUnsafe({ written });
    }
    if (method === "POST" && what === "archive") {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const written = yield* archive.putOnce(key, yield* request.text);
      return HttpServerResponse.jsonUnsafe({ written });
    }
    return HttpServerResponse.jsonUnsafe({ error: "NotFound" }, { status: 404 });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: "Failed", detail: String(cause) }, { status: 500 }),
      ),
    ),
  );
