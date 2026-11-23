# 0001: Product scope

Date: 2026-11-23. Status: accepted.

## Decision

Aemeth is one product: verified recipes for operational procedures. Blocks are code, recipes are data, and a recipe cannot run until the validator has checked every path through it. The UI is for authoring recipes, running them and approving gates.

## What "checked" means

The validator checks each path against what every block declares: its reads, writes and undo. It does not prove that a block's code matches its declaration. The engine narrows that gap by giving a block only the services it declares (milestone 2), and full enforcement is planned under capability limits.

## First workload

Aemeth operates itself. Every planned recipe has a target inside Aemeth, listed in [../recipes.md](../recipes.md). A seeded sample database is used only until Aemeth's own data exists.

## What was dropped

The original brief put a standalone, read-only control panel for Alchemy state first, with the runbook engine second and an enforced boundary between them. That was dropped because:

- Alchemy now has a supported state read API, so the panel's hardest problem no longer exists.
- Alchemy has open draft pull requests for an official hosted state viewer.
- A read-only viewer does not exercise the project's purpose, which is checkable correctness.

A small stacks view may be added to the UI later through Alchemy's `State` service.

## What Aemeth is not

- **Not an agent factory or an agent runtime.** It is built for people first. Agents may later use it through an API or MCP server.
- **Not a deploy dashboard.** Viewing state and approving a single plan or deploy belong to Alchemy's own tools. Aemeth handles multi-step procedures with checks, gates and guaranteed cleanup.
- **Agents do not approve gates.** A gate exists for a person's judgment. Changing this needs a new decision record.
