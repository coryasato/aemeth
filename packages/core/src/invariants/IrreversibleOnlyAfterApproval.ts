import type { EntryView, Rule, Touch } from "../validate/view";
import { describeEntry, isChange } from "../validate/view";

/**
 * Always on. A step that cannot be undone runs only after a gate was approved.
 *
 * A step is covered when its block declares `NoUndo` and it writes or destroys a resource, or
 * creates a `Durable` one.
 *
 * The one exemption: a write or destroy whose target is bound, through the recipe's wiring, to
 * an output that a step of the same run created with `lifetime: Temporary`. This is what lets the
 * restore drill delete its temporary database with no gate. At run time the run-ID tag stops such
 * a block from acting on anything the run did not create. An optional input left unbound touches
 * nothing. An item of a list of temporary resources is not exempt, and neither is an `Expiring`
 * or `Durable` output. Creating a `Durable` resource has no exemption.
 *
 * Undo blocks are not covered (owner, 2026-11-23): an undo takes back what its own step did, and
 * the validator separately rejects an undo block that writes or destroys anything its step did
 * not itself write or create.
 *
 * There is no per-recipe opt-out.
 */
const isExempt = (touch: Touch): boolean =>
  touch.origin._tag === "Nothing" ||
  (touch.origin._tag === "StepOutput" && touch.origin.created === "Temporary");

const isIrreversible = (view: EntryView): boolean =>
  view.entry.phase !== "Undo" &&
  view.block.undo._tag === "NoUndo" &&
  (view.touches.some((touch) => isChange(touch) && !isExempt(touch)) ||
    view.creates.some((created) => created.lifetime === "Durable"));

export const irreversibleOnlyAfterApproval: Rule<void> = (view) => {
  const approval = view.entries.findIndex((candidate) => candidate.entry.outcome === "Approved");
  return view.entries.flatMap((candidate, index) =>
    isIrreversible(candidate) && (approval === -1 || index < approval)
      ? [`${describeEntry(candidate.entry)} cannot be undone and runs before any approval`]
      : [],
  );
};
