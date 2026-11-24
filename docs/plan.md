# Plan

Each milestone leaves something working. A milestone is complete when its acceptance criteria are met and every rail in [quality-rails.md](quality-rails.md) passes.

Milestones are named M0, M1, … and worked in parts, one session each, starting with Part A (research and spec). The active milestone, its parts and their checks are kept just below, followed by the milestones still to do. A closed milestone is its row in "Status": its acceptance criteria, its spec and the record of how it closed are in its file in [milestones/](milestones/). The process is in [../.claude/skills/milestone/SKILL.md](../.claude/skills/milestone/SKILL.md).

## Status

| Milestone | Title | Status |
|---|---|---|
| M0 | Workspace and rails | Done 2026-11-23 ([spec](milestones/m0.md)) |
| M1 | Core | Done 2026-11-23 ([spec](milestones/m1.md)) |
| M2 | Engine and the restore drill | Active: Part B next ([below](#active-milestone-m2-engine-and-the-restore-drill)) |
| Design | The UI design session | Not started |
| M3 | Run UI | Not started |
| M4 | Builder, list view | Not started |
| M5 | Recipe 2: environment cleanup | Not started |
| M6 | Recipe 3: gradual release | Not started |
| M7 | Recipe 4: schema migration | Not started |
| M8 | Recipe 5: secret rotation | Not started |
| M9 | Recipe 6: Artifacts pipeline | Not started |

## Active milestone: M2, engine and the restore drill

Opened 2026-11-23 and planned in five parts, one session each. Acceptance criteria are under [M2](#m2-engine-and-the-restore-drill) below. Research findings, the design, the spec's decisions and step-by-step instructions for each group are in [milestones/m2.md](milestones/m2.md).

**Why:** a recipe that validates has to run: durably, through its approvals, its undo and its `finally` steps, against something real. The restore drill is recipe 1 and only reads production ([recipes.md](recipes.md), [decision 0003](decisions/0003-orchestration.md), [decision 0004](decisions/0004-persistence.md)).

**What it sets up:** the engine in `apps/engine`: a workflow and a log entity per run, with the pure `decide` function in core choosing each next step; deployed with Alchemy behind Cloudflare Access as staging and production; the restore drill's blocks, implemented against D1; the event log, written through `transition` and archived to R2; a trace span per step; and the rails that need infrastructure (a temporary stack per pull request, tracing). The full list is the acceptance criteria.

**Left out:** the UI (the design session and M3), the builder (M4) and the other five recipes (M5 to M9).

**Split into parts,** one session each:

- **Part A: research and spec.** Closes A1 and A3; A2 stays open for five checks that Parts C and D run. Done. *The owner gave the spike access to the Cloudflare account, turned Zero Trust on, and answered four decisions on 2026-11-24 (spec decisions 2, 3, 4 and 6): a log entity per run; a step re-run after a crash logs nothing new; the drill's figures are hashed in the Worker; deployment state in Cloudflare's state store. After a review of the spec the owner chose a fifth (16: a secret such as the export's download link is held by the engine and never logged) and left A2 unticked until Parts C and D run what Part A could not.*
- **Part B: the engine, pure and in memory.** Values and run inputs in core, `decide` and `followsRecipe`, and the workflow driver on the in-memory engine with fake blocks. No infrastructure. Closes B1 to B3.
- **Part C: the Worker, deployed.** The Alchemy stack, the log entity on Durable Object SQLite, the API, Access, the archive and index, and the integration and tracing rails. Closes C1 to C4. *Before it, the owner logs Alchemy in with permissions that include Access, runs `alchemy state bootstrap`, and adds the Cloudflare account ID and a deploy token as GitHub Actions secrets.*
- **Part D: the restore drill.** The Cloudflare API service, the drill's six blocks, the drill end to end on the seeded sample database, and its failure and crash tests. Closes D1 to D3. *Before it, the owner creates an API token with `D1 Write` for the engine.*
- **Part E: Aemeth's own index, and the close.** Staging and production, the archive replay check, the drill against Aemeth's own D1 index, and the close. Closes E1 to E3.

**Done when:**

- [x] **A1. Versions are current:** each M2 library's latest release checked against every constraint and recorded in [versions.md](versions.md). *2026-11-24: nothing pinned has moved (`effect` and the `@effect/*` packages 4.1.5, `alchemy` 2.0.0-beta.87; Oxlint still held at 1.94.0). New for M2 and recorded: `@alchemy.run/cloudflare` 2.0.0-beta.87, Alchemy's Cloudflare provider and an optional peer of `@effect/platform-cloudflare`; `@distilled.cloud/cloudflare` 1.0.0-rc.20, which comes with it; `wrangler` 4.168.0, used in the scratch projects only.*
- [ ] **A2. Every M2 unknown is run, not assumed:** including the orchestration spike, which confirms [decision 0003](decisions/0003-orchestration.md) or switches to its fallback and updates the record. *2026-11-24, in two scratch projects and on the owner's Cloudflare account; everything created there was deleted. Decision 0003 is confirmed. A workflow with a gate (`DurableDeferred`) ran on `CloudflareWorkflowEngine` locally, deployed with Wrangler and deployed with Alchemy. A run paused at its gate survived a redeploy on each, and on Cloudflare a run paused on build two was approved two deploys later and finished on build four. A run killed mid-step, locally by `kill -9` and on Cloudflare by a deploy with `--durable-objects-code-update-mode immediate`, started again by itself within about 75 seconds and finished: the step's body ran twice, so idempotency keys are needed, as the block contract says. A default deploy does not kill a busy object for up to 300 seconds. No upper limit on a wait: a suspended run holds no alarm, read from the engine's source; the longest wait observed was minutes. The same workflow ran on the in-memory engine. A workflow cannot reach its own object's SQLite, so the event log is a log entity per run, which kept each event once across a kill and two restarts. On D1: export, create, import and delete ran end to end with equal rows; an export returns no count or checksum and D1 has no hash function (`no such function: md5`), so the figures are hashed in the Worker; a database has no tags, and a 75-character name was accepted. An R2 put with `If-None-Match: *` from the binding wrote once and returned `null` the second time. Point-in-time recovery of SQLite-backed Durable Objects exists for 30 days, from inside the object only. Failed on the way: `alchemy deploy` with Access, first because Zero Trust was off (the owner turned it on), then `auth.forbidden` because the Alchemy login had Basic permissions; Alchemy's binding clients need a `RuntimeContext` that a workflow's layer does not have, worked round by reading it at init. **Left unticked after the review:** five unknowns were not run, and each is run first by the part named: Access in front of the Worker (C2), a trace span seen in Cloudflare (C4), `@alchemy.run/test` and the Worker bundle built from this workspace (C1), and the D1 REST calls from inside a Worker (D1). The multi-day wait was read from source, not waited for. None blocks Part B. A2 is ticked when the last of them has run.*
- [x] **A3. The spec is written:** [milestones/m2.md](milestones/m2.md) with findings, decisions flagged for the owner, and the later parts with their groups added here. *2026-11-24: findings, the design, 15 decisions (four put to the owner and accepted), what the owner must do before Parts C and D, four later parts with 13 groups, and seven gaps. Revised the same day after a `/code-review medium` pass with ten findings, all applied on the owner's answers: four more decisions (16 to 19: secrets held by the engine and never logged, the recipe document kept with the run, cleanup of a temporary database by name, a gate's wake repeated until it lands), two more gaps, and corrections to B1, B3, D1 and D3, listed in the spec under "After the review". [Decision 0003](decisions/0003-orchestration.md) and [decision 0004](decisions/0004-persistence.md) are updated: a run is two Durable Objects.*
- [ ] **B1. Values have a written form and a run records its inputs:** `valueFits` in core with property tests; `RunStarted.inputs`; `bun run check` and `bun run mutate` pass.
- [ ] **B2. `decide` chooses every next step:** played against scripted outcomes over generated recipes, every event it leads to is accepted by `transition`, every finished log follows one of the validator's paths, and every enumerated path is reached; a planted bug is found.
- [ ] **B3. The driver runs recipes on the in-memory engine:** each final state, gates, cancellation, undo, `finally`, retries, output type checks, one append per event when an activity runs twice, a block limited to its declared services, and a span per step.
- [ ] **C1. The engine is deployed with Alchemy:** a run of fake blocks on a `pr-*` stage survives a deploy at its gate and an immediate deploy mid-step, with each event in its log once.
- [ ] **C2. The API is behind Access:** a request without credentials is refused, and an approval records the caller's identity.
- [ ] **C3. A finished run is archived:** its log is one write-once object in R2 that replays to the state the index records.
- [ ] **C4. The infrastructure rails run:** CI deploys, tests and destroys a stack per pull request, and a step's span is in Cloudflare's traces.
- [ ] **D1. The drill's blocks are implemented:** each block's success, typed failures and safe re-run are tested against a fake Cloudflare API.
- [ ] **D2. A restore drill completes end to end** on the seeded sample database: export, create, restore, verify, tear down, record, with no temporary database left.
- [ ] **D3. Failure and crash leave nothing behind:** a forced failure at each step leaves no temporary database; a kill at each step loses no run and duplicates no side effect; a write during the export fails the step and the retry succeeds.
- [ ] **E1. Staging and production are deployed,** and production has run the drill against staging.
- [ ] **E2. The drill runs against Aemeth's own D1 index** and checks that archived event logs replay to their recorded final states; a planted bad archive fails it.
- [ ] **E3. The milestone closes:** every rail passes, every acceptance criterion under M2 has its evidence, and this section moves to [milestones/m2.md](milestones/m2.md).

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
