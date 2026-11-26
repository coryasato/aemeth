# Aemeth

Aemeth runs operational procedures as verified recipes. A recipe is a risky or rare task (a restore drill, a schema migration, a secret rotation) written as data, checked on every path before it can run, and executed durably with approvals, undo steps and a full event log.

The name comes from John Dee's *Sigillum Dei Aemeth*. *Emeth* is Hebrew for "truth", the word that animates the golem.

## How it works

- **Blocks are code.** A block is one typed step: an action, a check or a gate. It declares its inputs and outputs, what it reads and writes, and how to undo it.
- **Recipes are data.** A recipe arranges blocks into a graph. It is authored in the UI or by an agent and stored as a versioned document.
- **The validator walks every path.** A recipe that breaks an invariant cannot be published. The validator reports the failing path.
- **The engine runs published recipes.** A run survives restarts and multi-day waits, retries failed steps, and runs undo steps in reverse order on failure.
- **Every transition is an event.** The run timeline and the audit trail are both computed from an append-only event log.

## Repository layout

```
apps/
  web/        Foldkit UI: recipes, builder, runs, approvals
  engine/     Cloudflare Worker: API, run orchestration, event log
packages/
  core/       Schemas, validator, transition function, invariants (pure, no infrastructure)
  blocks/     The block library
  recipes/    The six recipe files and the JSON Schema generated for them
infra/        Alchemy stack for everything above
docs/         Plan, decisions, recipes, quality rails
```

Dependencies point one way: `apps/*`, `packages/blocks` and `packages/recipes` depend on `packages/core`. `packages/core` depends on nothing in this repository.

## Documents

- [docs/plan.md](docs/plan.md): milestones, acceptance criteria and status
- [docs/milestones/](docs/milestones/): one file per milestone: its spec, written in its Part A, and once it closes its acceptance criteria and the record of how it closed
- [docs/recipes.md](docs/recipes.md): the six recipes and their build order
- [docs/quality-rails.md](docs/quality-rails.md): the checks every change must pass
- [docs/versions.md](docs/versions.md): verified library versions and known constraints
- [docs/decisions/](docs/decisions/): one record per major decision
- [CLAUDE.md](CLAUDE.md): rules for coding agents working in this repository
- [.claude/skills/](.claude/skills/): project skills for coding agents, including the milestone workflow

## Status

M0 (workspace and rails) and M1 (core) closed on 2026-11-23. Every rail runs locally, on commit and in CI. The core is pure code in `packages/core`: the block and recipe Schemas, a validator that walks every path of a recipe and runs nine invariants on each, the `transition` function that computes a run's state from its log of events, and `decide`, which says what a run does next. All six recipes pass the validator, and `decide` takes every one of their paths.

M2 (the engine and the restore drill) closed on 2026-11-26. The engine in `apps/engine` is a Cloudflare Worker deployed with Alchemy from `infra`: a workflow and a log entity per run on Durable Objects, an API behind Cloudflare Access whose tokens the engine checks itself, an index of runs in D1 and an archive of finished runs in R2. The restore drill's blocks run against real D1 databases, and the drill has been run end to end, failed at each step and killed at each step on stages made for the purpose and destroyed afterwards; CI does the same for every pull request. `staging` and `production` are deployed, and production has run the drill of Aemeth's own index against staging and then against itself, checking that archived runs replay to the states the index records. What outlives M2 is in [decision 0010](docs/decisions/0010-engine-run-model-and-stages.md); the spec and its evidence are in [docs/milestones/m2.md](docs/milestones/m2.md).

Next is the UI design session, before M3: the Foldkit schemas, the screens and their state diagrams. Progress is in [docs/plan.md](docs/plan.md#status).
