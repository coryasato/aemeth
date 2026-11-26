import { orphan, stack } from "./alchemy";
import type { Declaration } from "./declare";
import { integer, list, nothingToUndo, optional, rerun, text } from "./declare";

// A record block writes to the run's record through a service the engine provides. That is not
// a resource the recipe names, so it has no effect to declare (see "Gaps found" in the M1 spec).
// Every input is optional: these run as `finally` steps, when earlier steps may not have run.
const recordBlock = (
  id: string,
  title: string,
  inputs: Declaration["inputs"],
  version = 1,
): Declaration => ({
  id,
  version,
  title,
  kind: "Action",
  inputs,
  outputs: {},
  effects: [],
  undo: nothingToUndo,
  rerun,
});

export const recordRestoreDrillSpec = recordBlock(
  "record.restoreDrill",
  "Record the result of a restore drill",
  { rowsCompared: optional(integer), checksum: optional(text), runsChecked: optional(integer) },
  // Version 2 adds `runsChecked`, the archived runs the drill of Aemeth's own index replayed.
  2,
);

export const record: ReadonlyArray<Declaration> = [
  recordRestoreDrillSpec,
  recordBlock("record.cleanup", "Record what a cleanup was approved to destroy", {
    approvedStacks: optional(list(stack)),
    approvedOrphans: optional(list(orphan)),
  }),
  recordBlock("record.release", "Record the result of a release", { plan: optional(text) }),
];
