import type { Name } from "../ids";
import type { Rule } from "../validate/view";
import { describeEntry, isChange, isFromRecipeInput } from "../validate/view";

/**
 * `NeverWritten { input }`: no step, undo or `finally` step writes or destroys a resource bound
 * from that recipe input, or an item of it. A step that was attempted and failed counts: it may
 * have written before it failed.
 */
export const neverWritten: Rule<{ readonly input: Name }> = (view, { input }) =>
  view.entries.flatMap((candidate) =>
    candidate.touches
      .filter((touch) => isChange(touch) && isFromRecipeInput(touch.origin, input))
      .map(
        (touch) =>
          `${describeEntry(candidate.entry)} ${touch.effect === "Writes" ? "writes" : "destroys"} recipe input ${input}`,
      ),
  );
