# Plan

Each milestone leaves something working. A milestone is complete when its acceptance criteria are met and every rail in [quality-rails.md](quality-rails.md) passes.

Milestones are named M0, M1, … and worked in parts, one session each, starting with Part A (research and spec). The active milestone, its parts and their checks are kept just below. Each milestone's research and spec is in [milestones/](milestones/). The process is in [../.claude/skills/milestone/SKILL.md](../.claude/skills/milestone/SKILL.md).

## Status

| Milestone | Title | Status |
|---|---|---|
| M0 | Workspace and rails | Done 2026-11-23 ([spec](milestones/m0.md)) |
| M1 | Core | Active: Part B next ([below](#active-milestone-m1-core)) |
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

Opened 2026-11-23 and planned in four parts, one session each. Acceptance criteria are under [M1](#m1-core) below. Research findings, the design, the spec's decisions and step-by-step instructions for each group are in [milestones/m1.md](milestones/m1.md).

**Why:** the engine, the UI and the builder all depend on the recipe and run model, so it is built first, as pure code with nothing to deploy ([decision 0002](decisions/0002-recipe-is-a-graph.md), [decision 0007](decisions/0007-tooling.md)).

**What it sets up:** block and recipe Schemas, block declarations in `packages/blocks`, the six recipes from [recipes.md](recipes.md) as files with a generated JSON Schema in a new `packages/recipes`, the validator with path checking and the first invariants, and the run `transition` function with property tests. The full list is the acceptance criteria.

**Left out:** block implementations, any infrastructure, the engine and the UI (M2 onward). Mutation testing must meet `break: 80` from M0.

**Split into parts,** one session each:

- **Part A: research and spec.** Closes A1 to A3. Done. *The owner answered the six flagged decisions on 2026-11-23: all accepted, decision 4 with a narrower exemption and decision 6 with a rule for references.*
- **Part B: schemas, block declarations, recipe files and the JSON Schema.** Closes B1 to B3.
- **Part C: the validator.** Closes C1 to C3. *The owner writes or approves each invariant in `packages/core/src/invariants/` (C3).*
- **Part D: run events, `transition`, property tests, and the close.** Closes D1 to D3.

**Done when:**

- [x] **A1. Versions are current:** each M1 library's latest release checked and recorded in [versions.md](versions.md). *2026-11-23: no change since M0. Oxlint 1.95.0 and tsrs `tsrs5` are out but stay held at 1.94.0 and `tsrs4` for `@effect/tsgo` 0.73.4. M1 adds no runtime dependency to core.*
- [x] **A2. Every M1 unknown is run, not assumed:** including JSON Schema generation from an Effect Schema and property tests over generated recipe graphs. *2026-11-23, in a scratch project with `effect` 4.1.5 and Vitest 5.1.1. `Schema.toJsonSchemaDocument` (stable) generated a draft 2020-12 schema that ajv 8.20.0 and the Effect decoder agreed on for four samples, recursive types included; `isPattern` is dropped unless the RegExp has the `u` flag, and `Schema.Number` admits `"NaN"`. Property tests over generated DAGs pass, and a planted false property shrank to 2 nodes. `Arbitrary.filter` on arrays stalls (0 runs, 1001 discards), so generators are built constructively. Uniform random event sequences missed a planted `transition` bug; state-guided sequences found it and shrank it to 4 events. `import.meta.glob` loads recipe files in Vitest. Details in the spec's findings.*
- [x] **A3. The spec is written:** [milestones/m1.md](milestones/m1.md) with findings, the design, 20 decisions (12 put to the owner), and the parts and groups below. *2026-11-23: revised the same day after a `/code-review high` pass on the spec: cycles are rejected before paths are walked, and the path cap bounds the walk itself; explicit `End` edges let a handled failure end the run `Failed`; cancellation and failed cleanups run every remaining undo and `finally` step; a `ForEachItem` binding; the idempotency key includes the phase, so an undo never shares its step's key; `packages/recipes` added to the root tsconfig references; data on bindings rather than edges flagged as a change to decision 0002; `RunNeedsAttention` renamed `RunFlaggedForAttention`. The owner then answered the six flagged decisions: 1, 2, 3 and 5 as proposed; 4 narrowed so the exemption covers only outputs a block declares `Temporary`, with run-ID tags checked at run time and no per-recipe opt-out; 6 accepted with a reference rule and optional references for `finally` steps, which replace skipping. A second `/code-review high` pass the same day fixed `CleanedUp` (only the attempted cleanup's failure excuses it), added the item to the idempotency key and step, item and attempt to every completion event, made stage 5 a linear dominance check, checked undo blocks, and told B1 to update `packages/blocks`. The owner answered its four design questions: an `End` chooses whether undo runs (decision 15); undo is per for-each item (16); a cancel takes effect between steps (17); `IrreversibleOnlyAfterApproval` also covers `NoUndo` steps that create a `Durable` resource (4). A third pass (`/code-review medium`) found that `vitest/importMeta` does not declare `glob`: run under `effect-tsgo tsc` with `types: []`, it fails, and a local `.d.ts` declaration passes. It also led to: `finally` steps may not use `StepOutput`; for-each steps and their undo are single path entries with list outputs; step events carry their phase and a `MainPhaseEnded` fact, so `transition` needs no recipe; `Finalizing` holds a `Succeeded` main result; gate events carry step, attempt and outputs; the dominance-versus-enumeration property test moved from C1 to C2. The owner answered three more questions: a failure handler runs to its `End` with no cancellation points (decision 18); a cancel during a for-each stops new items (19); a recipe names its first step in `start` (20).*
- [ ] **B1. Core Schemas exist and round-trip:** `DataType`, `BlockSpec`, `Recipe` in `packages/core`; property tests round-trip every Schema with tag coverage asserted; `require-unicode-regexp` on and shown to fail once.
- [ ] **B2. Block declarations decode:** every block the six recipes use is declared in `packages/blocks` as a `BlockSpec`, with unique ids and versions.
- [ ] **B3. The six recipes are files with a generated JSON Schema:** `packages/recipes` holds the six `*.recipe.json` and `recipe.schema.json`; `bun run test` fails on a bad recipe and on a stale JSON Schema; gaps the recipes expose are recorded in the spec.
- [ ] **C1. Structure, size, cycles and types are checked:** each error case has a test; property tests over generated DAGs show a cycle is found and stops validation before paths are walked; `start`, reachability and `finally` structure are checked.
- [ ] **C2. Every path is enumerated:** main, undo in reverse order and per for-each item, and `finally`, with a cancellation point before each normal-track step, at each gate and partway through each for-each, none inside a failure handler, `End` with `undo: "Skip"`, and failed cleanups; stage 5's dominance answer agrees with the enumerated paths; the walk stops at the path cap; property tests on path shape.
- [ ] **C3. Invariants return the failing path:** the owner-approved rules in `packages/core/src/invariants/`, each with a recipe that breaks it on one path and a test that names that path; all six recipes validate.
- [ ] **D1. Run events and states are Schemas:** every event carries the recipe version and the event schema version; `idempotencyKey` is derived from the run ID, the step ID, the phase and the for-each item; every completion and gate event names the step, item and attempt it ends; step events carry their phase and `MainPhaseEnded` records how the main path ended.
- [ ] **D2. `transition` covers every run state:** guided property tests check the run invariants after every event, with coverage asserted, and a planted bug is found and shrunk.
- [ ] **D3. The milestone closes:** `bun run check` passes, `bun run mutate` meets `break: 80`, every acceptance criterion under M1 has its evidence, and this section moves to [milestones/m1.md](milestones/m1.md).

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
