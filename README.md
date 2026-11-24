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

M0 (workspace and rails) and M1 (core) closed on 2026-11-23. Every rail runs locally, on commit and in CI. The core is pure code in `packages/core`: the block and recipe Schemas, a validator that walks every path of a recipe and runs nine invariants on each, and the `transition` function that computes a run's state from its log of events. All six recipes pass the validator. Nothing is deployed yet. M2 (the engine and the restore drill) is open. Its Part A, on 2026-11-24, confirmed the orchestration choice with a spike on Cloudflare (a run paused at a gate survived redeploys, and a run killed mid-step recovered) and wrote the spec in [docs/milestones/m2.md](docs/milestones/m2.md). The next step is Part B: the engine as pure code, run in memory. Progress is in [docs/plan.md](docs/plan.md#status).
