import { BlockSpec } from "@aemeth/core";
import { Schema } from "effect";
import { alchemy } from "./alchemy";
import { archive } from "./archive";
import { artifacts } from "./artifacts";
import { d1 } from "./d1";
import type { Declaration } from "./declare";
import { gate } from "./gate";
import { record } from "./record";
import { secrets } from "./secrets";
import { workers } from "./workers";

export type { Block, BlockInputs, BlockOutputs, StepContext } from "./implement";
export { BlockFailed, implement, Secrets } from "./implement";
export type { D1Database, D1FailureReason, D1Row, R2FailureReason } from "./services";
export { D1Api, D1Failed, R2Api, R2Failed, RecordUnavailable, RunRecord } from "./services";
export type { Figures } from "./drill";
export { drillBlocks, figuresOf, sampleSize, temporaryName } from "./drill";

/**
 * Every block the seven recipes use (the six of docs/recipes.md and the drill of Aemeth's own
 * index), as written: what each one takes, returns, touches and how it is undone. The implementations arrive with the recipes, from M2 Part D; `implement` is the
 * contract they follow.
 */
export const declarations: ReadonlyArray<Declaration> = [
  ...d1,
  ...archive,
  ...alchemy,
  ...workers,
  ...secrets,
  ...artifacts,
  ...gate,
  ...record,
];

/** The declarations decoded by the `BlockSpec` Schema, or the reason one of them does not decode. */
export const blockSpecs = Schema.decodeResult(Schema.Array(BlockSpec), {
  onExcessProperty: "error",
})(declarations);
