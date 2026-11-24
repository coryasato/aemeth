import { orphan, stack } from "./alchemy";
import { repository } from "./artifacts";
import type { Declaration } from "./declare";
import { list, nothingToUndo, required, rerun, resource, text } from "./declare";
import { credential } from "./secrets";

// A gate changes nothing itself: it shows its inputs to a person and waits. Its outputs are
// what the person approved.
const gateBlock = (
  id: string,
  title: string,
  inputs: Declaration["inputs"],
  outputs: Declaration["outputs"] = {},
): Declaration => ({
  id,
  version: 1,
  title,
  kind: "Gate",
  inputs,
  outputs,
  effects: [],
  undo: nothingToUndo,
  rerun,
});

export const gate: ReadonlyArray<Declaration> = [
  gateBlock(
    "gate.approveDestruction",
    "Approve exactly what will be destroyed",
    { stacks: required(list(stack)), orphans: required(list(orphan)) },
    { approvedStacks: list(stack), approvedOrphans: list(orphan) },
  ),
  gateBlock("gate.approveRelease", "Approve a release plan", { plan: required(text) }),
  gateBlock("gate.approveMigration", "Approve a migration that cannot be undone", {
    database: required(resource("cloudflare.d1.database")),
    migration: required(text),
  }),
  gateBlock("gate.approveRevocation", "Approve revoking a credential", {
    credential: required(credential),
  }),
  gateBlock("gate.approveMerge", "Approve merging a commit", {
    repository: required(repository),
    commit: required(text),
  }),
];
