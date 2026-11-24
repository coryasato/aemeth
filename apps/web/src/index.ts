import type { StepId } from "@aemeth/core";
import { describeStep } from "@aemeth/core";

/** Placeholder until M3: the heading shown for a step. */
export const stepHeading = (id: StepId): string => describeStep(id).toUpperCase();
