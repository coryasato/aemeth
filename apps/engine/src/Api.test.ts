import type { Recipe } from "@aemeth/core";
import { RunId } from "@aemeth/core";
import { database, edge, failed, fromRecipe, recipe, step } from "@aemeth/core/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { api, Caller, EventsResponse } from "./Api";
import { finished, waiting, withEngine } from "./testing/kit";
import type { Kit } from "./testing/kit";

const ada = "ada@example.com";
const ci = "service:8f2c.access";

/** `a` reads a database the run is given → gate `ok` → `b`. */
const gated: Recipe = recipe({
  id: "gated",
  start: "a",
  inputs: { target: { type: database } },
  nodes: [
    step("a", "t.export", { database: fromRecipe("target") }),
    step("ok", "t.gate"),
    step("b", "t.act"),
  ],
  edges: [
    edge("a", "Succeeded", "ok"),
    edge("ok", "Approved", "b"),
    edge("ok", "Denied", failed("Run")),
  ],
});

const target = { kind: "test.database", id: "db-1" };
const decodeEvents = Schema.decodeUnknownEffect(EventsResponse);

type Answer = { readonly status: number; readonly body: any };

/** One request to the API, as Access would hand it over: with the caller it named, or none. */
const call = (
  method: string,
  path: string,
  options: {
    readonly as?: string | undefined;
    readonly body?: unknown;
    readonly text?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const text =
      options.text ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const request = HttpServerRequest.fromWeb(
      new Request(`https://engine.example${path}`, {
        method,
        body: text ?? null,
      }),
    );
    const response = yield* api.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(
        Caller,
        Caller.of({ identity: Effect.succeed(Option.fromUndefinedOr(options.as)) }),
      ),
    );
    const web = HttpServerResponse.toWeb(response);
    const answer: Answer = {
      status: web.status,
      body: yield* Effect.promise(() => web.json()),
    };
    return answer;
  });

const started = (kit: Kit) =>
  Effect.gen(function* () {
    kit.recipes.set(gated.id, gated);
    const answer = yield* call("POST", "/runs", {
      as: ada,
      body: { recipe: "gated", inputs: { target } },
    });
    expect(answer.status).toBe(201);
    return yield* Effect.orDie(Schema.decodeUnknownEffect(RunId)(answer.body.runId));
  });

describe("the API", () => {
  it.effect("refuses a request with no identity, whatever it asks for", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        kit.recipes.set(gated.id, gated);
        const requests = [
          ["POST", "/runs"],
          ["GET", "/runs/abc"],
          ["GET", "/runs/abc/events"],
          ["POST", "/runs/abc/cancel"],
          ["POST", "/runs/abc/gates/ok/approve"],
          ["GET", "/nothing"],
        ] as const;
        for (const [method, path] of requests) {
          const answer = yield* call(method, path, {
            body: method === "POST" ? { recipe: "gated", inputs: { target } } : undefined,
          });
          expect([method, path, answer.status, answer.body]).toEqual([
            method,
            path,
            403,
            { error: "NoIdentity" },
          ]);
        }
        expect(kit.index.size).toBe(0);
        expect(kit.executions).toEqual([]);
      }),
    ),
  );

  it.effect("starts a run, and shows its state and its log", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        const runId = yield* started(kit);
        const events = yield* waiting(runId);

        const run = yield* call("GET", `/runs/${runId}`, { as: ci });
        expect(run.status).toBe(200);
        expect(run.body.runId).toBe(runId);
        expect(run.body.state._tag).toBe("WaitingForApproval");

        const listed = yield* call("GET", `/runs/${runId}/events`, { as: ci });
        expect(listed.status).toBe(200);
        expect(yield* Effect.orDie(decodeEvents(listed.body))).toEqual({ events });
        expect(listed.body.events[0]).toMatchObject({ _tag: "RunStarted", inputs: { target } });
      }),
    ),
  );

  it.effect("records who approved a gate, and lets the run go on", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        const runId = yield* started(kit);
        yield* waiting(runId);

        const approved = yield* call("POST", `/runs/${runId}/gates/ok/approve`, { as: ci });
        expect(approved.status).toBe(200);
        expect(approved.body.event).toMatchObject({ _tag: "ApprovalGranted", step: "ok", by: ci });

        const events = yield* finished(runId);
        expect(events.find((event) => event._tag === "ApprovalGranted")).toMatchObject({ by: ci });
        const run = yield* call("GET", `/runs/${runId}`, { as: ada });
        expect(run.body.state._tag).toBe("Succeeded");

        // The same answer again is the first one; someone else's is refused, and so is any
        // answer to a step that is not a gate.
        const again = yield* call("POST", `/runs/${runId}/gates/ok/approve`, { as: ci });
        expect([again.status, again.body.event.seq]).toEqual([200, approved.body.event.seq]);
        const other = yield* call("POST", `/runs/${runId}/gates/ok/approve`, { as: ada });
        expect([other.status, other.body]).toEqual([
          409,
          { error: "ApprovalRefused", reason: "AlreadyAnswered", step: "ok" },
        ]);
        const notGate = yield* call("POST", `/runs/${runId}/gates/a/approve`, { as: ada });
        expect([notGate.status, notGate.body.reason]).toEqual([404, "NotAGate"]);
        const extra = yield* call("POST", `/runs/${runId}/gates/ok/approve`, {
          as: ci,
          body: { outputs: { more: 1 } },
        });
        expect([extra.status, extra.body.reason]).toEqual([422, "OutputsDoNotFit"]);
      }),
    ),
  );

  it.effect("records who denied a gate and who cancelled", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        const first = yield* started(kit);
        yield* waiting(first);
        const denied = yield* call("POST", `/runs/${first}/gates/ok/deny`, { as: ada });
        expect([denied.status, denied.body.event._tag, denied.body.event.by]).toEqual([
          200,
          "ApprovalDenied",
          ada,
        ]);
        yield* finished(first);
        // A run that is over takes nothing more.
        const late = yield* call("POST", `/runs/${first}/cancel`, { as: ada });
        expect([late.status, late.body.error, late.body.rejected.state]).toEqual([
          409,
          "EventRejected",
          "Failed",
        ]);

        const second = yield* started(kit);
        yield* waiting(second);
        const cancelled = yield* call("POST", `/runs/${second}/cancel`, { as: ci });
        expect([cancelled.status, cancelled.body.event._tag, cancelled.body.event.by]).toEqual([
          200,
          "CancellationRequested",
          ci,
        ]);
        const events = yield* finished(second);
        expect(events.at(-1)?._tag).toBe("RunCancelled");
      }),
    ),
  );

  it.effect("refuses a run it cannot start, and says why", () =>
    withEngine((kit) =>
      Effect.gen(function* () {
        kit.recipes.set(gated.id, gated);
        const unknown = yield* call("POST", "/runs", { as: ada, body: { recipe: "nope" } });
        expect([unknown.status, unknown.body.reason]).toEqual([404, "RecipeNotFound"]);
        const noInputs = yield* call("POST", "/runs", { as: ada, body: { recipe: "gated" } });
        expect([noInputs.status, noInputs.body.error, noInputs.body.reason]).toEqual([
          422,
          "RunRefused",
          "InputsInvalid",
        ]);
        const bodies = ["{", "[]", '{"recipe": 1}', '{"recipe": "gated", "extra": true}'];
        for (const text of bodies) {
          const answer = yield* call("POST", "/runs", { as: ada, text });
          expect([text, answer.status, answer.body]).toEqual([text, 400, { error: "BadRequest" }]);
        }
        expect(kit.index.size).toBe(0);
      }),
    ),
  );

  it.effect("knows nothing of a run that was never started, or of any other path", () =>
    withEngine(() =>
      Effect.gen(function* () {
        const missing = yield* call("GET", "/runs/00000000000000000000000000", { as: ada });
        expect([missing.status, missing.body.error]).toEqual([404, "RunNotFound"]);
        const requests = [
          ["GET", "/"],
          ["GET", "/runs"],
          ["DELETE", "/runs/00000000000000000000000000"],
          ["GET", "/runs/NOT A RUN ID"],
          ["POST", "/runs/00000000000000000000000000/events"],
          ["GET", "/runs/00000000000000000000000000/cancel"],
          ["POST", "/runs/00000000000000000000000000/gates/ok"],
          ["POST", "/runs/00000000000000000000000000/gates/ok/approve/more"],
          ["POST", "/runs/00000000000000000000000000/gates/ok/shrug"],
          ["GET", "/test/runs/00000000000000000000000000/record"],
        ] as const;
        for (const [method, path] of requests) {
          const answer = yield* call(method, path, { as: ada });
          expect([method, path, answer.status, answer.body]).toEqual([
            method,
            path,
            404,
            { error: "NotFound" },
          ]);
        }
      }),
    ),
  );
});
