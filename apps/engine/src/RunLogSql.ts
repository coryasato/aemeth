import type { EventRejected, RunId } from "@aemeth/core";
import { Recipe, replay, RunEvent } from "@aemeth/core";
import { Clock, Effect, Option, Result, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { Entry, RunRecord } from "./RunLog";
import { appendedEffect, appendTo, emptyEntry, RunNotFound } from "./RunLog";

/**
 * The log of one run, as `RunLog` has it for every run. In the Worker each run has a database of
 * its own, the SQLite storage of its log entity, so nothing here names the run in a query.
 */
export type OneRunLog = {
  readonly open: (recipe: Recipe) => Effect.Effect<void>;
  readonly recipe: Effect.Effect<Recipe, RunNotFound>;
  readonly append: (
    fact: { readonly [field: string]: Schema.Json },
    dedupeKey: string,
  ) => Effect.Effect<RunEvent, EventRejected | RunNotFound>;
  readonly events: Effect.Effect<ReadonlyArray<RunEvent>, RunNotFound>;
  readonly putSecret: (name: string, value: string) => Effect.Effect<void, RunNotFound>;
  readonly secret: (name: string) => Effect.Effect<Option.Option<string>, RunNotFound>;
};

const RecipeText = Schema.fromJsonString(Recipe);
const EventText = Schema.fromJsonString(RunEvent);
const encodeRecipe = Schema.encodeSync(RecipeText);
const decodeRecipe = Schema.decodeResult(RecipeText);
const encodeEvent = Schema.encodeSync(EventText);
const decodeEvent = Schema.decodeResult(EventText);

type EventRow = { readonly seq: number; readonly dedupe_key: string; readonly event: string };

/**
 * A run's log in a SQLite database that holds that run and nothing else (M2 decision 2). The
 * rules are `appendTo`'s, the same as the in-memory log's: this only loads the run, asks, and
 * stores what was accepted. An event and the secrets it ends are written in one transaction.
 *
 * Whatever the storage does wrong is a defect: a log that cannot be read or written is no state
 * of the run, and the caller cannot do anything about it.
 */
export const makeSqlLog = (runId: RunId, sql: SqlClient.SqlClient): Effect.Effect<OneRunLog> =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS run (id INTEGER PRIMARY KEY CHECK (id = 1), recipe TEXT NOT NULL)`;
    yield* sql`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, event TEXT NOT NULL)`;
    yield* sql`CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)`;

    const recipe = Effect.gen(function* () {
      const rows = yield* sql<{ readonly recipe: string }>`SELECT recipe FROM run WHERE id = 1`;
      const [row] = rows;
      if (row === undefined) {
        return yield* new RunNotFound({ runId });
      }
      // The engine wrote the document itself, so one that does not decode is a defect.
      return yield* Effect.orDie(Effect.fromResult(decodeRecipe(row.recipe)));
    });

    /** The run as stored: its events, replayed, and its secrets. */
    const load = Effect.gen(function* () {
      const document = yield* recipe;
      const rows = yield* sql<EventRow>`SELECT seq, dedupe_key, event FROM events ORDER BY seq`;
      const events: Array<RunEvent> = [];
      const byKey = new Map<string, RunEvent>();
      for (const row of rows) {
        const event = yield* Effect.orDie(Effect.fromResult(decodeEvent(row.event)));
        events.push(event);
        byKey.set(row.dedupe_key, event);
      }
      const state = replay(events);
      if (Result.isFailure(state)) {
        // Every stored event was accepted by `transition` when it was stored.
        return yield* Effect.die(state.failure);
      }
      const kept = yield* sql<{
        readonly name: string;
        readonly value: string;
      }>`SELECT name, value FROM secrets`;
      const entry: Entry = {
        ...emptyEntry(document),
        events,
        byKey,
        state: state.success,
        secrets: new Map(kept.map(({ name, value }) => [name, value])),
      };
      return entry;
    });

    const append = (fact: { readonly [field: string]: Schema.Json }, dedupeKey: string) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const entry = yield* load;
        const appended = appendTo(entry, runId, fact, dedupeKey, at);
        if (appended._tag === "Stored") {
          const { event } = appended;
          const text = encodeEvent(event);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO events (seq, dedupe_key, event) VALUES (${event.seq}, ${dedupeKey}, ${text})`;
              if (appended.entry.secrets.size === 0) {
                yield* sql`DELETE FROM secrets`;
              }
            }),
          );
        }
        return yield* appendedEffect(appended);
      });

    const log: OneRunLog = {
      open: (document) =>
        Effect.orDie(
          sql`INSERT OR IGNORE INTO run (id, recipe) VALUES (1, ${encodeRecipe(document)})`,
        ),
      recipe: recipe.pipe(Effect.catchTag("SqlError", (error) => Effect.die(error))),
      append: (fact, dedupeKey) =>
        append(fact, dedupeKey).pipe(Effect.catchTag("SqlError", (error) => Effect.die(error))),
      events: load.pipe(
        Effect.map((entry) => entry.events),
        Effect.catchTag("SqlError", (error) => Effect.die(error)),
      ),
      putSecret: (name, value) =>
        recipe.pipe(
          Effect.andThen(
            sql`INSERT INTO secrets (name, value) VALUES (${name}, ${value}) ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
          ),
          Effect.asVoid,
          Effect.catchTag("SqlError", (error) => Effect.die(error)),
        ),
      secret: (name) =>
        recipe.pipe(
          Effect.andThen(
            sql<{ readonly value: string }>`SELECT value FROM secrets WHERE name = ${name}`,
          ),
          Effect.map((rows) => Option.fromUndefinedOr(rows[0]?.value)),
          Effect.catchTag("SqlError", (error) => Effect.die(error)),
        ),
    };
    return log;
  }).pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));

/** A run as `RunLog.read` gives it: the stored events and the state they replay to. */
export const readOf = (log: Pick<OneRunLog, "events">): Effect.Effect<RunRecord, RunNotFound> =>
  Effect.flatMap(log.events, (events) => {
    const state = replay(events);
    // Every stored event was accepted by `transition` when it was stored.
    return Result.isFailure(state)
      ? Effect.die(state.failure)
      : Effect.succeed({ events, state: state.success });
  });
