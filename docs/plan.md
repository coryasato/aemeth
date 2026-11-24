# Plan

Each milestone leaves something working. A milestone is complete when its acceptance criteria are met and every rail in [quality-rails.md](quality-rails.md) passes.

Milestones are named M0, M1, … and worked in parts, one session each, starting with Part A (research and spec). The active milestone, its parts and their checks are kept just below. Each milestone's research and spec is in [milestones/](milestones/). The process is in [../.claude/skills/milestone/SKILL.md](../.claude/skills/milestone/SKILL.md).

## Status

| Milestone | Title | Status |
|---|---|---|
| M0 | Workspace and rails | Active: Part B next ([below](#active-milestone-m0-workspace-and-rails)) |
| M1 | Core | Not started |
| M2 | Engine and the restore drill | Not started |
| Design | The UI design session | Not started |
| M3 | Run UI | Not started |
| M4 | Builder, list view | Not started |
| M5 | Recipe 2: environment cleanup | Not started |
| M6 | Recipe 3: gradual release | Not started |
| M7 | Recipe 4: schema migration | Not started |
| M8 | Recipe 5: secret rotation | Not started |
| M9 | Recipe 6: Artifacts pipeline | Not started |

## Active milestone: M0, workspace and rails

Opened 2026-11-23 and planned in three parts, one session each. Acceptance criteria are under [M0](#m0-workspace-and-rails) below. Research findings, the spec's decisions and step-by-step instructions for each group are in [milestones/m0.md](milestones/m0.md).

**Why:** most code here is written by coding agents, so the rails that check it must exist before any feature work ([quality-rails.md](quality-rails.md)).

**What it sets up:** a Bun workspace with one placeholder module and test per package; type checking with Effect diagnostics, type-aware linting, formatting, tests, property tests, knip and the core import boundary, each as one command and all as `bun run check`; mutation testing on `packages/core`; lefthook on commit; a Claude Code hook on the invariants folder; CI on every push.

**Left out:** Foldkit, Alchemy and Cloudflare dependencies, and the rails that need them (Story and Scene tests, per-PR integration stacks, tracing). They arrive with M2 and M3 (spec decision 2).

**Split into parts,** one session each:

- **Part A: research and spec.** Versions checked, every unverified tool run in a scratch project, the spec written. Closes A1 to A3. Done.
- **Part B: workspace and core rails, local.** Closes B1 to B4. Nothing pushed.
- **Part C: mutation, hooks, CI, and the close.** Closes C1 to C4. *The owner pushes, and sets the mutation `break` threshold (spec decision 6).*

**Done when:**

- [x] **A1. Versions are current and consistent:** each tool's latest release checked on npm, held back where a peer requires it, and recorded in [versions.md](versions.md). *2026-11-23: Oxlint held at 1.94.0 and tsrs at `tsrs4`, the most `@effect/tsgo` 0.73.4 supports.*
- [x] **A2. Every M0 unknown is run, not assumed:** Effect's `Arbitrary`, Stryker, knip and lefthook with Vitest 5 and TypeScript 7, the Foldkit Vite plugin under Bun, and the Oxlint preset trial on Effect code. *2026-11-23: all run under Bun 1.4.4 and Node 26.12.1. Stryker needs a `tsconfigFile` workaround (TypeScript 7 has no JS API); Vitest must run on Node; the preset needed 3 overrides and is adopted. Details in the spec's findings.*
- [x] **A3. The spec is written:** [milestones/m0.md](milestones/m0.md) with findings, eight decisions and the groups below; [quality-rails.md](quality-rails.md) updated with the trial result.
- [ ] **B1. The workspace installs:** `bun install` succeeds with exact pins that satisfy [versions.md](versions.md); every package has a `tsconfig.json`, a placeholder module and one test; `packages/core/src/invariants/README.md` exists for the owner to review.
- [ ] **B2. Types, lint and format each run with one command and pass,** and each fails on a planted violation (a floating Effect, an `any`, a misformatted file).
- [ ] **B3. Tests, knip and the import boundary each run with one command and pass:** `packages/core` has an `it.prop` test over a Schema; a planted `@aemeth/blocks` import and a `../../` import in core each fail the build.
- [ ] **B4. `bun run check` runs every rail above in order** and fails on the first failure. The commands are listed for C4.
- [ ] **C1. Mutation testing runs on `packages/core`:** `bun run mutate` passes, its `break` threshold is a number in config that M1 must meet, and dropping below it fails the run.
- [ ] **C2. Hooks are in place:** lefthook runs lint, format check and typecheck on commit; editing under `packages/core/src/invariants/` asks for approval through `.claude/settings.json`. Both shown working.
- [ ] **C3. CI runs the same checks on every push,** and its first run passes.
- [ ] **C4. The milestone closes:** `CLAUDE.md` lists the commands; every acceptance criterion under M0 has its evidence here; this section moves to [milestones/m0.md](milestones/m0.md) and M1 opens.

## M0: workspace and rails

Set up the Bun workspace and every quality rail on an empty project.

Accepted when:
- `bun install` succeeds with pinned versions that satisfy [versions.md](versions.md).
- Type checking, linting, formatting, tests and the dead-code check each run with one command and pass.
- Git hooks run lint, format and type checks on commit.
- CI runs the same checks on every push.
- A check fails the build if `packages/core` imports from any other workspace package.
- A Claude Code hook flags edits under `packages/core/src/invariants/`.
- Mutation testing is confirmed to work with Vitest 5 under Bun, and its threshold is a number in config that M1 must meet.
- `CLAUDE.md` lists the commands.

## M1: core

Block and recipe schemas, the validator, the run transition function and the first invariants. Pure code, no infrastructure.

Accepted when:
- A recipe is a graph of nodes and edges with typed inputs and outputs ([decision 0002](decisions/0002-recipe-is-a-graph.md)).
- All six recipes in [recipes.md](recipes.md) exist as recipe documents and are used as validator fixtures. Gaps in the format that recipes 2 to 6 expose are recorded, not necessarily closed.
- Recipes are files in the repository, a JSON Schema is generated from the recipe Schema, and CI runs the validator on every recipe file.
- The validator checks every path through a recipe and returns the failing path for each broken invariant.
- The validator rejects cycles and reports when a recipe exceeds the size and branching cap.
- The block contract requires a block to be safe to re-run after a crash, using a key derived from the run and step IDs.
- Blocks take their targets as typed recipe inputs and never name Aemeth's own resources.
- Every event records the recipe version and the event schema version.
- `transition(state, event)` covers every run state, and property tests check the run invariants over random event sequences.
- Mutation testing on `packages/core` meets the threshold set in M0.

## M2: engine and the restore drill

Starts with a spike on the orchestration choice ([decision 0003](decisions/0003-orchestration.md)). Then the engine runs the restore drill against a real D1 database.

Accepted when:
- The spike confirms the orchestration choice or switches to the fallback, and the decision record is updated. It must show a run paused at a gate surviving a redeploy, and confirm there is no upper limit on the wait that would rule out multi-day approvals.
- The engine is deployed with Alchemy, behind Cloudflare Access, as two stages: staging and production.
- A restore drill run completes end to end: export, create temporary database, restore, verify, tear down, record.
- Killing the Worker mid-run does not lose the run.
- A step re-run after a crash produces no duplicate side effects.
- A forced failure at each step leaves no temporary database behind.
- A block reaches the outside world only through services the engine provides, and the engine provides only those the block declares.
- When a run reaches a final state, its event log is archived to R2 ([decision 0004](decisions/0004-persistence.md)).
- After the drill works on the seeded sample database, it runs against Aemeth's own D1 index and checks that archived event logs replay to their recorded final states.
- Every transition is in the event log, and every step emits a trace span.

## Design session: the UI

Before M3. Produces the Foldkit Model and Message schemas, the screen list and the state diagrams for the run view and the builder. The throwaway sketches from planning are a starting point only.

## M3: run UI

Accepted when:
- The UI lists runs and shows one run's timeline and event log, updating live.
- A waiting gate can be approved or denied, and the approver's identity is recorded.
- The timeline is computed from the event log by the same `transition` function the engine uses.

## M4: builder, list view

Accepted when:
- A recipe can be created, edited and versioned in the UI as an ordered list of steps.
- The checks panel shows each invariant's result and the failing path.
- A recipe with a failing check cannot be published.
- A run always uses a fixed published version.

## M5 to M9: the remaining recipes

One milestone per recipe, in the order given in [recipes.md](recipes.md). Each adds the primitives listed there. M5 also settles where non-Worker steps run ([decision 0005](decisions/0005-where-steps-run.md)).

Accepted, for each recipe, when:
- It runs against its Aemeth target named in [recipes.md](recipes.md).
- Production Aemeth has run it against staging Aemeth successfully before it is ever run against production.
- Aemeth can still be deployed and rolled back without Aemeth ([decision 0008](decisions/0008-out-of-band-path.md)).

## Later

- A drag-and-drop canvas editor over the same recipe graph.
- Recipe templates that other Alchemy users can adopt.
- An MCP server over the engine API, so agents can list recipes, start runs and read events.
- Capability limits per block, enforced by Effect's types and by Alchemy's typed permissions.
- Replay of past runs from the event log.

## Open questions

- **The Artifacts pipeline (recipe 6)** needs a fuller idea before it is scheduled. See [recipes.md](recipes.md).
