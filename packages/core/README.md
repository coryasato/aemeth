# packages/core

The pure core: block and recipe schemas, the recipe validator, the run `transition` function and the invariants.

Imports no other workspace package and touches no infrastructure. Everything here can be tested in memory.

- `src/validate/`: the recipe validator, one module per stage. `validate(recipe, blocks)` returns every path of a valid recipe, or the stage that rejected it with its errors.
- `src/run/`: a run as a log of events. `RunEvent` and `RunState` are Schemas; `transition(state, event)` gives the next state or a typed rejection; `idempotencyKey` gives the key a block is re-run with.
- `src/invariants/`: one rule per file. Owned by a person. See its README before editing.
- `src/testing/`: builders, a recipe generator, a guided generator of run events and a checker of the run invariants, for the tests. Not part of the package's exports.
