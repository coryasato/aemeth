import type { EventRejected, Recipe, RunId, RunState } from "@aemeth/core";
import { notStarted, RunEvent, transition } from "@aemeth/core";
import { Clock, Context, Effect, Layer, Option, Ref, Result, Schema } from "effect";

/** A run nobody started, or one whose log is gone. */
export class RunNotFound extends Schema.TaggedError<
  RunNotFound,
  { readonly brand: unique symbol }
>()("RunNotFound", { runId: Schema.String }) {}

type Envelope = "eventSchemaVersion" | "runId" | "seq" | "at" | "recipe";
// Applied to each event of the union in turn, so every fact keeps its own fields.
type Without<Event, Keys extends PropertyKey> = Event extends unknown ? Omit<Event, Keys> : never;

/**
 * An event before the log has taken it: what happened, without the envelope. The log gives it
 * its run, its recipe, the next `seq` and the time.
 */
export type Fact = Without<RunEvent, Envelope>;

/** A run as its log has it: the events, and the state they lead to. */
export type RunRecord = {
  readonly events: ReadonlyArray<RunEvent>;
  readonly state: RunState;
};

/**
 * The log of every run: the source of truth for a run (M2 decision 2). It holds the events, the
 * recipe document the run started with and the run's secrets, and nothing else decides what an
 * event's `seq` is or whether it fits.
 *
 * In the Worker this is an entity per run on Durable Object storage (Part C). Here it is a
 * service, so the driver and its tests do not depend on that.
 */
export class RunLog extends Context.Service<
  RunLog,
  {
    /** Creates a run's log with the recipe it will follow. A second call changes nothing. */
    readonly open: (runId: RunId, recipe: Recipe) => Effect.Effect<void>;
    /** The recipe document the run started with, whatever has been deployed since. */
    readonly recipe: (runId: RunId) => Effect.Effect<Recipe, RunNotFound>;
    /**
     * Appends a fact if `transition` accepts it in the run's state; a rejected fact is stored
     * nowhere. A fact appended before under the same `dedupeKey` is not appended again: the
     * stored event is returned, so an append that runs twice appends once.
     */
    readonly append: (
      runId: RunId,
      fact: Fact,
      dedupeKey: string,
    ) => Effect.Effect<RunEvent, EventRejected | RunNotFound>;
    readonly read: (runId: RunId) => Effect.Effect<RunRecord, RunNotFound>;
    /** Keeps a secret for the run. It is in no event, and is deleted when the run ends. */
    readonly putSecret: (
      runId: RunId,
      name: string,
      value: string,
    ) => Effect.Effect<void, RunNotFound>;
    readonly secret: (
      runId: RunId,
      name: string,
    ) => Effect.Effect<Option.Option<string>, RunNotFound>;
  }
>()("@aemeth/engine/RunLog") {}

type Entry = {
  readonly recipe: Recipe;
  readonly events: ReadonlyArray<RunEvent>;
  readonly state: RunState;
  readonly byKey: ReadonlyMap<string, RunEvent>;
  readonly secrets: ReadonlyMap<string, string>;
};

const isFinal = (state: RunState): boolean =>
  state._tag === "Succeeded" ||
  state._tag === "Failed" ||
  state._tag === "Cancelled" ||
  state._tag === "NeedsAttention";

const decodeEvent = Schema.decodeUnknownResult(RunEvent, { onExcessProperty: "error" });

const empty = (recipe: Recipe): Entry => ({
  recipe,
  events: [],
  state: notStarted,
  byKey: new Map(),
  secrets: new Map(),
});

/** The log kept in memory: what the tests run on, with the same rules as the entity. */
export const layerMemory: Layer.Layer<RunLog> = Layer.effect(RunLog)(
  Effect.gen(function* () {
    const runs = yield* Ref.make<ReadonlyMap<RunId, Entry>>(new Map());
    const entryOf = (runId: RunId) =>
      Effect.flatMap(Ref.get(runs), (all) => {
        const entry = all.get(runId);
        return entry === undefined
          ? Effect.fail(new RunNotFound({ runId }))
          : Effect.succeed(entry);
      });
    const withEntry = (all: ReadonlyMap<RunId, Entry>, runId: RunId, entry: Entry) =>
      new Map([...all, [runId, entry]]);

    type Appended = Effect.Effect<RunEvent, EventRejected | RunNotFound>;
    /** One append, start to finish: an entity handles one request at a time, and so does this. */
    const append = (
      all: ReadonlyMap<RunId, Entry>,
      runId: RunId,
      fact: Fact,
      dedupeKey: string,
      at: number,
    ): readonly [Appended, ReadonlyMap<RunId, Entry>] => {
      const entry = all.get(runId);
      if (entry === undefined) {
        return [Effect.fail(new RunNotFound({ runId })), all];
      }
      const stored = entry.byKey.get(dedupeKey);
      if (stored !== undefined) {
        return [Effect.succeed(stored), all];
      }
      const event = decodeEvent({
        ...fact,
        eventSchemaVersion: 1,
        runId,
        seq: entry.events.length,
        at,
        recipe: { id: entry.recipe.id, version: entry.recipe.version },
      });
      if (Result.isFailure(event)) {
        // A fact the engine built wrongly is the engine's bug, not a state of the run.
        return [Effect.die(event.failure), all];
      }
      const next = transition(entry.state, event.success);
      if (Result.isFailure(next)) {
        return [Effect.fail(next.failure), all];
      }
      return [
        Effect.succeed(event.success),
        withEntry(all, runId, {
          recipe: entry.recipe,
          events: [...entry.events, event.success],
          state: next.success,
          byKey: new Map([...entry.byKey, [dedupeKey, event.success]]),
          secrets: isFinal(next.success) ? new Map() : entry.secrets,
        }),
      ];
    };

    const putSecret = (
      all: ReadonlyMap<RunId, Entry>,
      runId: RunId,
      name: string,
      value: string,
    ): readonly [Effect.Effect<void, RunNotFound>, ReadonlyMap<RunId, Entry>] => {
      const entry = all.get(runId);
      return entry === undefined
        ? [Effect.fail(new RunNotFound({ runId })), all]
        : [
            Effect.void,
            withEntry(all, runId, {
              ...entry,
              secrets: new Map([...entry.secrets, [name, value]]),
            }),
          ];
    };

    return RunLog.of({
      open: (runId, recipe) =>
        Ref.update(runs, (all) => (all.has(runId) ? all : withEntry(all, runId, empty(recipe)))),
      recipe: (runId) => Effect.map(entryOf(runId), (entry) => entry.recipe),
      append: (runId, fact, dedupeKey) =>
        Effect.flatMap(Clock.currentTimeMillis, (at) =>
          Effect.flatten(Ref.modify(runs, (all) => append(all, runId, fact, dedupeKey, at))),
        ),
      read: (runId) => Effect.map(entryOf(runId), ({ events, state }) => ({ events, state })),
      putSecret: (runId, name, value) =>
        Effect.flatten(Ref.modify(runs, (all) => putSecret(all, runId, name, value))),
      secret: (runId, name) =>
        Effect.map(entryOf(runId), (entry) => Option.fromUndefinedOr(entry.secrets.get(name))),
    });
  }),
);
