import type { Name } from "../ids";
import type { Rule } from "../validate/view";
import { describeEntry, isChange, isFromRecipeInput } from "../validate/view";

/**
 * `NoWriteBeforeApproval { input }`: nothing writes or destroys a resource bound from that recipe
 * input, or an item of it, before a gate was approved. On a path with no approval, nothing writes
 * it at all.
 */
export const noWriteBeforeApproval: Rule<{ readonly input: Name }> = (view, { input }) => {
  const approval = view.entries.findIndex((candidate) => candidate.entry.outcome === "Approved");
  return view.entries.flatMap((candidate, index) =>
    approval === -1 || index < approval
      ? candidate.touches
          .filter((touch) => isChange(touch) && isFromRecipeInput(touch.origin, input))
          .map(
            (touch) =>
              `${describeEntry(candidate.entry)} ${touch.effect === "Writes" ? "writes" : "destroys"} recipe input ${input} before any approval`,
          )
      : [],
  );
};
