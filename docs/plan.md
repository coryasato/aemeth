# Plan

Each milestone leaves something working. A milestone is complete when its acceptance criteria are met and every rail in [quality-rails.md](quality-rails.md) passes.

Milestones are named M0, M1, … and worked in parts, one session each, starting with Part A (research and spec). The active milestone, its parts and their checks are kept just below. Each milestone's research and spec is in [milestones/](milestones/). The process is in [../.claude/skills/milestone/SKILL.md](../.claude/skills/milestone/SKILL.md).

## Status

| Milestone | Title | Status |
|---|---|---|
| M0 | Workspace and rails | Done 2026-11-23 ([spec](milestones/m0.md)) |
| M1 | Core | Active: Part A next ([below](#active-milestone-m1-core)) |
| M2 | Engine and the restore drill | Not started |
| Design | The UI design session | Not started |
| M3 | Run UI | Not started |
| M4 | Builder, list view | Not started |
| M5 | Recipe 2: environment cleanup | Not started |
| M6 | Recipe 3: gradual release | Not started |
| M7 | Recipe 4: schema migration | Not started |
| M8 | Recipe 5: secret rotation | Not started |
| M9 | Recipe 6: Artifacts pipeline | Not started |

## Active milestone: M1, core

Opened 2026-11-23. Part A comes first; it sets the number of later parts. Acceptance criteria are under [M1](#m1-core) below. The spec will be [milestones/m1.md](milestones/m1.md), written in Part A.

**Why:** the engine, the UI and the builder all depend on the recipe and run model, so it is built first, as pure code with nothing to deploy ([decision 0002](decisions/0002-recipe-is-a-graph.md), [decision 0007](decisions/0007-tooling.md)).

**What it sets up:** block and recipe Schemas, the recipe validator over the six recipes in [recipes.md](recipes.md), the run `transition` function with property tests, and the first invariants in `packages/core/src/invariants/`. The full list is the acceptance criteria.

**Left out:** any infrastructure, the engine and the UI (M2 onward). Mutation testing must meet `break: 80` from M0.

**Split into parts,** one session each:

- **Part A: research and spec.** Effect Schema, JSON Schema generation and `@effect/vitest` property APIs checked against current documentation; unknowns run in the scratchpad; [milestones/m1.md](milestones/m1.md) written with its decisions and the later parts. Closes A1 to A3. *The owner reviews the spec's decisions, and writes or approves the first invariants.*
- **Later parts:** set by Part A.

**Done when:**

- [ ] **A1. Versions are current:** each M1 library's latest release checked and recorded in [versions.md](versions.md).
- [ ] **A2. Every M1 unknown is run, not assumed:** including JSON Schema generation from an Effect Schema and property tests over generated recipe graphs.
- [ ] **A3. The spec is written:** [milestones/m1.md](milestones/m1.md) with findings, decisions flagged for the owner, and the later parts with their groups added here.

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
