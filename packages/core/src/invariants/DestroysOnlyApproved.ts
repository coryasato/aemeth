import type { StepId } from "../ids";
import type { Rule } from "../validate/view";
import { describeEntry, isFromStep } from "../validate/view";

/**
 * `DestroysOnlyApproved { gate }`: everything a step, undo or `finally` step destroys is an
 * output of the gate, or an item of one. Nothing is destroyed that was not shown at the gate.
 *
 * This covers every destroy in the recipe, not only a for-each over a list. An optional input
 * left unbound destroys nothing.
 */
export const destroysOnlyApproved: Rule<{ readonly gate: StepId }> = (view, { gate }) =>
  view.entries.flatMap((candidate) =>
    candidate.touches
      .filter(
        (touch) =>
          touch.effect === "Destroys" &&
          touch.origin._tag !== "Nothing" &&
          !isFromStep(touch.origin, gate),
      )
      .map(
        (touch) =>
          `${describeEntry(candidate.entry)} destroys its input ${touch.input}, which does not come from gate ${gate}`,
      ),
  );
