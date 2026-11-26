import type { RunEvent } from "@aemeth/core";
import { own } from "@aemeth/core";
import {
  archiveText,
  EventResponse,
  EventsResponse,
  replayArchive,
  RunResponse,
  StartedResponse,
} from "@aemeth/engine";
import { RecordResponse, StepMarks } from "@aemeth/engine/cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { withProviders } from "@alchemy.run/test/Core";
import * as Test from "@alchemy.run/test/Vitest";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import { expect } from "@effect/vitest";
import { Effect, Redacted, Result, Schedule, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import Stack from "../alchemy.run";

// The integration rail (M2 Part C): the engine as it is deployed, on a stage that is thrown
// away. It shows what no test in memory can: that the Worker bundles and starts, that Access
// stands in front of it, that a run survives a deploy at its gate and a kill in the middle of a
// step with each event in its log once, and that a finished run is archived and indexed.
//
// Since Part D it also runs the restore drill against the stage's seeded sample database, with
// the engine's own D1 token: export, a temporary database, restore, check, destroy, record.
//
// The stage is `$ALCHEMY_TEST_STAGE` (`pr-<number>` in CI), or `test_$USER`. With
// `ALCHEMY_DEV=1` the same suite runs on local emulators, where there is no Access and a deploy
// does not kill a Durable Object, so the tests of those two are skipped there.

const local = process.env["ALCHEMY_DEV"] === "1" || process.env["ALCHEMY_TEST_DEV"] === "1";

const options = { providers: Cloudflare.providers(), state: Cloudflare.state() };
const { test, beforeAll, afterAll, deploy, destroy } = Test.make(options);

/** Deploys the stack as a new build: the same code, and still a deploy. */
const deployed = (build: number) =>
  Effect.suspend(() => {
    process.env["AEMETH_BUILD"] = `${Date.now()}-${build}`;
    return deploy(Stack);
  });

const stack = beforeAll(deployed(1), { timeout: 600_000 });

/** How many requests without credentials reached the Worker: Access was not in front of it. */
let seenWithoutAccess = 0;

/** Every run of the drill this suite started. */
const drillRuns = new Set<string>();

// A test that fails can leave a run in the middle of the drill when the stage is destroyed, and
// its temporary database is no resource of the stage's. Once the stage is gone, and its runs with
// it, the databases named for this suite's runs are deleted, and no other: the account may hold
// other stages' drills. Hooks run last first, so this one is above the destroy.
afterAll(
  Effect.gen(function* () {
    const left = (yield* databases).filter((each) =>
      [...drillRuns].some((runId) => each.name.includes(runId)),
    );
    yield* Effect.logInfo(`Temporary databases left by the suite's runs: ${left.length}`);
    yield* Effect.forEach(left, (each) => deleteDatabase(each.id), { discard: true });
  }),
  { timeout: 120_000 },
);

afterAll.skipIf(process.env["NO_DESTROY"] === "1")(destroy(Stack), { timeout: 600_000 });
afterAll(
  Effect.suspend(() =>
    Effect.logInfo(`Requests without credentials that reached the Worker: ${seenWithoutAccess}`),
  ),
);

type Answer = { readonly status: number; readonly text: string; readonly location: string };

/** One request to the deployed engine, as it is answered. With `anonymous`, without the token. */
const once = (
  method: "GET" | "POST",
  path: string,
  options: { readonly body?: unknown; readonly text?: string; readonly anonymous?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { url, ciClientId, ciClientSecret } = yield* stack;
    const text = options.text ?? (options.body === undefined ? "" : JSON.stringify(options.body));
    const request = HttpClientRequest.make(method)(`${String(url)}${path}`).pipe(
      options.anonymous === true || ciClientSecret === undefined
        ? (self) => self
        : HttpClientRequest.setHeaders({
            "CF-Access-Client-Id": ciClientId,
            "CF-Access-Client-Secret": Redacted.value(ciClientSecret),
          }),
      method === "POST" ? HttpClientRequest.bodyText(text, "application/json") : (self) => self,
    );
    // Nothing is tried again here: a 404 is one of the engine's own answers. The suite waits for
    // a new stage to answer at all before its first test (`ready`, below).
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request).pipe(
      // A redirect to the login page is an answer, not somewhere to go.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    );
    const answer: Answer = {
      status: response.status,
      text: yield* response.text,
      location: response.headers["location"] ?? "",
    };
    return answer;
  });

/**
 * Whether Cloudflare answered for a Worker it could not run: its own error page, not the
 * engine's JSON. For a moment after an immediate deploy, a request can land on a Worker that is
 * changing its code.
 */
const cloudflareError = (answer: Answer): boolean =>
  answer.status >= 500 && !answer.text.trimStart().startsWith("{");

/**
 * One request to the deployed engine. Access is not always in front of the Worker: for some
 * seconds after a stage is created, and now and then around a deploy, a request arrives with no
 * identity, and the engine itself refuses it (`NoIdentity`). That is the engine doing its part;
 * for a caller with the token it means "not yet", so it is asked again, for up to a minute. So
 * is Cloudflare's own error page around a deploy, to a read: a write it cut off may have landed.
 */
const call: typeof once = (method, path, options = {}) =>
  once(method, path, options).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (answer) =>
        options.anonymous === true ||
        (!answer.text.includes("NoIdentity") && !(method === "GET" && cloudflareError(answer))),
      times: 30,
    }),
  );

/**
 * Asks for a run that does not exist, every three seconds, until the answer is the one wanted.
 * Fails, saying what was waited for, if three minutes pass without it.
 */
const asked = (waitingFor: string, anonymous: boolean, done: (answer: Answer) => boolean) =>
  call("GET", "/runs/00000000000000000000000000", { anonymous }).pipe(
    Effect.orElseSucceed((): Answer => ({ status: 0, text: "", location: "" })),
    Effect.tap((answer) =>
      Effect.logInfo(`Waiting for ${waitingFor}: ${answer.status} ${answer.text.slice(0, 80)}`),
    ),
    Effect.repeat({ schedule: Schedule.spaced("3 seconds"), until: done, times: 60 }),
    Effect.flatMap((answer) =>
      done(answer)
        ? Effect.void
        : Effect.die(
            new Error(
              `The stage never got as far as ${waitingFor}: ${answer.status} ${answer.text.slice(0, 200)}`,
            ),
          ),
    ),
  );

// A new stage is not ready the moment it is deployed. Its hostname answers 404 or 5xx for a
// moment; and Access is not in force the moment its application exists: for some seconds a
// request reaches the Worker with no identity, and the engine itself refuses it (`NoIdentity`).
// The suite waits until Access turns a stranger away and the engine answers the service token.
const ready = beforeAll(
  Effect.gen(function* () {
    if (!local) {
      yield* asked(
        "Access turning a stranger away",
        true,
        (answer) => [302, 401, 403].includes(answer.status) && !answer.text.includes("NoIdentity"),
      );
    }
    yield* asked("the engine answering the service token", false, (answer) =>
      answer.text.includes("RunNotFound"),
    );
  }),
  { timeout: 400_000 },
);

/** The body of an answer that must be a success, against the Schema the engine wrote it with. */
const read = <A, I>(schema: Schema.Codec<A, I>, answer: Answer) =>
  answer.status >= 200 && answer.status < 300
    ? Schema.decodeEffect(Schema.fromJsonString(schema))(answer.text)
    : Effect.die(new Error(`${answer.status}: ${answer.text.slice(0, 500)}`));

const eventsOf = (runId: string) =>
  Effect.map(
    Effect.flatMap(call("GET", `/runs/${runId}/events`), (answer) => read(EventsResponse, answer)),
    ({ events }) => events,
  );

const stateOf = (runId: string) =>
  Effect.map(
    Effect.flatMap(call("GET", `/runs/${runId}`), (answer) => read(RunResponse, answer)),
    ({ state }) => state._tag,
  );

/** Asks every three seconds until the run is in the state, for up to `minutes`. */
const until = (runId: string, wanted: string, minutes: number) =>
  stateOf(runId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (state) => state === wanted,
      times: minutes * 20,
    }),
    Effect.flatMap((state) =>
      state === wanted
        ? Effect.void
        : Effect.die(new Error(`The run is ${state}, not ${wanted}, after ${minutes} minutes.`)),
    ),
  );

const start = (workFor: number) =>
  Effect.map(
    Effect.flatMap(
      call("POST", "/runs", { body: { recipe: "test-gated", inputs: { workFor } } }),
      (answer) => read(StartedResponse, answer),
    ),
    ({ runId }) => runId,
  );

const approve = (runId: string) =>
  Effect.map(
    Effect.flatMap(call("POST", `/runs/${runId}/gates/ok/approve`), (answer) =>
      read(EventResponse, answer),
    ),
    ({ event }) => event,
  );

const brief = (event: RunEvent): string =>
  "step" in event ? `${event._tag} ${event.step}` : event._tag;

const wholeRun = [
  "RunStarted",
  "StepStarted work",
  "StepSucceeded work",
  "GateOpened ok",
  "ApprovalGranted ok",
  "StepStarted after",
  "StepSucceeded after",
  "MainPhaseEnded",
  "RunSucceeded",
];

/** Every event once, in order: `seq` counts from zero with no gap and no repeat. */
const expectEachEventOnce = (events: ReadonlyArray<RunEvent>) => {
  expect(events.map(brief)).toEqual(wholeRun);
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
};

const executionsOf = (events: ReadonlyArray<RunEvent>, step: string) =>
  events.flatMap((event) =>
    event._tag === "StepSucceeded" && event.step === step ? [own(event.outputs, "executions")] : [],
  );

test.skipIf(local)(
  "a request without credentials is refused, by Access once it is in force",
  Effect.gen(function* () {
    yield* ready;
    const answers: Array<Answer> = [];
    for (let asked = 0; asked < 10; asked += 1) {
      answers.push(yield* call("GET", "/runs/00000000000000000000000000", { anonymous: true }));
      yield* Effect.sleep("1 second");
    }
    for (const answer of answers) {
      // Never served: a stranger is turned away by Access, or failing that by the engine.
      expect([302, 401, 403]).toContain(answer.status);
      expect(answer.text).not.toContain("RunNotFound");
    }
    // Access itself answered: a person is sent to its login page, or shown its error page.
    const byAccess = answers.filter((answer) => !answer.text.includes("NoIdentity"));
    expect(byAccess.length).toBeGreaterThan(0);
    for (const answer of byAccess) {
      expect(`${answer.location} ${answer.text}`).toMatch(
        /cloudflareaccess\.com|Cloudflare Access/u,
      );
    }
    yield* Effect.sync(() => {
      seenWithoutAccess += answers.length - byAccess.length;
    });
  }),
);

test(
  "the service token reaches the API",
  Effect.gen(function* () {
    const missing = yield* call("GET", "/runs/00000000000000000000000000");
    expect([missing.status, JSON.parse(missing.text)]).toEqual([
      404,
      { error: "RunNotFound", runId: "00000000000000000000000000" },
    ]);
    const unknown = yield* call("POST", "/runs", { body: { recipe: "no-such-recipe" } });
    expect(unknown.status).toBe(404);
    expect(unknown.text).toContain('"reason":"RecipeNotFound"');
  }),
);

/**
 * Every D1 database on the account, as Cloudflare lists them to the deploy's own credentials:
 * not through the engine, whose cleanup is what is being checked.
 */
const databases = withProviders(
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const found = yield* Stream.runCollect(d1.listDatabases.items({ accountId }));
    return found.flatMap((each) =>
      typeof each.uuid === "string" && each.uuid !== ""
        ? [{ id: each.uuid, name: each.name ?? "" }]
        : [],
    );
  }),
  options,
  "Aemeth",
);

/** What the drill's steps returned, as the test reads them. */
const DrillOutputs = Schema.Struct({
  export: Schema.Struct({ rowCount: Schema.Int, checksum: Schema.String }),
  createTemp: Schema.Struct({
    database: Schema.Struct({ kind: Schema.String, id: Schema.String }),
  }),
  verify: Schema.Struct({ rowsCompared: Schema.Int }),
});

const drillSteps = ["export", "createTemp", "restore", "verify", "destroyTemp", "record"];

// What the sample's seed puts in it (`apps/engine/sample`): 400 customers, 800 orders, 5
// settings. The figures count every user table, Alchemy's record of the migration among them.
const seededRows = 1205;

test.skipIf(local)(
  "the restore drill restores the sample database, finds it whole, and leaves nothing behind",
  Effect.gen(function* () {
    const { sampleId } = yield* stack;
    if (sampleId === undefined) {
      return yield* Effect.die(new Error("The stage has no sample database."));
    }
    const started = yield* call("POST", "/runs", {
      body: {
        recipe: "restore-drill",
        inputs: { production: { kind: "cloudflare.d1.database", id: sampleId } },
      },
    });
    const { runId } = yield* read(StartedResponse, started);
    drillRuns.add(runId);
    yield* until(runId, "Succeeded", 8);

    const events = yield* eventsOf(runId);
    const succeeded = events.flatMap((event) => (event._tag === "StepSucceeded" ? [event] : []));
    expect(succeeded.map((event) => event.step)).toEqual(drillSteps);
    // One attempt of each step: nothing failed on the way.
    expect(events.filter((event) => event._tag === "StepStarted")).toHaveLength(6);
    const outputs = yield* Schema.decodeUnknownEffect(DrillOutputs)(
      Object.fromEntries(succeeded.map((event) => [event.step, event.outputs])),
    );
    const { rowCount, checksum } = outputs.export;
    expect(rowCount).toBeGreaterThan(seededRows);
    expect(outputs.verify.rowsCompared).toBe(rowCount);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/u);
    // The temporary database is gone, by its id and by any name with the run's id in it.
    const left = yield* databases;
    expect(left.filter((each) => each.id === outputs.createTemp.database.id)).toEqual([]);
    expect(left.filter((each) => each.name.includes(runId))).toEqual([]);
    expect(left.map((each) => each.id)).toContain(sampleId);

    // Recorded in the index, and archived.
    const record = yield* Effect.flatMap(
      call("GET", `/test/runs/${runId}/record`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (answer) => answer.text.includes('"Succeeded"'),
          times: 30,
        }),
      ),
      (answer) => read(RecordResponse, answer),
    );
    expect(record.row).toMatchObject({
      state: "Succeeded",
      archiveKey: `runs/${runId}.json`,
      result: { rowsCompared: rowCount },
    });
    expect(record.archive).toBe(archiveText(events));

    // The export's link, which downloads the whole database, is nowhere the run is kept or shown.
    const shown = [
      record.archive ?? "",
      JSON.stringify(record.row),
      (yield* call("GET", `/runs/${runId}`)).text,
      (yield* call("GET", `/runs/${runId}/events`)).text,
    ].join("\n");
    expect(shown).not.toMatch(/cloudflarestorage|X-Amz-|https:/u);
  }),
  { timeout: 900_000 },
);

test(
  "a run waits at its gate through a deploy, records who approved, and is archived once",
  Effect.gen(function* () {
    const { ciClientId } = yield* stack;
    const runId = yield* start(0);
    yield* until(runId, "WaitingForApproval", 2);

    // New code is deployed while the run waits. The run is still there, and still waiting.
    yield* deployed(2);
    // Straight after a deploy is when Access may not be in front: count it, and see that a
    // stranger is refused either way.
    for (let asked = 0; asked < (local ? 0 : 5); asked += 1) {
      const stranger = yield* once("GET", `/runs/${runId}`, { anonymous: true });
      expect([302, 401, 403]).toContain(stranger.status);
      expect(stranger.text).not.toContain("WaitingForApproval");
      if (stranger.text.includes("NoIdentity")) {
        seenWithoutAccess += 1;
      }
    }
    expect(yield* stateOf(runId)).toBe("WaitingForApproval");
    const before = yield* call("GET", `/test/runs/${runId}/record`);
    expect((yield* read(RecordResponse, before)).row).toMatchObject({
      id: runId,
      recipe: { id: "test-gated", version: 1 },
      state: "Running",
      archiveKey: null,
    });

    const approval = yield* approve(runId);
    expect(approval).toMatchObject({ _tag: "ApprovalGranted", step: "ok" });
    if (!local && approval._tag === "ApprovalGranted") {
      // The caller is the service token, by its client id (M2, "API").
      expect(approval.by).toBe(`service:${ciClientId}`);
    }

    yield* until(runId, "Succeeded", 2);
    const events = yield* eventsOf(runId);
    expectEachEventOnce(events);
    expect(executionsOf(events, "work")).toEqual([1]);

    // The archive is the whole log, and replays to the state the index records (C3).
    const record = yield* Effect.flatMap(
      call("GET", `/test/runs/${runId}/record`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (answer) => answer.text.includes('"Succeeded"'),
          times: 30,
        }),
      ),
      (answer) => read(RecordResponse, answer),
    );
    expect(record.row).toMatchObject({
      state: "Succeeded",
      endedAt: events.at(-1)?.at,
      archiveKey: `runs/${runId}.json`,
    });
    expect(record.archive).toBe(archiveText(events));
    const replayed = replayArchive(record.archive ?? "");
    expect(Result.isSuccess(replayed) ? replayed.success._tag : replayed.failure).toBe(
      record.row?.state,
    );

    // A second write to the same key is refused, and the object is what it was.
    const again = yield* call("POST", `/test/runs/${runId}/archive`, { text: "[]" });
    expect([again.status, JSON.parse(again.text)]).toEqual([200, { written: false }]);
    const after = yield* call("GET", `/test/runs/${runId}/record`);
    expect((yield* read(RecordResponse, after)).archive).toBe(record.archive);
  }),
  { timeout: 900_000 },
);

test.skipIf(local)(
  "a run killed in the middle of a step starts again and finishes, with each event once",
  Effect.gen(function* () {
    // The step waits for a minute and a half. A deploy that makes every Durable Object take the
    // new code at once lands in the middle of it.
    const runId = yield* start(90_000);
    const begun = yield* eventsOf(runId).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (events) => events.some((event) => event._tag === "StepStarted"),
        times: 30,
      }),
    );
    // A deploy under a step that never started would kill nothing.
    expect(begun.map(brief)).toEqual(["RunStarted", "StepStarted work"]);
    yield* Effect.sleep("5 seconds");
    yield* deployed(3);
    expect(yield* stateOf(runId)).toBe("Running");

    // Nothing is sent to the run's workflow: it comes back by its own alarm and runs the step
    // again, under the same attempt.
    yield* until(runId, "WaitingForApproval", 6);
    yield* approve(runId);
    yield* until(runId, "Succeeded", 2);

    const events = yield* eventsOf(runId);
    expectEachEventOnce(events);
    // One attempt in the log; the block itself says it was run twice.
    expect(executionsOf(events, "work")).toEqual([2]);
  }),
  { timeout: 900_000 },
);

// D3 (M2 Part D): the drill under faults the stage sets for a run. `test-drill` is the restore
// drill with a gate, `hold`, in front; the test sets the run's fault while it waits there.

/** The temporary database of a run, as the drill names it. */
const temporaryOf = (runId: string) => `restore-drill-${runId}`;

const finalStates = new Set(["Succeeded", "Failed", "Cancelled", "NeedsAttention"]);

/** Asks every three seconds until the run is in a final state, for up to `minutes`. */
const finalOf = (runId: string, minutes: number) =>
  stateOf(runId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (state) => finalStates.has(state),
      times: minutes * 20,
    }),
  );

/** Starts the held drill on the sample, sets the run's fault, and lets the run go. */
const startHeld = (fault: unknown) =>
  Effect.gen(function* () {
    const { sampleId } = yield* stack;
    if (sampleId === undefined) {
      return yield* Effect.die(new Error("The stage has no sample database."));
    }
    const started = yield* call("POST", "/runs", {
      body: {
        recipe: "test-drill",
        inputs: { production: { kind: "cloudflare.d1.database", id: sampleId } },
      },
    });
    const { runId } = yield* read(StartedResponse, started);
    drillRuns.add(runId);
    yield* until(runId, "WaitingForApproval", 2);
    const set = yield* call("POST", `/test/runs/${runId}/fault`, { body: fault });
    expect([set.status, set.text]).toEqual([200, '{"written":true}']);
    const approved = yield* call("POST", `/runs/${runId}/gates/hold/approve`);
    expect(approved.status).toBe(200);
    return runId;
  });

const marksOf = (runId: string, step: string) =>
  Effect.flatMap(call("GET", `/test/runs/${runId}/steps/${step}`), (answer) =>
    read(StepMarks, answer),
  );

/** Deletes a database the test was told is left behind, so that the account does not keep it. */
const deleteDatabase = (databaseId: string) =>
  withProviders(
    Effect.gen(function* () {
      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
      yield* d1.deleteDatabase({ accountId, databaseId });
    }),
    options,
    "Aemeth",
  );

/** The databases left with the run's id in their name. */
const leftBy = (runId: string) =>
  Effect.map(databases, (all) => all.filter((each) => each.name.includes(runId)));

const failuresOf = (events: ReadonlyArray<RunEvent>, step: string) =>
  events.flatMap((event) =>
    event._tag === "StepFailed" && event.step === step
      ? [`${event.error.name} ${event.retryable}`]
      : [],
  );

/**
 * Starts the held drill with each fault, one run after another: the next starts once the one
 * before is past its export. D1 exports a database once at a time: while it does, another
 * export is refused (`Currently processing a long-running export`) and the figures' queries
 * fail (`7500 internal error`), so drills of the same database at once fail each other.
 */
/** Whether a run is past its export: held there, at a later step, or ended. */
const pastExport = (events: ReadonlyArray<RunEvent>, heldAtExport: boolean): boolean =>
  heldAtExport ||
  events.some(
    (event) =>
      event._tag === "MainPhaseEnded" ||
      (event._tag === "StepStarted" && event.step === "createTemp"),
  );

const startOneAfterAnother = (
  faults: ReadonlyArray<{ readonly step: string; readonly fault: unknown }>,
) =>
  Effect.forEach(faults, ({ step, fault }) =>
    Effect.gen(function* () {
      const runId = yield* startHeld(fault);
      yield* Effect.all([eventsOf(runId), marksOf(runId, "export")]).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: ([events, marks]) => pastExport(events, marks.held),
          times: 150,
        }),
        Effect.flatMap(([events, marks]) =>
          pastExport(events, marks.held)
            ? Effect.void
            : Effect.die(
                new Error(
                  `The run with a fault at ${step} was not past its export in five minutes.`,
                ),
              ),
        ),
      );
      return { step, runId };
    }),
  );

test.skipIf(local)(
  "a failure for good at each step of the drill leaves no temporary database, or says so",
  Effect.gen(function* () {
    const runs = yield* startOneAfterAnother(
      drillSteps.map((step) => ({ step, fault: { _tag: "Fail", step } })),
    );
    yield* Effect.forEach(
      runs,
      ({ step, runId }) =>
        Effect.gen(function* () {
          const state = yield* finalOf(runId, 6);
          const events = yield* eventsOf(runId);
          expect([step, failuresOf(events, step)]).toEqual([step, ["PlantedFault false"]]);
          const left = yield* leftBy(runId);
          if (step === "destroyTemp") {
            // The cleanup itself failed: the run says something may be left, and it is.
            expect([step, state, left.map((each) => each.name)]).toEqual([
              step,
              "NeedsAttention",
              [temporaryOf(runId)],
            ]);
            yield* Effect.forEach(left, (each) => deleteDatabase(each.id));
          } else {
            // A record that could not be written needs a person too.
            expect([step, state, left]).toEqual([
              step,
              step === "record" ? "NeedsAttention" : "Failed",
              [],
            ]);
          }
        }),
      { concurrency: 6, discard: true },
    );
  }),
  { timeout: 900_000 },
);

test.skipIf(local)(
  "a write between the export's first figures and the export fails the step once, and the retry succeeds",
  Effect.gen(function* () {
    const runId = yield* startHeld({ _tag: "WriteBeforeExport" });
    expect(yield* finalOf(runId, 6)).toBe("Succeeded");
    const events = yield* eventsOf(runId);
    expect(failuresOf(events, "export")).toEqual(["SourceChangedDuringExport true"]);
    const outputs = yield* Schema.decodeUnknownEffect(DrillOutputs)(
      Object.fromEntries(
        events.flatMap((event) =>
          event._tag === "StepSucceeded" ? [[event.step, event.outputs]] : [],
        ),
      ),
    );
    expect(outputs.verify.rowsCompared).toBe(outputs.export.rowCount);
    expect(yield* leftBy(runId)).toEqual([]);
  }),
  { timeout: 900_000 },
);

test.skipIf(local)(
  "a create that made its database and was logged as failed leaves no database: the cleanup finds it by name",
  Effect.gen(function* () {
    const runId = yield* startHeld({ _tag: "LoseCreate" });
    expect(yield* finalOf(runId, 6)).toBe("Failed");
    const events = yield* eventsOf(runId);
    expect(failuresOf(events, "createTemp").at(-1)).toMatch(/ false$/u);
    expect(
      events.some((event) => event._tag === "StepSucceeded" && event.step === "destroyTemp"),
    ).toBe(true);
    expect(yield* leftBy(runId)).toEqual([]);
  }),
  { timeout: 900_000 },
);

test.skipIf(local)(
  "a kill in the middle of each step of the drill loses no run and makes nothing twice",
  Effect.gen(function* () {
    // Six runs, each held just after the work of a different step. One deploy that makes every
    // Durable Object take the new code at once kills all six there.
    const runs = yield* startOneAfterAnother(
      drillSteps.map((step) => ({ step, fault: { _tag: "Kill", step } })),
    );
    yield* Effect.forEach(
      runs,
      ({ step, runId }) =>
        marksOf(runId, step).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (marks) => marks.held,
            times: 80,
          }),
          // A run that never held says why, from its log.
          Effect.tap((marks) =>
            marks.held
              ? Effect.void
              : Effect.flatMap(eventsOf(runId), (events) =>
                  Effect.logError(
                    `The run to be killed at ${step} never held: ${events
                      .map((event) =>
                        event._tag === "StepFailed"
                          ? `${brief(event)} (${event.error.name}: ${event.error.message})`
                          : brief(event),
                      )
                      .join(", ")}`,
                  ),
                ),
          ),
          Effect.tap((marks) =>
            Effect.sync(() => expect([step, marks.held]).toEqual([step, true])),
          ),
        ),
      { concurrency: 6, discard: true },
    );
    yield* deployed(4);
    // The runs came back without holding. Were any not killed, it goes on now, and is counted
    // once: the test then fails, as it should.
    yield* Effect.forEach(runs, ({ runId }) => call("POST", `/test/runs/${runId}/release`), {
      discard: true,
    });

    yield* Effect.forEach(
      runs,
      ({ step, runId }) =>
        Effect.gen(function* () {
          expect([step, yield* finalOf(runId, 10)]).toEqual([step, "Succeeded"]);
          const events = yield* eventsOf(runId);
          // One attempt of every step in the log, and none failed.
          const started = events.flatMap((event) =>
            event._tag === "StepStarted" ? [event.step] : [],
          );
          expect([step, started]).toEqual([step, drillSteps]);
          expect([step, events.some((event) => event._tag === "StepFailed")]).toEqual([
            step,
            false,
          ]);
          // The block was run twice: once until the kill, once after the restart.
          expect([step, (yield* marksOf(runId, step)).executions]).toEqual([step, 2]);
          expect([step, yield* leftBy(runId)]).toEqual([step, []]);
        }),
      { concurrency: 6, discard: true },
    );
  }),
  { timeout: 1_500_000 },
);
