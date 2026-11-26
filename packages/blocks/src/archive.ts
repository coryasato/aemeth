import type { Declaration } from "./declare";
import { integer, nothingToUndo, reads, required, rerun, resource } from "./declare";

/**
 * `archive.checkReplay` (M2 decision 13): when the drill's target is Aemeth itself, a sample of
 * the runs its index says are archived is read back from the archive and replayed through
 * `transition`, and each must reach the final state the index records. The index read is the
 * restored copy, so the check says the backup agrees with the archive, not only that it loads.
 */
export const checkReplaySpec: Declaration = {
  id: "archive.checkReplay",
  version: 1,
  title: "Check that archived run logs replay to the states an index records",
  kind: "Check",
  inputs: {
    index: required(resource("cloudflare.d1.database")),
    archive: required(resource("cloudflare.r2.bucket")),
  },
  outputs: { runsChecked: integer },
  effects: [reads("index"), reads("archive")],
  undo: nothingToUndo,
  rerun,
};

export const archive: ReadonlyArray<Declaration> = [checkReplaySpec];
