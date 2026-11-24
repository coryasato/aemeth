# Plan

Each milestone leaves something working. A milestone is complete when its acceptance criteria are met and every rail in [quality-rails.md](quality-rails.md) passes.

Milestones are named M0, M1, … and worked in parts, one session each, starting with Part A (research and spec). The active milestone, its parts and their checks are kept just below, followed by the milestones still to do. A closed milestone is its row in "Status": its acceptance criteria, its spec and the record of how it closed are in its file in [milestones/](milestones/). The process is in [../.claude/skills/milestone/SKILL.md](../.claude/skills/milestone/SKILL.md).

## Status

| Milestone | Title | Status |
|---|---|---|
| M0 | Workspace and rails | Done 2026-11-23 ([spec](milestones/m0.md)) |
| M1 | Core | Done 2026-11-23 ([spec](milestones/m1.md)) |
| M2 | Engine and the restore drill | Active: Part A next ([below](#active-milestone-m2-engine-and-the-restore-drill)) |
| Design | The UI design session | Not started |
| M3 | Run UI | Not started |
| M4 | Builder, list view | Not started |
| M5 | Recipe 2: environment cleanup | Not started |
| M6 | Recipe 3: gradual release | Not started |
| M7 | Recipe 4: schema migration | Not started |
| M8 | Recipe 5: secret rotation | Not started |
| M9 | Recipe 6: Artifacts pipeline | Not started |

## Active milestone: M2, engine and the restore drill

Opened 2026-11-23. Part A comes first; it sets the number of later parts. Acceptance criteria are under [M2](#m2-engine-and-the-restore-drill) below. The spec will be [milestones/m2.md](milestones/m2.md), written in Part A.

**Why:** a recipe that validates has to run: durably, through its approvals, its undo and its `finally` steps, against something real. The restore drill is recipe 1 and only reads production ([recipes.md](recipes.md), [decision 0003](decisions/0003-orchestration.md), [decision 0004](decisions/0004-persistence.md)).

**What it sets up:** the orchestration spike; the engine in `apps/engine`, deployed with Alchemy behind Cloudflare Access as staging and production; the restore drill's blocks, implemented against D1; the event log, written through `transition` and archived to R2; a trace span per step; and the rails that need infrastructure (a temporary stack per pull request, tracing). The full list is the acceptance criteria.

**Left out:** the UI (the design session and M3), the builder (M4) and the other five recipes (M5 to M9).

**Split into parts,** one session each:

- **Part A: research and spec.** `effect/workflow`, `@effect/platform-cloudflare`, Alchemy and Cloudflare's D1, Durable Object and R2 documentation checked against current sources; the orchestration spike of [decision 0003](decisions/0003-orchestration.md) run, with a run paused at a gate across a redeploy; the items due before M2 under "Not yet verified" in [versions.md](versions.md); and the gaps the [M1 spec](milestones/m1.md) leaves to the engine (run inputs in `RunStarted`, typed outputs, a check of a log against its recipe, run-ID tags on temporary resources). [milestones/m2.md](milestones/m2.md) written with its decisions and the later parts. Closes A1 to A3. *The owner provides the Cloudflare account and credentials the spike deploys with, and reviews the spec's decisions.*
- **Later parts:** set by Part A.

**Done when:**

- [ ] **A1. Versions are current:** each M2 library's latest release checked against every constraint and recorded in [versions.md](versions.md).
- [ ] **A2. Every M2 unknown is run, not assumed:** including the orchestration spike, which confirms [decision 0003](decisions/0003-orchestration.md) or switches to its fallback and updates the record.
- [ ] **A3. The spec is written:** [milestones/m2.md](milestones/m2.md) with findings, decisions flagged for the owner, and the later parts with their groups added here.

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
