import { Effect, Layer, Option } from "effect";
import type { R2FailureReason } from "../services";
import { R2Api, R2Failed } from "../services";

// A fake of Cloudflare's R2 API for the archive check's tests (M2 Part E, E2): buckets of text
// objects in memory. A test can put an object, and make the next reads fail.

/** What the fake holds, for a test to fill and look at. */
export type FakeR2 = {
  readonly api: R2Api["Service"];
  readonly put: (bucket: string, key: string, text: string) => void;
  /** The next `times` reads fail as `reason`. */
  readonly failNext: (reason: R2FailureReason, times?: number) => void;
  /** How many reads were asked for. */
  readonly reads: () => number;
};

export const makeFakeR2 = (): FakeR2 => {
  const buckets = new Map<string, Map<string, string>>();
  const faults: Array<R2FailureReason> = [];
  let reads = 0;
  return {
    api: R2Api.of({
      get: (bucket, key) =>
        Effect.suspend(() => {
          reads += 1;
          const reason = faults.shift();
          return reason === undefined
            ? Effect.succeed(Option.fromUndefinedOr(buckets.get(bucket)?.get(key)))
            : Effect.fail(
                new R2Failed({ reason, operation: "get", message: `The fake says ${reason}.` }),
              );
        }),
    }),
    put: (bucket, key, text) => {
      const objects = buckets.get(bucket) ?? new Map<string, string>();
      objects.set(key, text);
      buckets.set(bucket, objects);
    },
    failNext: (reason, times = 1) => {
      faults.push(...Array.from({ length: times }, () => reason));
    },
    reads: () => reads,
  };
};

/** The fake as the `R2Api` layer, for a test that only needs the service. */
export const fakeR2Layer = (fake: FakeR2): Layer.Layer<R2Api> => Layer.succeed(R2Api, fake.api);
