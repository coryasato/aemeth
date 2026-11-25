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
import { RecordResponse } from "@aemeth/engine/cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "@alchemy.run/test/Vitest";
import { expect } from "@effect/vitest";
import { Effect, Redacted, Result, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import Stack from "../alchemy.run";

// The integration rail (M2 Part C): the engine as it is deployed, on a stage that is thrown
// away. It shows what no test in memory can: that the Worker bundles and starts, that Access
// stands in front of it, that a run survives a deploy at its gate and a kill in the middle of a
// step with each event in its log once, and that a finished run is archived and indexed.
//
// The stage is `$ALCHEMY_TEST_STAGE` (`pr-<number>` in CI), or `test_$USER`. With
// `ALCHEMY_DEV=1` the same suite runs on local emulators, where there is no Access and a deploy
// does not kill a Durable Object, so the tests of those two are skipped there.

const local = process.env["ALCHEMY_DEV"] === "1" || process.env["ALCHEMY_TEST_DEV"] === "1";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

/** Deploys the stack as a new build: the same code, and still a deploy. */
const deployed = (build: number) =>
  Effect.suspend(() => {
    process.env["AEMETH_BUILD"] = `${Date.now()}-${build}`;
    return deploy(Stack);
  });

const stack = beforeAll(deployed(1), { timeout: 600_000 });

/** How many requests without credentials reached the Worker: Access was not in front of it. */
let seenWithoutAccess = 0;

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
 * One request to the deployed engine. Access is not always in front of the Worker: for some
 * seconds after a stage is created, and now and then around a deploy, a request arrives with no
 * identity, and the engine itself refuses it (`NoIdentity`). That is the engine doing its part;
 * for a caller with the token it means "not yet", so it is asked again, for up to a minute.
 */
const call: typeof once = (method, path, options = {}) =>
  once(method, path, options).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (answer) => options.anonymous === true || !answer.text.includes("NoIdentity"),
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
