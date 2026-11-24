import { Schema } from "effect";

/** Placeholder until M1: a step's identifier. */
// Stryker disable next-line StringLiteral: a brand name exists only in types, so no test can tell it apart.
export const StepId = Schema.String.pipe(Schema.check(Schema.isNonEmpty()), Schema.brand("StepId"));
export type StepId = typeof StepId.Type;

export const describeStep = (id: StepId): string => `step ${id}`;
