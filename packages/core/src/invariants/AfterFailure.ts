import type { StepId } from "../ids";
import type { Rule } from "../validate/view";

/**
 * `AfterFailure { step, then }`: if the step failed, the `then` step runs afterwards on the main
 * path. Whether `then` itself succeeds is not this rule's concern.
 *
 * Only `Failed` counts: a for-each that was cancelled partway, or a gate that was denied, did not
 * fail.
 */
export const afterFailure: Rule<{ readonly step: StepId; readonly then: StepId }> = (
  view,
  { step, then },
) => {
  const failed = view.entries.findIndex(
    (candidate) =>
      candidate.entry.phase === "Main" &&
      candidate.entry.step === step &&
      candidate.entry.outcome === "Failed",
  );
  return failed === -1 ||
    view.entries.some(
      (candidate, index) =>
        index > failed && candidate.entry.phase === "Main" && candidate.entry.step === then,
    )
    ? []
    : [`step ${step} fails and step ${then} does not run afterwards`];
};
