import { Option } from "effect";

/**
 * What a stage is (M2, "Deployment"). `Production` and `Staging` are kept; a `ThrownAway` stage
 * belongs to a pull request or a test run, takes new code at once, carries the fixtures and
 * loses its data when it is destroyed.
 */
export type StageKind = "Production" | "Staging" | "ThrownAway";

const thrownAway = [/^pr-[0-9]+$/u, /^test_[a-z0-9][a-z0-9_-]*$/u];

/**
 * The kind of a stage, by its name: `production`, `staging`, `pr-<number>` or `test_<name>`.
 * Any other name is no stage at all. A stage that is thrown away is named as one on purpose, so
 * that a slip such as `prod` cannot be deployed as something to throw away, or deployed at all.
 */
export const stageKind = (stage: string): Option.Option<StageKind> => {
  if (stage === "production") {
    return Option.some("Production");
  }
  if (stage === "staging") {
    return Option.some("Staging");
  }
  return thrownAway.some((pattern) => pattern.test(stage))
    ? Option.some("ThrownAway")
    : Option.none();
};

/** What a deploy to a stage with any other name is refused with. */
export const unknownStage = (stage: string): string =>
  `"${stage}" is not a stage of Aemeth. A stage is production, staging, pr-<number> or test_<name>.`;
