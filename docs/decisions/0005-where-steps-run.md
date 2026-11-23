# 0005: Where steps run

Date: 2026-11-23. Status: partly deferred.

## Decision

Blocks in the first milestone run inside the engine Worker and act through HTTP APIs only.

## Deferred

Some later blocks cannot run in a Worker: Alchemy's plan and apply need Node or Bun, and some tools are native binaries. The choice of where those run is deferred to milestone 5, when the environment cleanup recipe first needs it. The candidates are:

- CI, triggered by the engine, with results reported back.
- A Cloudflare Container running a small Node or Bun service.

## Consequence for the design now

A block's definition must not assume it runs in the Worker. The engine dispatches a step and waits for its result, wherever the step executes.
