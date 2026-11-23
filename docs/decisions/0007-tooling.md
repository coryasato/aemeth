# 0007: Tooling and layout

Date: 2026-11-23. Status: accepted.

## Decision

- **Bun** is the runtime and package manager, with Bun workspaces.
- **TypeScript 7** with `@effect/tsgo`, **Oxlint** and **Oxfmt**, **Vitest 5**.
- **Foldkit, Alchemy and Effect are installed from npm** at pinned versions. Foldkit's npm release matches its main branch.
- **Layout:** `apps/web`, `apps/engine`, `packages/core`, `packages/blocks`, `infra`.

## Boundary

One rule is enforced by a check in CI: `packages/core` imports no other workspace package. The stricter boundary scheme in the original brief existed to keep a standalone panel separate, and went with it ([0001](0001-product-scope.md)).

## Notes

Alchemy's and Foldkit's own repositories use pnpm. That does not constrain this repository, since both are consumed as published packages. The full list of rails is in [../quality-rails.md](../quality-rails.md).
