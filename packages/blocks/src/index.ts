import type { StepId } from "@aemeth/core";
import { describeStep } from "@aemeth/core";

/** Placeholder until M2: the label a block shows for a step. */
export const blockLabel = (id: StepId): string => `block for ${describeStep(id)}`;
