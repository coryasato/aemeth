# apps/engine

The engine: it runs published recipes. The same code runs in memory, for the tests, and as a Cloudflare Worker.

Depends on `packages/core`, `packages/blocks` and `packages/recipes`. It is the only package that imports `effect/workflow`, `effect/cluster` or `@effect/platform-cloudflare`, and the workflow module is used behind `Engine`, so it can be replaced without touching `packages/core` (see [decision 0003](../../docs/decisions/0003-orchestration.md)).

## The engine

Nothing here is infrastructure: each thing the engine stands on is a service, with an implementation in memory for the tests.

- `src/Engine.ts`: the engine as everything outside it sees it: start a run, approve or deny a gate, cancel, read. A read also repairs a wake that was lost.
- `src/Api.ts`: the six routes of the API over `Engine`, for a caller Access has named. A request with no identity is refused.
- `src/RunLog.ts`: the log of every run, the source of truth: events, the recipe a run started with, and its secrets. `appendTo` is one append as every log does it: it assigns `seq`, runs `transition` and appends once per dedupe key. `layerMemory` keeps the log in memory.
- `src/RunLogSql.ts`: the same log on a SQLite database that holds one run, which is what a run's log entity has.
- `src/RunWorkflow.ts`: the workflow that drives one run. A loop: read the log, ask core's `decide`, do it, append what happened; when the run is over, archive it. Every read, append, block call and write to the index or the archive is an activity.
- `src/runBlock.ts`: one execution of a block: its inputs, the services it declared and no others, a trace span, and a check of what it returned.
- `src/Archive.ts` and `src/RunIndex.ts`: where a finished run's log is kept as one object written once, and the row per run that says how it ended and where that object is ([decision 0004](../../docs/decisions/0004-persistence.md)).
- `src/services.ts`: what the engine is given (the blocks it can run, the recipes it can start, the services it offers to blocks) and the retry policy.
- `src/testing/kit.ts`: the engine on the in-memory workflow engine with fake blocks a test scripts. Every test that uses it also checks that each block execution had a span, that each finished run followed its recipe, and that each finished run is archived and replays to the state the index records. `src/testing/sqlLog.ts` is the SQL log on Node's SQLite, so the log's tests run against both logs.

## The Worker

`src/cloudflare` is the engine on Cloudflare, declared for Alchemy. The stack that deploys it is in [`infra`](../../infra).

- `Worker.ts`: the Worker. Access in front, the API, and behind it the cluster's Durable Objects: a workflow and a log entity per run. Its props are worked out for the stage.
- `RunLogEntity.ts`: the log entity, one per run, on its Durable Object's own SQLite storage, and `RunLog` as calls to it.
- `records.ts`: the archive on an R2 bucket and the index on a D1 database.
- `resources.ts`: the index database, the archive bucket and the service token.
- `fixtures.ts`: what only a stage that is thrown away has: two fake blocks, a recipe of them and two routes under `/test`.
- `../migrations`: the index's migrations, applied on deploy.
