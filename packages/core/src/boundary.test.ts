import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import manifest from "../package.json" with { type: "json" };

// packages/core depends on nothing in this repository (decision 0007).
// The import half of this rule is the `no-restricted-imports` override in oxlint.config.ts.
const Dependencies = Schema.Record(Schema.String, Schema.String);
const Manifest = Schema.Struct({
  dependencies: Schema.optional(Dependencies),
  devDependencies: Schema.optional(Dependencies),
  peerDependencies: Schema.optional(Dependencies),
  optionalDependencies: Schema.optional(Dependencies),
});

// Ranges that point at a local folder rather than a published release.
const localRange = /^(workspace|file|link|portal):/;

describe("packages/core boundary", () => {
  it("lists no workspace or local package as a dependency", () => {
    const { dependencies, devDependencies, peerDependencies, optionalDependencies } =
      Schema.decodeSync(Manifest)(manifest);
    const localDeps = [
      dependencies,
      devDependencies,
      peerDependencies,
      optionalDependencies,
    ].flatMap((section) =>
      Object.entries(section ?? {})
        .filter(([name, range]) => name.startsWith("@aemeth/") || localRange.test(range))
        .map(([name]) => name),
    );
    expect(localDeps).toEqual([]);
  });
});
