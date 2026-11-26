import { recipeFiles } from "@aemeth/recipes";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as AlchemyCloudflareCluster from "@effect/platform-cloudflare/AlchemyCloudflareCluster";
import { ALCHEMY_DEV } from "alchemy";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { drillBlocks } from "@aemeth/blocks";
import { Cause, Config, Effect, Layer, Option, Redacted } from "effect";
import { Digest, SecureRandom, Signature } from "effect/crypto";
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Jwks } from "effect/jose";
import { api, Caller, pathOf } from "../Api";
import { Archive } from "../Archive";
import type { AccessCheck } from "../caller";
import { accessCheckOf, callerOf, certsOf } from "../caller";
import { layer as engineLayer, Waker } from "../Engine";
import { makeD1Rest } from "../D1Rest";
import { RunIndex } from "../RunIndex";
import { RunWorkflowLayer } from "../RunWorkflow";
import type { Offer } from "../services";
import { Blocks, BlockServices, d1Offer, Recipes, runRecordOffer, secretsOffer } from "../services";
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
 * - The engine checks every Access token against the keys of the team that issues them
 *   (decision 30), so a deploy needs the team's domain, `AEMETH_ACCESS_TEAM`, such as
 *   `https://aemeth.cloudflareaccess.com`. Without it nothing is deployed. Under `alchemy dev`
 *   there is no Access and no token, and the setting is `local`.
 * - The drill's blocks call Cloudflare's D1 API with a token of the engine's own, with `D1 Write`
 *   and nothing else, separate from the deploy's (decision 0008): `AEMETH_D1_TOKEN`, kept as a
 *   secret of the Worker. A stage deployed without it runs no drill: its blocks are refused the
 *   service and fail.
 */
const props = Effect.gen(function* () {
  const kept = (yield* currentStage) !== "ThrownAway";
  const dev = yield* ALCHEMY_DEV;
  // Alchemy works these props out again inside the deployed Worker, where the deploy's
  // environment is gone: there the Worker reads its own `AEMETH_ACCESS`, and the team is not asked.
  const runtime = globalThis.__ALCHEMY_RUNTIME__ === true;
  const team = dev
    ? "local"
    : Option.getOrElse(yield* Config.option(Config.String("AEMETH_ACCESS_TEAM")), () => "");
  if (!runtime && Option.isNone(accessCheckOf(team))) {
    return yield* Effect.die(
      new Error(
        `AEMETH_ACCESS_TEAM is "${team}". It must be the team's domain, such as https://aemeth.cloudflareaccess.com.`,
      ),
    );
  }
  const token = yield* CiToken;
  const owner = yield* Config.option(Config.String("AEMETH_OWNER_EMAIL"));
  // Changes nothing in the Worker but its text, so that a deploy of the same code is still a
  // deploy: the integration tests deploy under a run to see what a deploy does to it.
  const build = yield* Config.withDefault(Config.String("AEMETH_BUILD"), "0");
  // An empty variable, as CI has before the secret exists, is no token.
  const d1Token = Option.filter(
    yield* Config.option(Config.Redacted("AEMETH_D1_TOKEN")),
    (secret) => Redacted.value(secret) !== "",
  );
  const plain = { AEMETH_FIXTURES: kept ? "off" : "on", AEMETH_BUILD: build, AEMETH_ACCESS: team };
  const env = Option.match(d1Token, {
    onNone: () => plain,
    onSome: (secret) => ({ ...plain, AEMETH_D1_TOKEN: secret }),
  });
  return {
    main: import.meta.url,
    // Tracing through `Cloudflare.Telemetry()` needs 2026-07-28 or later.
    compatibility: { date: "2026-11-01", flags: ["nodejs_compat"] },
    codeUpdateStrategy: kept
      ? // Cloudflare's default, written out: an object that is busy keeps its code this long.
        ({ mode: "deferred", maxDelay: "5 minutes" } as const)
      : ({ mode: "immediate" } as const),
    env,
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
 * Who is calling, or `None` if the request did not come through Access or its token does not
 * verify. Only under `alchemy dev` is Access's identity lookup asked: deployed, the token is the
 * whole answer (`callerOf`).
 */
const identityUnder = (check: AccessCheck) =>
  Effect.gen(function* () {
    const access = yield* Cloudflare.Access.Context;
    if (access === undefined) {
      return Option.none<string>();
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
    const who =
      check._tag === "Local"
        ? yield* access.getIdentity().pipe(Effect.catch(() => Effect.undefined))
        : undefined;
    return yield* callerOf(check, {
      aud: access.aud,
      email: who?.email,
      token: request.headers["cf-access-jwt-assertion"],
    });
  });

/** Signatures checked with the runtime's WebCrypto. */
const signatures = Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto));

/**
 * The team's public keys, fetched when first needed, kept ten minutes, and fetched again when a
 * token names a key not among them, as Access does when it rotates its key. A redirect is not
 * followed: the keys come from the team's own address or not at all.
 */
const keysOf = (check: AccessCheck) =>
  check._tag === "Local"
    ? Jwks.layerLocal({ keys: [] })
    : Jwks.layerRemote({ url: certsOf(check.issuer) }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
      );

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
    // A Worker deployed without a setting it can read lets nobody in.
    const setting: unknown = Option.isSome(env) ? env.value["AEMETH_ACCESS"] : undefined;
    const access = accessCheckOf(typeof setting === "string" ? setting : undefined);
    const keys = yield* Option.match(access, {
      onNone: () => Effect.succeedNone,
      onSome: (check) =>
        // The keys' address was checked with the setting, so building them cannot fail.
        Effect.map(Effect.orDie(Layer.build(Layer.merge(keysOf(check), signatures))), (context) =>
          Option.some({ check, context }),
        ),
    });
    const identity = Option.match(keys, {
      onNone: () => Effect.succeedNone,
      onSome: ({ check, context }) => Effect.provideContext(identityUnder(check), context),
    });

    const blocks = [...(yield* drillBlocks), ...(fixtures ? yield* fixtureBlocks : [])];

    // The drill's D1 API, when the stage has the engine's token. Alchemy binds the account's id.
    const textOf = (name: string): string | undefined => {
      const value: unknown = Option.isSome(env) ? env.value[name] : undefined;
      return typeof value === "string" && value !== "" ? value : undefined;
    };
    const d1Token = textOf("AEMETH_D1_TOKEN");
    const accountId = textOf("ALCHEMY_CLOUDFLARE_ACCOUNT_ID");
    const d1: ReadonlyArray<Offer> =
      d1Token === undefined || accountId === undefined
        ? []
        : [
            d1Offer(
              yield* makeD1Rest({ accountId, token: Redacted.make(d1Token) }).pipe(
                Effect.provide(Layer.merge(FetchHttpClient.layer, Digest.layerWebCrypto)),
              ),
            ),
          ];
    const recipes = [...recipeFiles, ...(fixtures ? fixtureRecipes : [])];

    const index = indexOn(database, withHost);
    const services = Layer.mergeAll(
      Blocks.layer(blocks),
      Layer.succeed(
        Recipes,
        Recipes.of({ find: (id) => Effect.sync(() => recipes.find((each) => each.id === id)) }),
      ),
      Layer.succeed(Archive, archiveOn(bucket, withHost)),
      Layer.succeed(RunIndex, index),
      Layer.effect(BlockServices)(
        Effect.gen(function* () {
          return BlockServices.of({
            offers: [
              yield* secretsOffer,
              yield* Effect.provideService(runRecordOffer, RunIndex, index),
              ...d1,
            ],
          });
        }),
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

    // A defect is the engine's own fault. It is written to the Worker's log as text, which
    // Cloudflare keeps, and the caller gets a typed answer, not Cloudflare's error page.
    const answered = handler.pipe(
      Effect.catchCause((cause) =>
        Effect.as(
          // Effect's logger reaches Cloudflare's logs as `[object Object]`; the cause must be text.
          // oxlint-disable-next-line no-console
          Effect.sync(() => console.error(`Engine defect: ${Cause.pretty(cause)}`)),
          HttpServerResponse.jsonUnsafe({ error: "EngineDefect" }, { status: 500 }),
        ),
      ),
    );

    return { fetch: cluster.provide(answered) };
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
