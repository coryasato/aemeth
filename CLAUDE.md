# Rules for coding agents

Read [README.md](README.md) and [docs/plan.md](docs/plan.md) before starting work. Decisions already made are in [docs/decisions/](docs/decisions/); do not reopen them without the owner asking.

Milestone work (M0, M1, …) is done in parts, one session each. Follow the `milestone` skill in [.claude/skills/milestone/SKILL.md](.claude/skills/milestone/SKILL.md). Git is handled by the owner: do not commit, and end each session with a one-line Conventional Commits message, milestone last in parentheses: `chore: add mutation testing and CI (M0 Part C)`. Details are in the skill.

## Hard rules

1. **Do not weaken or delete invariants.** Everything under `packages/core/src/invariants/` is written and owned by a person. Adding an invariant is fine. Changing or removing one needs explicit approval from the owner in the conversation.
2. **A task is not done until every rail passes.** See [docs/quality-rails.md](docs/quality-rails.md). Report failures with their output; do not describe failing work as finished.
3. **`packages/core` stays pure.** No infrastructure, network, clock or randomness except through Effect services. It must not import from `apps/*`, `packages/blocks` or `infra`.
4. **Check current documentation before using a library API.** Effect, Alchemy and Foldkit change often, and memory of their APIs is unreliable. Sources are listed in [docs/versions.md](docs/versions.md).
5. **Use the latest release that satisfies every constraint in [docs/versions.md](docs/versions.md).** Pin exact versions. Update that file when a version changes.

## Conventions

- **Runtime and package manager:** Bun. Use `bun` and `bunx`, not `npm` or `pnpm`.
- **Failures are states, not exceptions.** Model every failure as a typed error or an explicit state with a defined next move. Do not throw. The one exception is a test helper (a `testing/` folder, or a `*.test.ts` file), which may throw to fail the test that misused it.
- **Make impossible states unrepresentable.** Prefer tagged unions over optional fields and booleans.
- **Schemas are defined once** in `packages/core` and reused by the engine, the API, the UI and the tests.
- **Messages and events are facts in the past tense** (`StepSucceeded`, `ApprovalDenied`), not commands.
- **Blocks declare what they touch.** Every block states its reads, writes and undo. A block that writes and has no undo must say so explicitly.

## Running the checks

Run from the repository root. Each exits non-zero on failure.

| Command | What it runs |
|---|---|
| `bun install` | Installs dependencies and, through `prepare`, the lefthook git hooks |
| `bun run typecheck` | `effect-tsgo tsc -b`: TypeScript 7 with Effect diagnostics |
| `bun run lint` | `oxlint --type-aware`, including the `packages/core` import boundary |
| `bun run format` | `oxfmt`: rewrites files. `bun run format:check` only checks |
| `bun run test` | `vitest run`: unit, Effect and property tests, and the core `package.json` boundary test |
| `bun run knip` | Unused files, exports and dependencies |
| `bun run check` | All of the above in that order, stopping at the first failure |
| `bun run test:integration` | The integration suite in `infra/test`: deploys the stack to `$ALCHEMY_TEST_STAGE` (default `test_$USER`) on Cloudflare, drives the deployed engine, destroys the stage. Needs an Alchemy login with Access permission and `AEMETH_ACCESS_TEAM` set; see [infra/README.md](infra/README.md) |
| `bun run drill:stages` | Not a check: deploys `staging` and `production` and runs the drill of Aemeth's own index, production against staging first, then against itself ([decision 0008](docs/decisions/0008-out-of-band-path.md)). It changes the stages that are kept; run it only when the owner asks |
| `bun run mutate` | Stryker mutation testing on `packages/core`; fails below the `break` threshold in `packages/core/stryker.config.json` |

Run `bun run check` before saying work is done; CI runs it and, in a job of its own, `bun run mutate --incremental` on every push, and `bun run test:integration` for every pull request. Run the integration suite yourself when a change touches `apps/engine/src/cloudflare`, `infra`, or how the engine stores a run; it creates and destroys real resources, so say so first. The pre-commit hook runs typecheck, lint and format check. Vitest and Stryker run on Node: never use `bun --bun` with them.
