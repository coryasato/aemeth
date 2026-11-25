import { defineConfig } from "vitest/config";

// The integration rail (docs/quality-rails.md): deploys the stack to a stage that is thrown
// away, drives the deployed engine over HTTP, and destroys the stage. Not part of `bun run
// test`: it needs a Cloudflare account, and takes minutes. Run it with `bun run test:integration`.
export default defineConfig({
  test: {
    include: ["test/**/*.integ.ts"],
    // One stage, deployed over more than once by the suite itself: nothing runs side by side.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
