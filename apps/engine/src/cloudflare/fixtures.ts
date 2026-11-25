import type { Block } from "@aemeth/blocks";
import { implement, Secrets } from "@aemeth/blocks";
import { BlockSpec, RunId } from "@aemeth/core";
import { Duration, Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { Archive, archiveKey } from "../Archive";
import { RunIndex, RunRow } from "../RunIndex";

// What a stage that is thrown away carries besides the real blocks and recipes: two fake blocks
// and a recipe of them, so the integration tests can take a run through a gate, a deploy and a
// kill without touching anything real. `staging` and `production` do not have them.

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

/** The recipes of a stage that is thrown away, by id. */
export const fixtureRecipes: ReadonlyArray<{ readonly id: string }> = [gatedRecipe];

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
 * Two routes that exist only on a stage that is thrown away, so a test can see what the engine
 * keeps outside a run's log, and try to write over it:
 *
 * - `GET /test/runs/:id/record`: the run's row in the index, and the text of its archive.
 * - `POST /test/runs/:id/archive`: writes the request's body to the run's archive key as the
 *   engine would, and says whether anything was written.
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
    if (runs !== "runs" || Option.isNone(runId) || rest.length > 0) {
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
