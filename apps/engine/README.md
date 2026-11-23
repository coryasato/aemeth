# apps/engine

The Cloudflare Worker that serves the API, orchestrates runs and stores the event log.

Depends on `packages/core` and `packages/blocks`. The workflow module is used behind a small interface here, so it can be replaced without touching `packages/core` (see [decision 0003](../../docs/decisions/0003-orchestration.md)).
