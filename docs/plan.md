# Plan

Each milestone leaves something working. A milestone is complete when its acceptance criteria are met and every rail in [quality-rails.md](quality-rails.md) passes.

Milestones are named M0, M1, … and worked in parts, one session each, starting with Part A (research and spec). The active milestone, its parts and their checks are kept just below, followed by the milestones still to do. A closed milestone is its row in "Status": its acceptance criteria, its spec and the record of how it closed are in its file in [milestones/](milestones/). The process is in [../.claude/skills/milestone/SKILL.md](../.claude/skills/milestone/SKILL.md).

## Status

| Milestone | Title | Status |
|---|---|---|
| M0 | Workspace and rails | Done 2026-11-23 ([spec](milestones/m0.md)) |
| M1 | Core | Done 2026-11-23 ([spec](milestones/m1.md)) |
| M2 | Engine and the restore drill | Done 2026-11-26 ([spec](milestones/m2.md)) |
| Design | The UI design session | Active: Part A next ([below](#active-milestone-design-session-the-ui)) |
| M3 | Run UI | Not started |
| M4 | Builder, list view | Not started |
| M5 | Recipe 2: environment cleanup | Not started |
| M6 | Recipe 3: gradual release | Not started |
| M7 | Recipe 4: schema migration | Not started |
| M8 | Recipe 5: secret rotation | Not started |
| M9 | Recipe 6: Artifacts pipeline | Not started |

## Active milestone: Design session, the UI

Opened 2026-11-26, after M2 closed. Unnumbered; its parts are decided in its Part A. What it must produce is under [Design session](#design-session-the-ui) below.

**Why:** M3 builds the run view and M4 the builder on Foldkit, and both need their Model and Message schemas and their screens decided before code ([decision 0007](decisions/0007-tooling.md)). The engine's API and its run states, which the screens show, are settled by M2 ([decision 0010](decisions/0010-engine-run-model-and-stages.md)).

**What it sets up:** the Foldkit Model and Message schemas, the screen list, and the state diagrams for the run view and the builder.

**Left out:** any UI code (M3 and M4).

**Split into parts,** one session each:

- **Part A: research and spec.** Foldkit's current API, the throwaway sketches from planning, and what M2 left for the UI (gap 7, live updates without WebSockets; gap 18, the UI cannot lean on Access alone); then the later parts and their groups.

**Done when:**

- [ ] **A1. The spec is written,** with its findings, decisions flagged for the owner, and the later parts with their groups added here.

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
- A sliding window for the items of a for-each: start the next item as soon as one ends, in place of batches of four ([M2 decision 22](milestones/m2.md#decisions-made-in-this-spec)). It needs `decide` and the workflow loop to act while work is in flight. It would also stop a retry's delay from holding back new items (M2 gap 15).

## Open questions

- **The Artifacts pipeline (recipe 6)** needs a fuller idea before it is scheduled. See [recipes.md](recipes.md).
