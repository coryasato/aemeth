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

M2 (the engine and the restore drill) is open. Its Part A confirmed the orchestration choice with a spike on Cloudflare and wrote the spec in [docs/milestones/m2.md](docs/milestones/m2.md). Part B built the engine in `apps/engine` as pure code that runs recipes in memory. Part C, on 2026-11-25, made it a Cloudflare Worker deployed with Alchemy from `infra`: a workflow and a log entity per run on Durable Objects, an API behind Cloudflare Access, an index of runs in D1 and an archive of finished runs in R2. On a stage that was created for the purpose and destroyed afterwards, a run of fake blocks survived a deploy at its gate and a kill in the middle of a step with each event in its log once. No stage is deployed now, and no real block has code yet. CI runs the same test for each pull request, on a stage of its own. Left by Part C for Part D to settle first: the engine does not yet check the Access token's signature itself, Cloudflare stores the trace span of some steps and not of others, and the mutation run no longer finishes within CI's time limit. The next step is Part D: the restore drill's blocks, against a real D1 database. Progress is in [docs/plan.md](docs/plan.md#status).
