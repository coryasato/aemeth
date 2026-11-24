import { describe, expect, it } from "@effect/vitest";
import { isStage } from "./index";

describe("isStage", () => {
  it("accepts only known stages", () => {
    expect(isStage("staging")).toBe(true);
    expect(isStage("preview")).toBe(false);
  });
});
