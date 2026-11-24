import { BlockSpec } from "@aemeth/core";
import { Schema } from "effect";
import { alchemy } from "./alchemy";
import { artifacts } from "./artifacts";
import { d1 } from "./d1";
import type { Declaration } from "./declare";
import { gate } from "./gate";
import { record } from "./record";
import { secrets } from "./secrets";
import { workers } from "./workers";

/**
 * Every block the six recipes use, as written: what each one takes, returns, touches and how it
 * is undone. There are no implementations yet; those arrive with the recipes, from M2.
 */
export const declarations: ReadonlyArray<Declaration> = [
  ...d1,
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
