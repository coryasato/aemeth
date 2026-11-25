import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { stageKind, unknownStage } from "./stages";

describe("the kind of a stage", () => {
  it("is production or staging by exactly that name", () => {
    expect(stageKind("production")).toEqual(Option.some("Production"));
    expect(stageKind("staging")).toEqual(Option.some("Staging"));
  });

  it("is thrown away for a pull request's stage and a test's", () => {
    for (const stage of ["pr-1", "pr-482", "test_ada", "test_ada-lovelace_2"]) {
      expect([stage, stageKind(stage)]).toEqual([stage, Option.some("ThrownAway")]);
    }
  });

  it("is nothing for any other name, so a slip is not deployed", () => {
    const slips = [
      "prod",
      "Production",
      "production ",
      "stage",
      "live_ada",
      "pr-",
      "pr-x",
      "pr-1-production",
      "test_",
      "test",
      "production-test_ada",
      "",
    ];
    for (const stage of slips) {
      expect([stage, stageKind(stage)]).toEqual([stage, Option.none()]);
    }
    expect(unknownStage("prod")).toContain('"prod" is not a stage');
  });
});
