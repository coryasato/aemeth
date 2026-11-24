import { afterFailure } from "../invariants/AfterFailure";
import { cleanedUp } from "../invariants/CleanedUp";
import { destroysOnlyApproved } from "../invariants/DestroysOnlyApproved";
import { irreversibleOnlyAfterApproval } from "../invariants/IrreversibleOnlyAfterApproval";
import { neverWritten } from "../invariants/NeverWritten";
import { noWriteBeforeApproval } from "../invariants/NoWriteBeforeApproval";
import { onlyAfter } from "../invariants/OnlyAfter";
import { requiredForSuccess } from "../invariants/RequiredForSuccess";
import { temporaryCleanedUp } from "../invariants/TemporaryCleanedUp";
import type { InvariantRef } from "../Recipe";
import type { Path } from "./paths";
import type { PathView } from "./view";

/** The rules that apply to every recipe. A recipe cannot opt out of them. */
export type AlwaysOnRule = "IrreversibleOnlyAfterApproval" | "TemporaryCleanedUp";
export type RuleName = AlwaysOnRule | InvariantRef["rule"];

/** A rule that does not hold on a path, with that path. */
export type Violation = {
  readonly rule: RuleName;
  readonly message: string;
  readonly path: Path;
};

type Check = { readonly rule: RuleName; readonly run: (view: PathView) => ReadonlyArray<string> };

const alwaysOn: ReadonlyArray<Check> = [
  { rule: "IrreversibleOnlyAfterApproval", run: (view) => irreversibleOnlyAfterApproval(view) },
  { rule: "TemporaryCleanedUp", run: (view) => temporaryCleanedUp(view) },
];

const asserted = (invariant: InvariantRef): Check => {
  switch (invariant.rule) {
    case "NeverWritten": {
      return { rule: invariant.rule, run: (view) => neverWritten(view, invariant) };
    }
    case "CleanedUp": {
      return { rule: invariant.rule, run: (view) => cleanedUp(view, invariant) };
    }
    case "RequiredForSuccess": {
      return { rule: invariant.rule, run: (view) => requiredForSuccess(view, invariant) };
    }
    case "NoWriteBeforeApproval": {
      return { rule: invariant.rule, run: (view) => noWriteBeforeApproval(view, invariant) };
    }
    case "AfterFailure": {
      return { rule: invariant.rule, run: (view) => afterFailure(view, invariant) };
    }
    case "DestroysOnlyApproved": {
      return { rule: invariant.rule, run: (view) => destroysOnlyApproved(view, invariant) };
    }
    case "OnlyAfter": {
      return { rule: invariant.rule, run: (view) => onlyAfter(view, invariant) };
    }
  }
};

/**
 * Stage 7 of validation: the always-on rules and the rules the recipe asserts, each on every
 * path. Every violation carries the path it was found on.
 */
export const checkInvariants = (
  invariants: ReadonlyArray<InvariantRef>,
  views: ReadonlyArray<PathView>,
): ReadonlyArray<Violation> => {
  const checks = [...alwaysOn, ...invariants.map(asserted)];
  return checks.flatMap((check) =>
    views.flatMap((view) =>
      check.run(view).map((message) => ({ rule: check.rule, message, path: view.path })),
    ),
  );
};
