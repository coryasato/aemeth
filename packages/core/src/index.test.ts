import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { describeStep, StepId } from "./index";

describe("StepId", () => {
  it.prop("round-trips through its Schema", [StepId], ([id]) => {
    expect(Schema.decodeSync(StepId)(id)).toBe(id);
  });

  it("is described by name", () => {
    expect(describeStep(Schema.decodeSync(StepId)("export"))).toBe("step export");
  });
});
