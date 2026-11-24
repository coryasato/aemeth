---
name: milestone
description: Open, work and close an Aemeth milestone (M0, M1, …) from docs/plan.md. Use when starting a milestone, writing its Part A research and spec, starting or finishing a later part (Part B, C, …), ticking its "Done when" checks, or closing a milestone. Also covers the "Status" table and "Active milestone" section in docs/plan.md, and the end-of-session commit message.
---

# A milestone: open, work in parts, close

Milestones and their acceptance criteria live in `docs/plan.md`. The rules every change follows are in the root `CLAUDE.md`. This skill covers the steps between.

## Names

- Milestones are M0, M1, … (M5 to M9 are one per recipe; see `docs/recipes.md`). The design session before M3 is not numbered.
- A milestone is split into parts: Part A, Part B, … Each part is one fresh session.
- A part is split into groups of work: A1, A2, B1, B2, … Each group ends at something that can be checked.

## Where things go

| Fact | Home |
|---|---|
| Every milestone's status, at a glance | `docs/plan.md`, "Status" table |
| What a milestone must achieve (acceptance criteria) | `docs/plan.md`, the milestone's own section |
| The open milestone: why, scope, parts, and the "Done when" checklist with evidence | `docs/plan.md`, "Active milestone" |
| Research findings, the spec's decisions, step-by-step instructions per group | `docs/milestones/m<N>.md` |
| A closed milestone's "Active milestone" section, as history | `docs/milestones/m<N>.md`, appended at the close |
| A decision that outlives the milestone | `docs/decisions/<NNNN>-<slug>.md` (new record; do not reopen an accepted one unless the owner asks) |
| A version, or a constraint between versions | `docs/versions.md` |
| A rail, or what a tool trial found | `docs/quality-rails.md` |
| The commands that run the checks | `CLAUDE.md`, "Running the checks" |

Write each fact in one home and link to it from the others.

## Part A: research and spec

Every milestone opens with Part A. It builds no product code.

1. Read `docs/plan.md` for the milestone, the decisions it cites, `docs/versions.md` and `docs/quality-rails.md`.
2. Check current versions on the npm registry and current documentation for every library the milestone touches (sources are in `docs/versions.md`). Do not rely on memory of Effect, Alchemy or Foldkit APIs.
3. Resolve unknowns by running them. Install into the session scratchpad, not the repository, and record what was run and what happened.
4. Write `docs/milestones/m<N>.md`:
   - **Part A findings:** what was verified and how, including what failed and the workaround.
   - **Decisions made in this spec:** numbered, each one a default the owner can overturn. Flag those that need the owner.
   - **One section per later part**, split into groups, each with the steps to build it and how it is shown to work.
5. Write the "Active milestone" section in `docs/plan.md` (see below), with Part A's groups ticked and their evidence, and set the milestone's row in "Status" to `Active: Part B next`.
6. Record verified versions and constraints in `docs/versions.md`, and tool trial results in `docs/quality-rails.md`.

## A later part

1. Read "Active milestone" in `docs/plan.md`, then `docs/milestones/m<N>.md` and whatever it points to. Work only the current part.
2. Do the groups in order. A group is done when its checks pass. A rail must also be shown to fail once on a planted violation, then the violation removed.
3. If the work shows the spec is wrong or something is missing, change the spec, say so in the group's evidence, and add the new part and its groups to "Active milestone" before the close if the work does not fit this session.
4. End the part:
   - Tick each group it closed in "Active milestone", with its evidence in italics after it: the date, the commands run and their results, and anything that differed from the spec.
   - Leave a group unticked if any of its checks failed, and say why in its evidence. Report failures with their output.

## Close

The milestone closes after its last part, before the next one opens.

1. Check each acceptance criterion in the milestone's section of `docs/plan.md` against the ticked groups' evidence. A criterion with no evidence is not met.
2. Every rail in `docs/quality-rails.md` passes.
3. Move what outlives the milestone to its home: decision records, `docs/versions.md`, `docs/quality-rails.md`, `CLAUDE.md`.
4. Move the "Active milestone" section, unchanged, to the end of `docs/milestones/m<N>.md` under "## Closed", headed with the close date.
5. Set the milestone's row in the "Status" table to `Done <date>` with a link to its spec. Open the next milestone: its "Active milestone" section with Part A as its first part. Update the "Status" section of `README.md`.

## "Active milestone" in plan.md

One section, placed below "Status" and above the milestone list, for the one open milestone. In order:

- **Heading:** `## Active milestone: M<N>, <name>`.
- **Opened** date, number of parts, and links to the acceptance criteria and the spec.
- **Why:** one or two sentences, citing the decision or document it comes from.
- **What it sets up** and **Left out:** short scope, with links rather than repeated detail.
- **Split into parts:** one line per part, saying what it builds, which groups it closes, and what the owner must do in it (in italics).
- **Done when:** a checklist with one item per group (`- [ ] **B1. <the check>:** …`). Each item states a check someone can verify. When ticked, it is followed by the evidence in italics.

## "Status" in plan.md

A table directly above "Active milestone", with one row per milestone (and the unnumbered design session) in order: Milestone, Title, Status. Status is one of:

- `Not started`
- `Active: Part <X> next` linking to "Active milestone"
- `Done <date>` linking to `docs/milestones/m<N>.md`

It is the only place a milestone's status is written. Update it and "Active milestone" at the end of every session.

## End of every session

The owner handles git. Do not commit, branch or push. End the session with one concise commit message line, for example:

```
M0 Part B: Bun workspace, typecheck, lint, format, tests, knip, core import boundary
```
