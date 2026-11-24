# packages/core

The pure core: block and recipe schemas, the recipe validator, the run `transition` function and the invariants.

Imports no other workspace package and touches no infrastructure. Everything here can be tested in memory.

- `src/validate/`: the recipe validator, one module per stage. `validate(recipe, blocks)` returns every path of a valid recipe, or the stage that rejected it with its errors.
- `src/invariants/`: one rule per file. Owned by a person. See its README before editing.
- `src/testing/`: builders and a recipe generator for the tests. Not part of the package's exports.
