# apps/engine

The engine: it runs published recipes. In M2 Part B it is pure code that runs in memory; the Cloudflare Worker, the API and the stored log arrive in Part C.

Depends on `packages/core` and `packages/blocks`. It is the only package that imports `effect/workflow`, and that module is used behind `Engine`, so it can be replaced without touching `packages/core` (see [decision 0003](../../docs/decisions/0003-orchestration.md)).

- `src/Engine.ts`: the engine as everything outside it sees it: start a run, approve or deny a gate, cancel, read. A read also repairs a wake that was lost.
- `src/RunLog.ts`: the log of every run, the source of truth: events, the recipe a run started with, and its secrets. It assigns `seq`, runs `transition` on every append and appends once per dedupe key. `layerMemory` is the implementation the tests use.
- `src/RunWorkflow.ts`: the workflow that drives one run. A loop: read the log, ask core's `decide`, do it, append what happened. Every read, append and block call is an activity.
- `src/runBlock.ts`: one execution of a block: its inputs, the services it declared and no others, a trace span, and a check of what it returned.
- `src/services.ts`: what the engine is given (the blocks it can run, the recipes it can start, the services it offers to blocks) and the retry policy.
- `src/testing/kit.ts`: the engine on the in-memory workflow engine with fake blocks a test scripts. Every test that uses it also checks that each block execution had a span and that each finished run followed its recipe.
