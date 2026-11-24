import type { Name, StepId } from "../ids";
import type { PathView, Rule } from "../validate/view";
import { isFromStep } from "../validate/view";

/**
 * Whether, on this path, the output of the step is destroyed after the step succeeded.
 *
 * Holds when the step did not succeed (there is nothing to clean up), when a later step, undo or
 * `finally` step that destroys that output succeeded, or when that same destroying step was
 * attempted, failed, and the run ended in `NeedsAttention`, so a person is told what was left
 * behind. It does not hold when the destroy is never attempted, even if some other cleanup failed
 * and the run ended in `NeedsAttention`. A for-each that destroys the items of the output counts.
 */
export const isCleanedUp = (view: PathView, step: StepId, output: Name): boolean => {
  const created = view.entries.findIndex(
    (candidate) =>
      candidate.entry.phase !== "Undo" &&
      candidate.entry.step === step &&
      candidate.entry.outcome === "Succeeded",
  );
  return (
    created === -1 ||
    view.entries.some(
      (candidate, index) =>
        index > created &&
        candidate.touches.some(
          (touch) => touch.effect === "Destroys" && isFromStep(touch.origin, step, output),
        ) &&
        (candidate.entry.outcome === "Succeeded" ||
          (candidate.entry.outcome === "Failed" && view.path.result === "NeedsAttention")),
    )
  );
};

/**
 * `CleanedUp { step, output }`: if the step succeeded, its output is destroyed afterwards, or the
 * destroy was attempted, failed, and the run ended in `NeedsAttention`.
 */
export const cleanedUp: Rule<{ readonly step: StepId; readonly output: Name }> = (
  view,
  { output, step },
) =>
  isCleanedUp(view, step, output)
    ? []
    : [`output ${output} of step ${step} is not destroyed after the step succeeded`];
