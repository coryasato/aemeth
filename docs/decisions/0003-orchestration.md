# 0003: Run orchestration

Date: 2026-11-23. Status: accepted, pending a spike in milestone 2.

## Decision

Runs are orchestrated with Effect's workflow module (`effect/workflow`) on its Cloudflare engine (`CloudflareWorkflowEngine` in `@effect/platform-cloudflare`). One run is one Durable Object, with its state in that object's SQLite storage.

## Why

- The module has an in-memory engine, so the Aemeth engine can be tested with no infrastructure.
- Runs, steps and errors stay in Effect's types from end to end.
- It supports waits of any length, which approval gates need.

## Risk

Both the workflow module and the Cloudflare engine are marked unstable or experimental and may break in minor or patch releases. Versions are pinned.

## Fallback

Cloudflare Workflows declared through Alchemy, which supports `waitForEvent` and per-task rollback. Milestone 2 starts with a spike that either confirms the decision or switches to the fallback and updates this record.

## Consequence

The engine's use of the workflow module sits behind a small interface in `apps/engine`, so a switch does not reach `packages/core`.
