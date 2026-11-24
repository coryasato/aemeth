# packages/recipes

The six recipes of [docs/recipes.md](../../docs/recipes.md) as files, and the JSON Schema generated from the `Recipe` Schema in `packages/core`.

- `*.recipe.json`: one recipe each, named after its id. Merging one is publishing it ([decision 0002](../../docs/decisions/0002-recipe-is-a-graph.md)).
- `recipe.schema.json`: generated, for editors and outside tools. Each recipe points at it with `"$schema": "./recipe.schema.json"`. The Effect decoder stays the authority. Do not edit it by hand; after changing the `Recipe` Schema run `bun run --filter @aemeth/recipes generate`.

`bun run test` fails if a recipe file does not decode, names a block, step, input or output that does not exist, or if `recipe.schema.json` is stale. Types, order and paths are not checked until the validator arrives in M1 Part C.

Depends on `packages/core` and `packages/blocks`.
