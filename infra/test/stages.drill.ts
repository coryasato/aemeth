import type { RunEvent } from "@aemeth/core";
import { EventsResponse, RunResponse, StartedResponse } from "@aemeth/engine";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { withProviders } from "@alchemy.run/test/Core";
import * as Test from "@alchemy.run/test/Vitest";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import { expect } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import Stack from "../alchemy.run";

// The drill of Aemeth's own index on the stages that are kept (M2 Part E, E1 and E2), in the
// order decision 0008 sets: production operates staging first, and runs against itself only
// after that succeeded. It deploys `staging` and `production`, which a deploy of the same code
// leaves as they are, and destroys nothing.
//
// 1. Staging drills its own index, so that staging has a run archived.
// 2. Production drills staging's index and checks staging's archive.
// 3. Production drills its own index and checks its own archive, which holds the run of 2.
//
// Run it with `bun run drill:stages`. It is no rail: it changes the stages that are kept.

const options = { providers: Cloudflare.providers(), state: Cloudflare.state() };
const { test, beforeAll, deploy } = Test.make(options);

const staging = beforeAll(deploy(Stack, { stage: "staging" }), { timeout: 600_000 });
const production = beforeAll(deploy(Stack, { stage: "production" }), { timeout: 600_000 });

type Outputs = Effect.Success<typeof staging>;
type Answer = { readonly status: number; readonly text: string };

/** One request to a stage's engine with its service token. */
const once = (stage: Outputs, method: "GET" | "POST", path: string, body?: unknown) =>
  Effect.gen(function* () {
    if (stage.ciClientSecret === undefined) {
      return yield* Effect.die(new Error("The deploy returned no service token secret."));
    }
    const request = HttpClientRequest.make(method)(`${String(stage.url)}${path}`).pipe(
      HttpClientRequest.setHeaders({
        "CF-Access-Client-Id": stage.ciClientId,
        "CF-Access-Client-Secret": Redacted.value(stage.ciClientSecret),
      }),
      method === "POST"
        ? HttpClientRequest.bodyText(JSON.stringify(body ?? {}), "application/json")
        : (self) => self,
    );
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(request)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    const answer: Answer = { status: response.status, text: yield* response.text };
    return answer;
  });

/**
 * A request, asked again while Access is not yet in front of a stage just made (`NoIdentity`, a
 * redirect) or, for a read, while Cloudflare answers with its own error page.
 */
const call = (stage: Outputs, method: "GET" | "POST", path: string, body?: unknown) =>
  once(stage, method, path, body).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (answer) =>
        !answer.text.includes("NoIdentity") &&
        answer.status !== 302 &&
        !(method === "GET" && answer.status >= 500 && !answer.text.trimStart().startsWith("{")),
      times: 60,
    }),
  );

const read = <A, I>(schema: Schema.Codec<A, I>, answer: Answer) =>
  answer.status >= 200 && answer.status < 300
    ? Schema.decodeEffect(Schema.fromJsonString(schema))(answer.text)
    : Effect.die(new Error(`${answer.status}: ${answer.text.slice(0, 500)}`));

const finalStates = new Set(["Succeeded", "Failed", "Cancelled", "NeedsAttention"]);

/** Starts the drill of Aemeth's own index on `operator` against `target`, and waits for its end. */
const drill = (operator: Outputs, target: Outputs) =>
  Effect.gen(function* () {
    const started = yield* call(operator, "POST", "/runs", {
      recipe: "aemeth-restore-drill",
      inputs: {
        production: { kind: "cloudflare.d1.database", id: target.indexId },
        archive: { kind: "cloudflare.r2.bucket", id: target.archiveBucket },
      },
    });
    const { runId } = yield* read(StartedResponse, started);
    const state = yield* Effect.flatMap(call(operator, "GET", `/runs/${runId}`), (answer) =>
      Effect.map(read(RunResponse, answer), (run) => run.state._tag),
    ).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (tag) => finalStates.has(tag),
        times: 200,
      }),
    );
    const { events } = yield* Effect.flatMap(
      call(operator, "GET", `/runs/${runId}/events`),
      (answer) => read(EventsResponse, answer),
    );
    return { runId, state, events };
  });

const outcomes = (events: ReadonlyArray<RunEvent>) =>
  events.flatMap((event) =>
    event._tag === "StepSucceeded" || event._tag === "StepFailed"
      ? [
          `${event._tag} ${event.step}${event._tag === "StepFailed" ? `: ${event.error.message}` : ""}`,
        ]
      : [],
  );

const RunsChecked = Schema.Struct({ runsChecked: Schema.Int });

/** How many archived runs the check replayed, from its step's outputs: these stages have no fixtures to read the index row by. */
const runsCheckedBy = (events: ReadonlyArray<RunEvent>) =>
  Effect.map(
    Schema.decodeUnknownEffect(RunsChecked)(
      events.flatMap((event) =>
        event._tag === "StepSucceeded" && event.step === "checkArchive" ? [event.outputs] : [],
      )[0],
    ),
    (outputs) => outputs.runsChecked,
  );

/** What this run found, written where the person running it sees it: Vitest keeps Effect's logs. */
const say = (line: string) => Effect.sync(() => void process.stdout.write(`${line}\n`));

/** The names of the account's D1 databases, read with the deploy's own credentials. */
const databaseNames = withProviders(
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const found = yield* Stream.runCollect(d1.listDatabases.items({ accountId }));
    return found.map((each) => each.name ?? "");
  }),
  options,
  "Aemeth",
);

/**
 * Waits until the run's row in the operator's index names its archive, read with the deploy's
 * own credentials. A run's log says it ended before the engine has written its row: the next
 * drill exports that index straight away and would not count the run.
 */
const indexedAsArchived = (operator: Outputs, runId: string) =>
  withProviders(
    Effect.gen(function* () {
      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
      const rows = yield* Stream.runCollect(
        d1.queryDatabase.items({
          accountId,
          databaseId: operator.indexId,
          sql: "SELECT archive_key FROM runs WHERE id = ?",
          params: [runId],
        }),
      );
      return rows.flatMap((each) => each.results ?? []);
    }),
    options,
    "Aemeth",
  ).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (rows) => JSON.stringify(rows).includes(`runs/${runId}.json`),
      times: 60,
    }),
    Effect.flatMap((rows) =>
      JSON.stringify(rows).includes(`runs/${runId}.json`)
        ? Effect.void
        : Effect.die(new Error(`The index never named the archive of ${runId}.`)),
    ),
  );

/** Runs one drill and holds it to a success, saying what it found. */
const succeeds = (name: string, operator: Outputs, target: Outputs) =>
  Effect.gen(function* () {
    const { runId, state, events } = yield* drill(operator, target);
    yield* say(`${name}: run ${runId} ${state}: ${outcomes(events).join(", ")}`);
    expect([name, state, outcomes(events)]).toEqual([
      name,
      "Succeeded",
      [
        "StepSucceeded export",
        "StepSucceeded createTemp",
        "StepSucceeded restore",
        "StepSucceeded verify",
        "StepSucceeded checkArchive",
        "StepSucceeded destroyTemp",
        "StepSucceeded record",
      ],
    ]);
    const checked = yield* runsCheckedBy(events);
    yield* say(`${name}: ${checked} archived runs replayed to their rows`);
    const left = (yield* databaseNames).filter((each) => each.includes(runId));
    expect([name, left]).toEqual([name, []]);
    yield* indexedAsArchived(operator, runId);
    return { runId, checked };
  });

/** What a stage answers a request without credentials: Access's, never the engine's. */
const stranger = (stage: Outputs) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(HttpClientRequest.get(`${String(stage.url)}/runs/00000000000000000000000000`))
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    const text = yield* response.text;
    return { status: response.status, engine: text.includes("RunNotFound") };
  });

test(
  "Access turns away a request without credentials on both stages",
  Effect.gen(function* () {
    for (const [name, stage] of [
      ["staging", yield* staging],
      ["production", yield* production],
    ] as const) {
      const answer = yield* stranger(stage);
      yield* say(
        `${name} without credentials: ${answer.status}, reached the engine: ${answer.engine}`,
      );
      expect([name, [302, 401, 403].includes(answer.status), answer.engine]).toEqual([
        name,
        true,
        false,
      ]);
    }
  }),
);

test(
  "production drills staging first, then itself, and both index and archive agree",
  Effect.gen(function* () {
    const stagingOutputs = yield* staging;
    const productionOutputs = yield* production;
    yield* succeeds("staging drills itself", stagingOutputs, stagingOutputs);
    const onStaging = yield* succeeds(
      "production drills staging",
      productionOutputs,
      stagingOutputs,
    );
    // Staging's archive holds at least the run of staging's own drill.
    expect(onStaging.checked).toBeGreaterThan(0);
    const onProduction = yield* succeeds(
      "production drills itself",
      productionOutputs,
      productionOutputs,
    );
    // Production's archive holds at least its drill of staging.
    expect(onProduction.checked).toBeGreaterThan(0);
  }),
  { timeout: 1_800_000 },
);
