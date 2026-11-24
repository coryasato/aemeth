import type { Declaration } from "./declare";
import {
  destroys,
  duration,
  list,
  noUndo,
  nothingToUndo,
  reads,
  required,
  rerun,
  resource,
} from "./declare";

const app = resource("alchemy.app");
export const stack = resource("alchemy.stack");
export const orphan = resource("alchemy.orphanedResource");

export const alchemy: ReadonlyArray<Declaration> = [
  {
    id: "alchemy.listStaleResources",
    version: 1,
    title: "List stale preview stacks and resources with no owning stack",
    kind: "Action",
    inputs: { app: required(app), olderThan: required(duration) },
    outputs: { stacks: list(stack), orphans: list(orphan) },
    effects: [reads("app")],
    undo: nothingToUndo,
    rerun,
  },
  {
    id: "alchemy.destroyStack",
    version: 1,
    title: "Destroy a stack",
    kind: "Action",
    inputs: { stack: required(stack) },
    outputs: {},
    effects: [destroys("stack")],
    undo: noUndo("A destroyed stack's resources and their data cannot be brought back."),
    rerun,
  },
  {
    id: "alchemy.destroyOrphanedResource",
    version: 1,
    title: "Destroy a resource with no owning stack",
    kind: "Action",
    inputs: { resource: required(orphan) },
    outputs: {},
    effects: [destroys("resource")],
    undo: noUndo("A destroyed resource and its data cannot be brought back."),
    rerun,
  },
];
