import type { StepId } from "../ids";
import type { Rule } from "../validate/view";

/**
 * `OnlyAfter { step, requires }`: the step runs only on paths where every required step has
 * already succeeded, or been approved if it is a gate. A required for-each must have succeeded
 * for every item.
 */
export const onlyAfter: Rule<{
  readonly step: StepId;
  readonly requires: ReadonlyArray<StepId>;
}> = (view, { requires, step }) => {
  const ran = view.entries.findIndex(
    (candidate) => candidate.entry.phase !== "Undo" && candidate.entry.step === step,
  );
  return ran === -1
    ? []
    : requires
        .filter(
          (required) =>
            !view.entries.some(
              (candidate, index) =>
                index < ran &&
                candidate.entry.phase !== "Undo" &&
                candidate.entry.step === required &&
                (candidate.entry.outcome === "Succeeded" || candidate.entry.outcome === "Approved"),
            ),
        )
        .map((required) => `step ${step} runs without step ${required} having succeeded`);
};
