import type { RunId } from "@aemeth/core";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer, Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import { RunLog } from "../RunLog";
import type { OneRunLog } from "../RunLogSql";
import { makeSqlLog, readOf } from "../RunLogSql";

/**
 * The SQL log the Worker's log entity uses, on SQLite in memory: a database per run, as each
 * run's Durable Object has its own. The same code as the entity's, without the entity.
 */
export const layerSqlite: Layer.Layer<RunLog> = Layer.effect(RunLog)(
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const logs = new Map<RunId, OneRunLog>();
    const logOf = (runId: RunId) =>
      Effect.gen(function* () {
        const known = logs.get(runId);
        if (known !== undefined) {
          return known;
        }
        const sql = yield* SqliteClient.make({ filename: ":memory:" }).pipe(
          Effect.provide(Reactivity.layer),
          Scope.provide(scope),
          Effect.orDie,
        );
        const log = yield* makeSqlLog(runId, sql);
        logs.set(runId, log);
        return log;
      });
    return RunLog.of({
      open: (runId, recipe) => Effect.flatMap(logOf(runId), (log) => log.open(recipe)),
      recipe: (runId) => Effect.flatMap(logOf(runId), (log) => log.recipe),
      append: (runId, fact, key) => Effect.flatMap(logOf(runId), (log) => log.append(fact, key)),
      read: (runId) => Effect.flatMap(logOf(runId), readOf),
      putSecret: (runId, name, value) =>
        Effect.flatMap(logOf(runId), (log) => log.putSecret(name, value)),
      secret: (runId, name) => Effect.flatMap(logOf(runId), (log) => log.secret(name)),
    });
  }),
);
