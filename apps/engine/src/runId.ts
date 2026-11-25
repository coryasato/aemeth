import { RunId } from "@aemeth/core";
import { Clock, Effect, Random, Schema } from "effect";

// Crockford's base 32, in lower case: no `i`, `l`, `o` or `u`.
const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
const timeLength = 10;
const randomLength = 16;

const encodeTime = (millis: number): string => {
  let rest = millis;
  let text = "";
  for (let place = 0; place < timeLength; place += 1) {
    text = `${alphabet[rest % 32] ?? "0"}${text}`;
    rest = Math.floor(rest / 32);
  }
  return text;
};

const decode = Schema.decodeEffect(RunId);

/**
 * A new run's id: 26 characters, lower case, sortable by the time it was made (M2 decision 5).
 * Ten characters of time and sixteen of randomness, as a ULID has. A temporary resource carries
 * it in its name, so it is short and has nothing but letters and digits.
 */
export const makeRunId: Effect.Effect<RunId> = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const random = yield* Effect.forEach(Array.from({ length: randomLength }), () =>
    Random.nextIntBetween(0, 31),
  );
  const id = `${encodeTime(now)}${random.map((index) => alphabet[index] ?? "0").join("")}`;
  // Twenty-six letters and digits always fit the pattern of a run id.
  return yield* Effect.orDie(decode(id));
});
