# 0010: How the engine runs a recipe, and where it is deployed

Date: 2026-11-26. Status: accepted.

## Decision

M2 built the engine and ran the restore drill with it, on a stage made for each test and on `staging` and `production`. What later milestones build on is below. The numbers are the decisions in the [M2 spec](../milestones/m2.md), which holds the detail and the reasons; [0003](0003-orchestration.md) and [0004](0004-persistence.md) were updated in it.

### A run

- **A run is two Durable Objects:** a workflow that drives it and a log entity that holds its events, runs `transition` on every append and gives each event its `seq` (2). The workflow holds nothing of its own: it reads the state, asks `decide` in core what comes next, does it, and appends what happened.
- **A step re-run after a crash logs nothing new.** The same attempt runs again under the same idempotency key; a trace span is opened for each execution (3, 34).
- **A run keeps the recipe document it started with,** and its secrets, such as an export's link, outside its events: never in the log, the archive or the API, and deleted when the run ends (16, 17).
- **A gate's wake is repeated until it lands,** by every route that finds the gate closed and by a read of the run (19). A cancel is an append (20, 25).
- **Retries:** three attempts, 5 and 30 seconds apart (9). A write to the index or the archive is tried for about an hour, then the run is stuck with its log whole (28).

### Blocks

- **A block's code sits beside its declaration and lists the services it uses;** the engine gives it those and nothing else, which the types enforce (8, 21).
- **A target is a recipe input, not a binding.** Blocks reach Cloudflare through the REST APIs with the engine's own token, separate from the deploy's (12, 36, 40).

### What a run leaves

- **A finished run's log is one write-once object in R2,** the events as a JSON array, and its row in the D1 index names it (29). The archive's text form is defined once, in core.
- **The drill of Aemeth's own index replays archived logs** from the restored copy of the index and holds each to the state its row records (13, 41, 42).

### Stages and access

- **One stack, stages by name:** `production`, `staging`, and thrown-away `pr-<number>` and `test_<name>`. Any other name is refused. A thrown-away stage takes new code at once, carries fixtures and loses its data; production keeps its index and archive on destroy (31, 26).
- **Production operates staging first** ([0008](0008-out-of-band-path.md)): `bun run drill:stages` deploys both and runs the drill of Aemeth's own index on staging, then on production.
- **The engine checks every Access token itself:** signature against the team's keys, issuer, audience and expiry, before any claim is trusted (30, 33). It refuses a request with no identity, since Access is not always in front of a new or redeployed Worker (gap 18).
- **"Every step emits a trace span" means the engine opens and ends one span per execution of a block,** checked in memory on every engine test. What Cloudflare stores of them is best effort (34, gap 16).

## Why

Each point was settled by running it, on the owner's Cloudflare account or in memory, and most were put to the owner as they came up. The evidence is under "Closed" in the [M2 spec](../milestones/m2.md#closed).
