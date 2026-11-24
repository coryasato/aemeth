import { Schema } from "effect";
import type { RunId, StepId } from "../ids";

/** Which of a step's two pieces of work a key is for: the step itself, or its undo. */
export type KeyPhase = "Forward" | "Undo";

/** The position of a for-each item in the list its step runs over, from 0. */
export const ItemIndex = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  Schema.annotate({ identifier: "ItemIndex" }),
);
export type ItemIndex = typeof ItemIndex.Type;

/**
 * The key a block is given so that running it again after a crash does nothing twice. Written as
 * `run:step:phase`, with `:item` after it for a for-each item.
 */
export const IdempotencyKey = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      // A run id and a step id of at most 64 characters each, and an item up to 1,000,000: only
      // what `idempotencyKey` can give.
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}:[a-z][a-zA-Z0-9]{0,63}:(?:Forward|Undo)(?::(?:0|[1-9][0-9]{0,5}|1000000))?$/u,
    ),
  ),
  // Stryker disable next-line StringLiteral: a brand name exists only in types, so no test can tell it apart.
  Schema.brand("IdempotencyKey"),
  Schema.annotate({ identifier: "IdempotencyKey" }),
);
export type IdempotencyKey = typeof IdempotencyKey.Type;

/**
 * The idempotency key of one piece of work (M1 decision 9). The same run, step, phase and
 * for-each item always give the same key, so every attempt of that work shares it. Any other
 * work gives a different key: a step's undo never shares its step's key, so a provider that
 * drops repeated calls cannot mistake a rollback for the call it rolls back.
 *
 * A `finally` step is `Forward`: it has a step id of its own, so its key cannot meet a main-path
 * step's.
 */
export const idempotencyKey = (
  runId: RunId,
  step: StepId,
  phase: KeyPhase,
  item: ItemIndex | undefined,
): IdempotencyKey => {
  const key =
    item === undefined ? `${runId}:${step}:${phase}` : `${runId}:${step}:${phase}:${item}`;
  // None of the parts can hold a `:`, so the text fits the pattern and no two pieces of work
  // share it. A property test decodes the keys of generated parts with the Schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return key as IdempotencyKey;
};
