import { defineConfig } from "vitest/config";

// The drill of Aemeth's own index on `staging` and `production` (M2 Part E): production drills
// staging first, then itself (decision 0008). Not a rail and not part of any check: it deploys
// the stages that are kept and runs real drills on them. Run it with `bun run drill:stages`.
export default defineConfig({
  test: {
    include: ["test/**/*.drill.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 1_800_000,
    hookTimeout: 600_000,
  },
});
