import { StepId } from "@aemeth/core";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { stepHeading } from "./index";

describe("stepHeading", () => {
  it("upper-cases the description", () => {
    expect(stepHeading(Schema.decodeSync(StepId)("export"))).toBe("STEP EXPORT");
  });
});
