import type { Declaration } from "./declare";
import {
  duration,
  fromInput,
  integer,
  noUndo,
  nothingToUndo,
  reads,
  required,
  rerun,
  resource,
  text,
  undoWith,
  writes,
} from "./declare";

const worker = resource("cloudflare.worker");
const version = resource("cloudflare.workerVersion");

export const workers: ReadonlyArray<Declaration> = [
  {
    id: "workers.planRelease",
    version: 1,
    title: "Plan a release",
    kind: "Action",
    inputs: { worker: required(worker), candidate: required(version) },
    outputs: { plan: text, previous: version },
    effects: [reads("worker"), reads("candidate")],
    undo: nothingToUndo,
    rerun,
  },
  {
    id: "workers.shiftTraffic",
    version: 1,
    title: "Shift a share of traffic to a version",
    kind: "Action",
    inputs: {
      worker: required(worker),
      candidate: required(version),
      previous: required(version),
      percent: required(integer),
    },
    outputs: {},
    effects: [writes("worker"), reads("candidate"), reads("previous")],
    undo: undoWith("workers.rollBack", 1, {
      worker: fromInput("worker"),
      previous: fromInput("previous"),
    }),
    rerun,
  },
  {
    id: "workers.checkErrorRate",
    version: 1,
    title: "Check a version's error rate",
    kind: "Check",
    inputs: {
      worker: required(worker),
      version: required(version),
      observeFor: required(duration),
      maxErrorsPerThousand: required(integer),
    },
    outputs: {},
    effects: [reads("worker"), reads("version")],
    undo: nothingToUndo,
    rerun,
  },
  {
    id: "workers.rollBack",
    version: 1,
    title: "Send all traffic to the previous version",
    kind: "Action",
    inputs: { worker: required(worker), previous: required(version) },
    outputs: {},
    effects: [writes("worker"), reads("previous")],
    undo: noUndo("Rolling back is the way back. Undoing it would promote the version that failed."),
    rerun,
  },
];
