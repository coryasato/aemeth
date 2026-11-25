# packages/core

The pure core: block and recipe schemas, the recipe validator, the run `transition` function, the engine's `decide` function and the invariants.

Imports no other workspace package and touches no infrastructure. Everything here can be tested in memory.

- `src/validate/`: the recipe validator, one module per stage. `validate(recipe, blocks)` returns a valid recipe with its names looked up and every path it can take, or the stage that rejected it with its errors.
- `src/run/`: a run as a log of events. `RunEvent` and `RunState` are Schemas; `transition(state, event)` gives the next state or a typed rejection; `idempotencyKey` gives the key a block is re-run with. `decide(recipe, state, sizeOf)` says what a run does next, and `followsRecipe(recipe, log)` says whether a log did what its recipe says. `values.ts` reads a step's inputs out of the log.
- `src/Value.ts`: the written form of values, and `valueFits(type, value)`.
- `src/invariants/`: one rule per file. Owned by a person. See its README before editing.
- `src/testing/`: builders, a recipe generator, a guided generator of run events, a checker of the run invariants and a scripted player of `decide`, for the tests. Other packages' tests import them as `@aemeth/core/testing`; nothing else does.
