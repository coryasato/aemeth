import { Schema } from "effect";

/** Placeholder until M1: a step's identifier. */
export const StepId = Schema.String.pipe(Schema.check(Schema.isNonEmpty()), Schema.brand("StepId"));
export type StepId = typeof StepId.Type;

export const describeStep = (id: StepId): string => `step ${id}`;
