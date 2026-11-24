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
infra/        Alchemy stack for everything above
docs/         Plan, decisions, recipes, quality rails
```

Dependencies point one way: `apps/*` and `packages/blocks` depend on `packages/core`. `packages/core` depends on nothing in this repository.

## Documents

- [docs/plan.md](docs/plan.md): milestones, acceptance criteria and status
- [docs/milestones/](docs/milestones/): one spec per milestone, written in its Part A
- [docs/recipes.md](docs/recipes.md): the six recipes and their build order
- [docs/quality-rails.md](docs/quality-rails.md): the checks every change must pass
- [docs/versions.md](docs/versions.md): verified library versions and known constraints
- [docs/decisions/](docs/decisions/): one record per major decision
- [CLAUDE.md](CLAUDE.md): rules for coding agents working in this repository
- [.claude/skills/](.claude/skills/): project skills for coding agents, including the milestone workflow

## Status

M0 (workspace and rails) closed on 2026-11-23: every rail runs locally, on commit and in CI. M1 (core) is open; the next step is its Part A, research and spec. Progress is in [docs/plan.md](docs/plan.md#status).
