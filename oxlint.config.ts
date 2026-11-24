import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    "**/dist/**",
    "**/coverage/**",
    "**/reports/**",
    "**/.stryker-tmp/**",
  ],
  rules: {
    // Effect code imports modules as namespaces: `import * as Schema from "effect/Schema"`.
    "import-x/no-namespace": "off",
    // `Effect.gen(function* () { return x })` is valid Effect code with no yield.
    "require-yield": "off",
    // `instanceof` is how tagged error classes are narrowed.
    "@nkzw/no-instanceof": "off",
    // `Schema.isPattern` reaches the generated JSON Schema only if the RegExp has the `u` flag;
    // without it the constraint is silently dropped (M1 Part A findings).
    "require-unicode-regexp": "error",
  },
  overrides: [
    {
      // A test keeps its small helpers next to the cases that use them, inside `describe`.
      // Style only; listed as "adjust if noisy" in docs/quality-rails.md.
      files: ["**/*.test.ts"],
      rules: { "unicorn/consistent-function-scoping": "off" },
    },
    {
      // Files at the top of packages/core leave the package with a single `../`.
      files: ["packages/core/*"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["@aemeth/*"],
                message: "packages/core must not import another workspace package (decision 0007).",
              },
              {
                group: ["../*", "../**"],
                message:
                  "packages/core must not import from outside its own package (decision 0007).",
              },
            ],
          },
        ],
      },
    },
    {
      // packages/core imports no other workspace package (decision 0007).
      files: ["packages/core/*/**"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["@aemeth/*"],
                message: "packages/core must not import another workspace package (decision 0007).",
              },
              {
                group: ["../../*", "../../**"],
                message:
                  "packages/core must not import from outside its own package (decision 0007).",
              },
            ],
          },
        ],
      },
    },
  ],
});
