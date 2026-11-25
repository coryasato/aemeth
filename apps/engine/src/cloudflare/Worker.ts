import { recipeFiles } from "@aemeth/recipes";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as AlchemyCloudflareCluster from "@effect/platform-cloudflare/AlchemyCloudflareCluster";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Config, Effect, Layer, Option } from "effect";
import { HttpServerRequest } from "effect/http";
import { api, Caller, pathOf } from "../Api";
import { Archive } from "../Archive";
import { callerOf } from "../caller";
import { layer as engineLayer, Waker } from "../Engine";
import { RunIndex } from "../RunIndex";
import { RunWorkflowLayer } from "../RunWorkflow";
import { Blocks, BlockServices, Recipes, secretsOffer } from "../services";
import { fixtureApi, fixtureBlocks, fixtureRecipes } from "./fixtures";
import type { WithHost } from "./records";
import { archiveOn, indexOn } from "./records";
import { ArchiveBucket, CiToken, currentStage, Index } from "./resources";
import { layerRunLog, RunLogEntity, RunLogEntityLayer } from "./RunLogEntity";

/**
 * What the Worker is deployed with, worked out for the stage (M2, "Deployment").
 *
 * - Access stands in front of every hostname the Worker serves (decision 0006): the owner by
 *   email, read from `AEMETH_OWNER_EMAIL` when the stack is deployed and kept out of the
 *   repository, and the stage's service token.
 * - `staging` and `production` let a busy Durable Object finish on its old code; a stage that is
 *   thrown away takes new code at once, so a test can kill a run mid-step by deploying.
 * - Only a stage that is thrown away carries the fixtures.
 */
const props = Effect.gen(function* () {
  const kept = (yield* currentStage) !== "ThrownAway";
  const token = yield* CiToken;
  const owner = yield* Config.option(Config.String("AEMETH_OWNER_EMAIL"));
  // Changes nothing in the Worker but its text, so that a deploy of the same code is still a
  // deploy: the integration tests deploy under a run to see what a deploy does to it.
  const build = yield* Config.withDefault(Config.String("AEMETH_BUILD"), "0");
  return {
    main: import.meta.url,
    // Tracing through `Cloudflare.Telemetry()` needs 2026-07-28 or later.
    compatibility: { date: "2026-11-01", flags: ["nodejs_compat"] },
    codeUpdateStrategy: kept
      ? // Cloudflare's default, written out: an object that is busy keeps its code this long.
        ({ mode: "deferred", maxDelay: "5 minutes" } as const)
      : ({ mode: "immediate" } as const),
    env: { AEMETH_FIXTURES: kept ? "off" : "on", AEMETH_BUILD: build },
    // Under `alchemy dev` there is no Access: every local request is this person's.
    dev: { access: { aud: "dev", identity: { email: "local@aemeth.invalid" } } },
    access: {
      policies: [
        ...Option.match(owner, {
          onNone: () => [],
          onSome: (email) => [{ decision: "allow" as const, include: [{ email }] }],
        }),
        {
          decision: "non_identity" as const,
          include: [{ serviceToken: token.serviceTokenId }],
        },
      ],
    },
  };
});

/**
 * Who Access says is calling, or `None` if the request did not come through Access. A person has
 * an identity Access can look up; a service token has only the token Access issued for it.
 */
const identity = Effect.gen(function* () {
  const access = yield* Cloudflare.Access.Context;
  if (access === undefined) {
    return Option.none<string>();
  }
  const request = yield* HttpServerRequest.HttpServerRequest;
  const who = yield* access.getIdentity().pipe(Effect.catch(() => Effect.undefined));
  return callerOf({
    aud: access.aud,
    email: who?.email,
    token: request.headers["cf-access-jwt-assertion"],
  });
});

/**
 * The tracer for what runs in the cluster's Durable Objects: the workflow, and so every block.
 * `Cloudflare.Telemetry()` gives each request a tracer of its own, and a block does not run in a
 * request; without this its span would be recorded nowhere (M2, "Tracing").
 *
 * Loaded when the layer is built, which is only ever in the deployed Worker: the module imports
 * `cloudflare:workers`, which does not exist where the stack is planned.
 */
const objectTracer = Layer.unwrap(
  Effect.map(
    Effect.promise(() => import("@effect/platform-cloudflare/CloudflareTracer")),
    (tracer) => tracer.layer,
  ),
);

/**
 * The engine as a Cloudflare Worker (M2 Part C): the API behind Access in front, and behind it
 * the cluster's Durable Objects, a workflow and a log entity per run (decision 0003).
 */
export default class EngineWorker extends Cloudflare.Worker<EngineWorker>()(
  "Engine",
  props,
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.QueryDatabase(Index);
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(ArchiveBucket);

    // A binding call needs the Worker's `RuntimeContext`. A request has one; a workflow's
    // activity does not, so it is read here, once per isolate, and handed to each call. It is
    // absent only while the stack is planned, when nothing below runs.
    const host = yield* Effect.serviceOption(RuntimeContext);
    const withHost: WithHost = (effect) =>
      Option.isSome(host)
        ? Effect.provideService(effect, RuntimeContext, host.value)
        : Effect.die(new Error("A binding was called outside the deployed Worker."));

    const env = yield* Effect.serviceOption(Cloudflare.WorkerEnvironment);
    const fixtures = Option.isSome(env) && env.value["AEMETH_FIXTURES"] === "on";

    const blocks = fixtures ? yield* fixtureBlocks : [];
    const recipes = [...recipeFiles, ...(fixtures ? fixtureRecipes : [])];

    const services = Layer.mergeAll(
      Blocks.layer(blocks),
      Layer.succeed(
        Recipes,
        Recipes.of({ find: (id) => Effect.sync(() => recipes.find((each) => each.id === id)) }),
      ),
      Layer.succeed(Archive, archiveOn(bucket, withHost)),
      Layer.succeed(RunIndex, indexOn(database, withHost)),
      Layer.effect(BlockServices)(
        Effect.map(secretsOffer, (secrets) => BlockServices.of({ offers: [secrets] })),
      ),
    ).pipe(Layer.provideMerge(layerRunLog));

    const cluster = yield* AlchemyCloudflareCluster.make({
      entities: [RunLogEntity],
      layer: Layer.mergeAll(
        RunWorkflowLayer,
        RunLogEntityLayer,
        Layer.provide(engineLayer, Waker.layer),
      ).pipe(Layer.provideMerge(services), Layer.provide(objectTracer)),
    });

    const handler = Effect.gen(function* () {
      const caller = yield* identity;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const segments = pathOf(request.url)
        .split("/")
        .filter((segment) => segment !== "");
      if (fixtures && Option.isSome(caller) && segments[0] === "test") {
        return yield* fixtureApi(request.method, segments);
      }
      return yield* Effect.provideService(
        api,
        Caller,
        Caller.of({ identity: Effect.succeed(caller) }),
      );
    });

    return { fetch: cluster.provide(handler) };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
        // Effect's spans, a block's among them, go into the trace Cloudflare keeps of each
        // invocation (M2, "Tracing").
        Cloudflare.Telemetry(),
      ),
    ),
  ),
) {}
