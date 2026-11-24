import type { StepId } from "../ids";
import type { Rule } from "../validate/view";

/**
 * `RequiredForSuccess { step }`: a path whose main phase ends `Succeeded` passed the step with
 * `Succeeded`.
 *
 * The main result is what is checked, not the run's final result, so the rule also holds on a
 * path where the main phase succeeded and a cleanup then failed (`NeedsAttention`). That is the
 * stricter reading of "a successful run always has matching checksums".
 */
export const requiredForSuccess: Rule<{ readonly step: StepId }> = (view, { step }) =>
  view.path.main.result !== "Succeeded" ||
  view.entries.some(
    (candidate) =>
      candidate.entry.phase === "Main" &&
      candidate.entry.step === step &&
      candidate.entry.outcome === "Succeeded",
  )
    ? []
    : [`the main path succeeds without step ${step} having succeeded`];
