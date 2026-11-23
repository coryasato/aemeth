# Plan

Each milestone leaves something working. A milestone is complete when its acceptance criteria are met and every rail in [quality-rails.md](quality-rails.md) passes.

## Milestone 0: workspace and rails

Set up the Bun workspace and every quality rail on an empty project.

Accepted when:
- `bun install` succeeds with pinned versions that satisfy [versions.md](versions.md).
- Type checking, linting, formatting, tests and the dead-code check each run with one command and pass.
- Git hooks run lint, format and type checks on commit.
- CI runs the same checks on every push.
- A check fails the build if `packages/core` imports from any other workspace package.
- A Claude Code hook flags edits under `packages/core/src/invariants/`.
- Mutation testing is confirmed to work with Vitest 5 under Bun, and its threshold is a number in config that milestone 1 must meet.
- `CLAUDE.md` lists the commands.

## Milestone 1: core

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
- Mutation testing on `packages/core` meets the threshold set in milestone 0.

## Milestone 2: engine and the restore drill

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

Before milestone 3. Produces the Foldkit Model and Message schemas, the screen list and the state diagrams for the run view and the builder. The throwaway sketches from planning are a starting point only.

## Milestone 3: run UI

Accepted when:
- The UI lists runs and shows one run's timeline and event log, updating live.
- A waiting gate can be approved or denied, and the approver's identity is recorded.
- The timeline is computed from the event log by the same `transition` function the engine uses.

## Milestone 4: builder, list view

Accepted when:
- A recipe can be created, edited and versioned in the UI as an ordered list of steps.
- The checks panel shows each invariant's result and the failing path.
- A recipe with a failing check cannot be published.
- A run always uses a fixed published version.

## Milestones 5 to 9: the remaining recipes

One milestone per recipe, in the order given in [recipes.md](recipes.md). Each adds the primitives listed there. Milestone 5 also settles where non-Worker steps run ([decision 0005](decisions/0005-where-steps-run.md)).

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
