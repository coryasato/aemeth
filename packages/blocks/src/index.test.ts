import { StepId } from "@aemeth/core";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { blockLabel } from "./index";

describe("blockLabel", () => {
  it("labels a step", () => {
    expect(blockLabel(Schema.decodeSync(StepId)("export"))).toBe("block for step export");
  });
});
