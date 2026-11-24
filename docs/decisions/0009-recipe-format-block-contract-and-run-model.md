# 0009: The recipe format, the block contract and the run model

Date: 2026-11-23. Status: accepted.

## Decision

M1 fixed the three things every later milestone builds on. Each was put to the owner as it was designed; the numbers below are the decisions in the [M1 spec](../milestones/m1.md), which holds the detail and the reasons.

### The recipe format

- **Control never forks.** A node has at most one edge per outcome, so a run follows one path. Work runs side by side only as the items of a for-each (1).
- **Data travels on bindings, edges carry control** (6, and [0002](0002-recipe-is-a-graph.md)). A step may read another step's output only where that step has succeeded on every path to it.
- **A recipe names its first step, and its "always runs" steps are a `finally` list.** Every `finally` step runs on every path, and takes data that may be missing as an optional reference (2, 20).
- **An explicit end states the result, and a failed end says whether undo runs** (15).
- **The graph is bounded:** 64 nodes, 8 edges into a node, 10,000 paths. Cycles are rejected before any path is walked (11).

### The block contract

- **A block declares its inputs, outputs, effects and undo as data.** Effects name the block's own inputs and outputs, never a concrete resource, so a block cannot name Aemeth's own resources.
- **A block must be safe to re-run.** No other kind can be declared. It is given a key derived from the run, the step, the phase and the for-each item, and a step's undo never shares its step's key (9).
- **An undo says how it is fed, and may change only what its step changed** (21, 22).
- **A created resource is `Temporary`, `Expiring` or `Durable`.** A temporary one carries its run's tag and must be destroyed by that run (23).

### Paths and invariants

- **The validator checks every path a run could take:** main, undo in reverse order, then `finally`, with a cancelled path before each step on the normal track, at each gate and partway through each for-each (17, 19).
- **Undo is per for-each item** (16). **A failure handler runs to its end** and is never cancelled; neither is cleanup (18).
- **A failed cleanup does not stop the cleanups after it, and ends the run in `NeedsAttention`,** a final state for a person (3). On the validator's paths, cleanups fail one at a time (25).
- **Two rules apply to every recipe, with no opt-out:** an irreversible step runs only after an approval, and a temporary resource is cleaned up (4, 23). A recipe asserts the others. The rules are owned by a person.

### The run model

- **A run is its log.** Every event is a fact in the past tense with the run's id, a `seq`, a time, the recipe's id and version, and the event schema version. The state, the timeline and the audit trail are computed from it by one pure function, `transition`, which the engine and the UI share.
- **`transition` never sees the recipe.** The log says what it could not look up: a step's phase, and how the main phase ended. It checks the order of facts, strictly (27); which step comes next is the engine's work.
- **An event that does not fit is a typed rejection,** never an exception.
- **Attempts are numbered, and the next follows only a failure marked retryable,** for steps and undos alike (26). A cancel takes effect before a retry (32).

## Why

The engine, the UI and the builder all read the same recipe and the same log. Fixing their shape in pure code first meant every rule could be tested with no infrastructure: all six recipes in [recipes.md](../recipes.md) validate, and the run state machine is checked by property tests over generated logs.

## Consequences

- A change to any of these is a change to a Schema in `packages/core`, and to this record.
- A change to an event's shape needs a new `eventSchemaVersion` once the engine has stored events (M2).
- The gaps the six recipes and the run model exposed are listed in the M1 spec under "Gaps found". Each names the milestone that could close it.
