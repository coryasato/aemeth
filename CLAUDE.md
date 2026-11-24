# Rules for coding agents

Read [README.md](README.md) and [docs/plan.md](docs/plan.md) before starting work. Decisions already made are in [docs/decisions/](docs/decisions/); do not reopen them without the owner asking.

Milestone work (M0, M1, …) is done in parts, one session each. Follow the `milestone` skill in [.claude/skills/milestone/SKILL.md](.claude/skills/milestone/SKILL.md). Git is handled by the owner: do not commit, and end each session with a one-line commit message.

## Hard rules

1. **Do not weaken or delete invariants.** Everything under `packages/core/src/invariants/` is written and owned by a person. Adding an invariant is fine. Changing or removing one needs explicit approval from the owner in the conversation.
2. **A task is not done until every rail passes.** See [docs/quality-rails.md](docs/quality-rails.md). Report failures with their output; do not describe failing work as finished.
3. **`packages/core` stays pure.** No infrastructure, network, clock or randomness except through Effect services. It must not import from `apps/*`, `packages/blocks` or `infra`.
4. **Check current documentation before using a library API.** Effect, Alchemy and Foldkit change often, and memory of their APIs is unreliable. Sources are listed in [docs/versions.md](docs/versions.md).
5. **Use the latest release that satisfies every constraint in [docs/versions.md](docs/versions.md).** Pin exact versions. Update that file when a version changes.

## Conventions

- **Runtime and package manager:** Bun. Use `bun` and `bunx`, not `npm` or `pnpm`.
- **Failures are states, not exceptions.** Model every failure as a typed error or an explicit state with a defined next move. Do not throw.
- **Make impossible states unrepresentable.** Prefer tagged unions over optional fields and booleans.
- **Schemas are defined once** in `packages/core` and reused by the engine, the API, the UI and the tests.
- **Messages and events are facts in the past tense** (`StepSucceeded`, `ApprovalDenied`), not commands.
- **Blocks declare what they touch.** Every block states its reads, writes and undo. A block that writes and has no undo must say so explicitly.

## Running the checks

The commands are defined in milestone 0. This section is filled in when the workspace exists.
