import * as Cloudflare from "@alchemy.run/cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stack } from "alchemy/Stack";
import { Effect, Option } from "effect";
import type { StageKind } from "./stages";
import { stageKind, unknownStage } from "./stages";

/**
 * The kind of the stage being deployed. A name that is no stage of Aemeth's stops the deploy:
 * every resource asks, so nothing is made for it.
 */
export const currentStage: Effect.Effect<StageKind, never, Stack> = Effect.flatMap(
  Stack,
  ({ stage }) =>
    Option.match(stageKind(stage), {
      onNone: () => Effect.die(new Error(unknownStage(stage))),
      onSome: (kind) => Effect.succeed(kind),
    }),
);

/** Production's data outlives its stack (M2, "Deployment"); every other stage's goes with it. */
const retainedInProduction = RemovalPolicy.retain(
  Effect.map(currentStage, (kind) => kind === "Production"),
);

// A URL's path is percent-encoded, and a folder's name may hold a space.
const migrations = decodeURIComponent(new URL("../../migrations", import.meta.url).pathname);

/** The index of runs: a D1 database, with its migrations applied on deploy. */
export const Index = Cloudflare.D1.Database("Index", { migrations }).pipe(retainedInProduction);

/** The archive of finished runs: one object per run, written once. */
export const ArchiveBucket = Cloudflare.R2.Bucket(
  "Archive",
  // A bucket that holds objects is destroyed only if told to empty itself first.
  Effect.map(currentStage, (kind) => ({ forceDestroy: kind !== "Production" })),
).pipe(retainedInProduction);

/**
 * The service token the integration tests and CI call the API with (M2 decision 15). Access
 * lets it through by a policy of its own, and the engine names it `service:<client id>`.
 */
export const CiToken = Cloudflare.Access.ServiceToken("Ci", {});
