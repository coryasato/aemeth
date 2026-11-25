import { EventRejected, Recipe, RunEvent, RunId } from "@aemeth/core";
// Not the package's index: that also loads its tracer, which imports `cloudflare:workers` and so
// cannot be loaded where the stack is planned.
import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { Effect, Layer, Schema } from "effect";
import type { ClusterError } from "effect/cluster";
import { Entity } from "effect/cluster";
import { Rpc } from "effect/rpc";
import { RunLog, RunNotFound } from "../RunLog";
import { makeSqlLog, readOf } from "../RunLogSql";

/**
 * A run's log as an entity: one Durable Object per run, keyed by the run id, with the events,
 * the recipe and the secrets in its own SQLite storage (M2 decision 2). An entity handles one
 * request at a time, so the workflow and the API can both append without racing for a `seq`.
 *
 * The fact travels as it is and is checked where it is stored, by the same `appendTo` the
 * in-memory log uses.
 */
export const RunLogEntity = Entity.make("RunLog", [
  Rpc.make("Open", { payload: { recipe: Recipe } }),
  Rpc.make("Recipe", { success: Recipe, error: RunNotFound }),
  Rpc.make("Append", {
    payload: { fact: Schema.Record(Schema.String, Schema.Json), dedupeKey: Schema.String },
    success: RunEvent,
    error: Schema.Union([EventRejected, RunNotFound]),
  }),
  Rpc.make("Events", { success: Schema.Array(RunEvent), error: RunNotFound }),
  Rpc.make("PutSecret", {
    payload: { name: Schema.String, value: Schema.String },
    error: RunNotFound,
  }),
  Rpc.make("Secret", {
    payload: { name: Schema.String },
    success: Schema.Option(Schema.String),
    error: RunNotFound,
  }),
]);

const decodeRunId = Schema.decodeUnknownEffect(RunId);

/** The entity's handlers: the SQL log, on this object's own storage. */
export const RunLogEntityLayer = RunLogEntity.toLayer(
  Effect.gen(function* () {
    const sql = yield* CloudflareCluster.DurableObjectSqlClient.orDie;
    const address = yield* Entity.CurrentAddress;
    // Only the engine addresses this entity, and always by a run id.
    const runId = yield* Effect.orDie(decodeRunId(address.entityId));
    const log = yield* makeSqlLog(runId, sql);
    return RunLogEntity.of({
      Open: ({ payload }) => log.open(payload.recipe),
      Recipe: () => log.recipe,
      Append: ({ payload }) => log.append(payload.fact, payload.dedupeKey),
      Events: () => log.events,
      PutSecret: ({ payload }) => log.putSecret(payload.name, payload.value),
      Secret: ({ payload }) => log.secret(payload.name),
    });
  }),
);

/** What a call to an entity can fail with that is the cluster's doing and not the run's. */
const clusterFaults = {
  MailboxFull: (error: ClusterError.MailboxFull) => Effect.die(error),
  AlreadyProcessingMessage: (error: ClusterError.AlreadyProcessingMessage) => Effect.die(error),
  PersistenceError: (error: ClusterError.PersistenceError) => Effect.die(error),
  EntityNotAssignedToRunner: (error: ClusterError.EntityNotAssignedToRunner) => Effect.die(error),
} as const;

/**
 * `RunLog` for the Worker and for the workflow: every call goes to the run's entity. What the
 * cluster itself can fail with (a full mailbox, storage that is away) is a defect here, as
 * storage is in the SQL log: none of it is a state of the run.
 */
export const layerRunLog = Layer.effect(RunLog)(
  Effect.gen(function* () {
    const client = yield* RunLogEntity.client;
    const events = (runId: RunId) => client(runId).Events().pipe(Effect.catchTags(clusterFaults));
    return RunLog.of({
      open: (runId, recipe) => client(runId).Open({ recipe }).pipe(Effect.catchTags(clusterFaults)),
      recipe: (runId) => client(runId).Recipe().pipe(Effect.catchTags(clusterFaults)),
      append: (runId, fact, dedupeKey) =>
        client(runId).Append({ fact, dedupeKey }).pipe(Effect.catchTags(clusterFaults)),
      read: (runId) => readOf({ events: events(runId) }),
      putSecret: (runId, name, value) =>
        client(runId).PutSecret({ name, value }).pipe(Effect.catchTags(clusterFaults)),
      secret: (runId, name) => client(runId).Secret({ name }).pipe(Effect.catchTags(clusterFaults)),
    });
  }),
);
