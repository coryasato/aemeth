import type { EventRejected } from "@aemeth/core";
import { RunEvent, RunId, RunState, StepId } from "@aemeth/core";
import type { Option } from "effect";
import { Context, Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { ActorRefused, ApprovalRefused, RunRefused } from "./Engine";
import { Engine } from "./Engine";
import type { RunNotFound } from "./RunLog";

/**
 * Who is asking, as Cloudflare Access established it: a person's email, or `service:<client id>`
 * for a service token (decision 0006). `None` when the request carries no Access identity.
 */
export class Caller extends Context.Service<
  Caller,
  { readonly identity: Effect.Effect<Option.Option<string>> }
>()("@aemeth/engine/Caller") {}

const Values = Schema.Record(Schema.String, Schema.Json);

/** `POST /runs`. */
export const StartRequest = Schema.Struct({
  recipe: Schema.String,
  inputs: Schema.optional(Values),
});
/** `POST /runs/:id/gates/:step/approve`: what was approved, for a gate that has outputs. */
export const ApproveRequest = Schema.Struct({ outputs: Schema.optional(Values) });

export const StartedResponse = Schema.Struct({ runId: RunId });
export const RunResponse = Schema.Struct({ runId: RunId, state: RunState });
export const EventsResponse = Schema.Struct({ events: Schema.Array(RunEvent) });
export const EventResponse = Schema.Struct({ event: RunEvent });

const decodeRunId = Schema.decodeUnknownOption(RunId);
const decodeStepId = Schema.decodeUnknownOption(StepId);

/** A refusal, as JSON: what kind, and whatever says why. */
const refuse = (
  status: number,
  error: string,
  more: { readonly [key: string]: Schema.Json } = {},
) => HttpServerResponse.jsonUnsafe({ error, ...more }, { status });

const notFound = refuse(404, "NotFound");

/** The path of a request's URL, whether it came with an origin or not, without its query. */
export const pathOf = (url: string): string =>
  url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/iu, "").split(/[?#]/u)[0] ?? "";

// A body the Schema cannot encode is the engine's own fault, never the caller's.
const reply = <A, I>(schema: Schema.Codec<A, I>, body: A, status = 200) =>
  Effect.orDie(HttpServerResponse.schemaJson(schema)(body, { status }));

/** The request's body against a Schema. An empty body reads as `{}`, a bad one as `undefined`. */
const bodyOf = <A, I>(schema: Schema.Codec<A, I>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* request.text;
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema), {
      onExcessProperty: "error",
    })(text.trim() === "" ? "{}" : text);
  }).pipe(
    Effect.map((body): A | undefined => body),
    // A body that cannot be read, is not JSON or does not fit is one answer: 400.
    Effect.catch(() => Effect.undefined),
  );

type Refusal = RunRefused | RunNotFound | EventRejected | ApprovalRefused | ActorRefused;

const statusOfApprovalRefused = {
  NotAGate: 404,
  OutputsDoNotFit: 422,
  AlreadyAnswered: 409,
} as const;

/** Every way the engine says no, as a response. None of them is a server error. */
const refusal = (error: Refusal): HttpServerResponse.HttpServerResponse => {
  switch (error._tag) {
    case "RunRefused": {
      return refuse(error.reason === "RecipeNotFound" ? 404 : 422, error._tag, {
        reason: error.reason,
        detail: error.detail,
      });
    }
    case "RunNotFound": {
      return refuse(404, error._tag, { runId: error.runId });
    }
    case "EventRejected": {
      // The run is not in a state that takes this: a gate that is not open, a run that is over.
      return refuse(409, error._tag, { rejected: error });
    }
    case "ApprovalRefused": {
      return refuse(statusOfApprovalRefused[error.reason], error._tag, {
        reason: error.reason,
        step: error.step,
      });
    }
    case "ActorRefused": {
      return refuse(403, error._tag);
    }
  }
};

type Route = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Refusal,
  Engine | HttpServerRequest.HttpServerRequest
>;

const route = (method: string, segments: ReadonlyArray<string>, by: string): Route =>
  Effect.gen(function* () {
    const engine = yield* Engine;
    const [root, id, third, step, verb, ...rest] = segments;
    if (root !== "runs" || rest.length > 0) {
      return notFound;
    }
    if (id === undefined) {
      if (method !== "POST") {
        return notFound;
      }
      const body = yield* bodyOf(StartRequest);
      if (body === undefined) {
        return refuse(400, "BadRequest");
      }
      const runId = yield* engine.start(body.recipe, body.inputs ?? {});
      return yield* reply(StartedResponse, { runId }, 201);
    }
    const runId = decodeRunId(id);
    if (runId._tag === "None") {
      return notFound;
    }
    if (third === undefined) {
      if (method !== "GET") {
        return notFound;
      }
      const { state } = yield* engine.read(runId.value);
      return yield* reply(RunResponse, { runId: runId.value, state });
    }
    if (third === "events" && step === undefined && method === "GET") {
      const { events } = yield* engine.read(runId.value);
      return yield* reply(EventsResponse, { events });
    }
    if (third === "cancel" && step === undefined && method === "POST") {
      const event = yield* engine.cancel(runId.value, by);
      return yield* reply(EventResponse, { event });
    }
    const gate = decodeStepId(step);
    if (third !== "gates" || gate._tag === "None" || method !== "POST") {
      return notFound;
    }
    if (verb === "deny") {
      const event = yield* engine.deny(runId.value, gate.value, by);
      return yield* reply(EventResponse, { event });
    }
    if (verb === "approve") {
      const body = yield* bodyOf(ApproveRequest);
      if (body === undefined) {
        return refuse(400, "BadRequest");
      }
      const event = yield* engine.approve(runId.value, gate.value, by, body.outputs ?? {});
      return yield* reply(EventResponse, { event });
    }
    return notFound;
  });

/**
 * The engine's API (M2 decision 11): six routes over `Engine`, for a caller Access has named.
 *
 * - `POST /runs`
 * - `GET /runs/:id` and `GET /runs/:id/events`
 * - `POST /runs/:id/gates/:step/approve` and `/deny`
 * - `POST /runs/:id/cancel`
 *
 * A request with no identity is refused before anything is read. Whoever the caller is goes
 * into the log as the `by` of an approval, a denial or a cancel.
 */
export const api: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  Engine | Caller | HttpServerRequest.HttpServerRequest
> = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const caller = yield* Caller;
  const identity = yield* caller.identity;
  if (identity._tag === "None") {
    return refuse(403, "NoIdentity");
  }
  const segments = pathOf(request.url)
    .split("/")
    .filter((segment) => segment !== "");
  return yield* route(request.method, segments, identity.value).pipe(
    Effect.catch((error) => Effect.succeed(refusal(error))),
  );
});
