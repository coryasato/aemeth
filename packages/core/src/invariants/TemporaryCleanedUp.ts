import type { Rule } from "../validate/view";
import { describeEntry } from "../validate/view";
import { isCleanedUp } from "./CleanedUp";

/**
 * Always on (owner, 2026-11-23). Whenever a step that creates a `Temporary` output succeeds, that
 * output is cleaned up on the same path, in the sense of `CleanedUp`: a later step, undo or
 * `finally` step destroys it, or tried to, failed, and the run ended in `NeedsAttention`.
 *
 * A recipe no longer has to remember to assert `CleanedUp` for its temporary resources. An
 * `Expiring` output goes away by itself and is not covered; a `Durable` one is meant to stay.
 *
 * Not covered: a for-each step that creates temporary resources and then fails or is cancelled
 * partway. Its list output cannot be read, so nothing in the recipe can name what it created.
 */
export const temporaryCleanedUp: Rule<void> = (view) =>
  view.entries.flatMap((candidate) =>
    candidate.entry.phase === "Undo" || candidate.entry.outcome !== "Succeeded"
      ? []
      : candidate.creates
          .filter(
            (created) =>
              created.lifetime === "Temporary" &&
              !isCleanedUp(view, candidate.entry.step, created.output),
          )
          .map(
            (created) =>
              `${describeEntry(candidate.entry)} creates temporary output ${created.output}, which is not destroyed afterwards`,
          ),
  );
