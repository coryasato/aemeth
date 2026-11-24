# packages/recipes

The six recipes of [docs/recipes.md](../../docs/recipes.md) as files, and the JSON Schema generated from the `Recipe` Schema in `packages/core`.

- `*.recipe.json`: one recipe each, named after its id. Merging one is publishing it ([decision 0002](../../docs/decisions/0002-recipe-is-a-graph.md)).
- `recipe.schema.json`: generated, for editors and outside tools. Each recipe points at it with `"$schema": "./recipe.schema.json"`. The Effect decoder stays the authority. Do not edit it by hand; after changing the `Recipe` Schema run `bun run --filter @aemeth/recipes generate`.

`bun run test` runs the validator from `packages/core` on every recipe file, against the blocks declared in `packages/blocks`: structure, size, cycles, types, every path and every invariant. It also fails if `recipe.schema.json` is stale.

Depends on `packages/core` and `packages/blocks`.
