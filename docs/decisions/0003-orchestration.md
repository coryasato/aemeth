# 0003: Run orchestration

Date: 2026-11-23. Status: accepted, and confirmed by the spike in M2 Part A on 2026-11-24.

## Decision

Runs are orchestrated with Effect's workflow module (`effect/workflow`) on its Cloudflare engine (`CloudflareWorkflowEngine` in `@effect/platform-cloudflare`). One run is two Durable Objects: the workflow, whose storage belongs to the engine, and a log entity that holds the run's events in its own SQLite storage ([0004](0004-persistence.md)).

## Why

- The module has an in-memory engine, so the Aemeth engine can be tested with no infrastructure.
- Runs, steps and errors stay in Effect's types from end to end.
- It supports waits of any length, which approval gates need.

## Risk

Both the workflow module and the Cloudflare engine are marked unstable or experimental and may break in minor or patch releases. Versions are pinned.

## Fallback

Cloudflare Workflows declared through Alchemy, which supports `waitForEvent` and per-task rollback. Milestone 2 starts with a spike that either confirms the decision or switches to the fallback and updates this record.

## The spike

Run in M2 Part A; what was run is in [../milestones/m2.md](../milestones/m2.md). A run paused at a gate survived redeploys, deployed with Wrangler and with Alchemy. A run killed mid-step started again by itself and finished. A suspended run holds no alarm, so nothing limits how long a gate may wait. The fallback was not needed and was not spiked.

A workflow cannot read or write its own Durable Object's SQLite, which is why the event log is a separate entity.

## Consequence

The engine's use of the workflow module sits behind a small interface in `apps/engine`, so a switch does not reach `packages/core`.
