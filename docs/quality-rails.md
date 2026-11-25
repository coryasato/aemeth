# Quality rails

Most code in this repository is written by coding agents, so correctness has to be checked by machines. A person owns the invariants; the rails check the implementation against them. All rails are set up in M0, before feature work.

| Layer | Tool | Scope |
|---|---|---|
| Types | TypeScript 7, `strict` | Everything |
| Effect diagnostics | `@effect/tsgo` | Everything |
| Lint | Oxlint, type-aware | Everything |
| Format | Oxfmt | Everything |
| Unit and Effect tests | Vitest 5 with `@effect/vitest` | Everything |
| Property tests | Inputs generated from the app's own Schemas | `packages/core` |
| Path checking | The recipe validator, run against the six recipe fixtures | `packages/core` |
| Run state machine | State-guided random event sequences against `transition`, invariants checked after each event | `packages/core` |
| UI logic | Foldkit Story and Scene tests | `apps/web` |
| Test quality | Stryker mutation testing | `packages/core` |
| Dead code and dependencies | knip | Everything |
| Import boundary | A check that `packages/core` imports no other workspace package | `packages/core` |
| Git hooks | lefthook | Lint, format, types on commit |
| CI | GitHub Actions | All of the above on every push |
| Engine decisions | `decide` played against scripted outcomes over generated recipes and over the six recipe files, each log checked by `transition` and by `followsRecipe` against the validator's paths | `packages/core`, `packages/recipes` |
| Block services | A block's code is typed to need exactly the services it lists; a use of another is kept in a test as an expected compile error, and at run time the engine withholds it | `packages/blocks`, `apps/engine` |
| Integration | A temporary Alchemy stack per pull request, destroyed afterwards | `apps/engine`, `infra` |
| Tracing | Effect spans recorded in Cloudflare's trace of each invocation, which Cloudflare can export over OTLP; one span per execution of a block, checked with an in-memory tracer at the end of every engine test | `apps/engine` |

## Property tests

Found in M1 Part A ([milestones/m1.md](milestones/m1.md)):

- **Build generators constructively.** `Arbitrary.filter` that rejects small values stalls, so use `minLength`, bounded ranges, and add the wanted shape (a cycle, a back edge) by construction.
- **Guide event sequences by state.** Uniform random events end a run within a few events and missed a planted bug; picking among the events that could arrive in the current state found and shrank it.
- **Assert coverage.** Each property test over a generator counts the shapes or states it reached, and a following test fails if a required one was never reached, so a property cannot pass vacuously.
- **Give a large Struct a larger `size`.** The derived generator gives a Struct at most `size` properties, so optional keys of a Struct with many required fields are never generated at the default. Found by a coverage test in M1 Part B.
- **Decode a fixed document for each Schema, with unknown fields rejected.** A property over a derived generator follows the Schema, so it cannot see a field that a mutant removed. One document that uses every tag does.

Found in M1 Part C:

- **Build a fixed-length array with `isMinLength` and `isMaxLength`,** then make every choice from it by index. It does not stall, and the property shrinks towards zeros.
- **Compare whole values at least once per shape.** A test that compared paths rendered as text missed a stray field that a test comparing the objects found.
- **Check the property's own oracle on a hand-written case.** The path-shape property first failed because its expectation was wrong, not the code.
- **A stage's tests look only at that stage,** but fail if an earlier stage rejected the recipe: otherwise "no errors here" passes for a recipe that never got there.
- **Read the surviving mutants of a rule.** A score above the threshold still hid twelve branches in the invariants that no test told apart.

Found in M1 Part D, on the run state machine:

- **Give the property two opinions.** The generator reads the state to list what could arrive next, so it cannot judge that state. The run invariants are checked by separate code that reads only the log.
- **Say which candidates must be rejected.** Each state lists good events and bad ones, and the property fails if a good one is rejected or a bad one accepted. Without the bad ones, a `transition` that accepts everything passes.
- **Count how often each rare case is reached, then choose the number of runs.** A coverage test that a case was reached at least once fails by chance if the case is rare. The rarest here were reached twice in a thousand runs at first. Weighting the generator towards them brought that to about fifteen, so a thousand runs are enough.
- **A coverage test from Part C failed by chance at the close.** The path tests asked for a generated recipe with more than 50 paths, which 300 runs gave about 4 times and, one run in fifty, not at all. It stopped `bun run mutate` at its first test run. The threshold is now 20, reached about 80 times.
- **The same happened to a coverage test written in Part D.** The round-trip test of `RunEvent` missed its rarest value, in one generated event in about a hundred, one run in twenty at 300 runs. When a coverage test is added, work out or count how often its rarest case comes up, and run the suite many times in a row before calling it done.
- **Weight choices by repeating them, never by a counter the sequence moves.** Offering an event "when `seq` is even" meant that dropping one event changed what every later number picked, and a failing sequence would not shrink.
- **Let a sequence shorten itself.** A turn may produce no event, and when a sequence fails the test drops every turn the failure does not need before it reports. The generator's own shrinking changes one number at a time and cannot drop a step, whose start and end are two turns.

Found in M2 Part B, on `decide`:

- **Derive a script from each path, and play every one.** "Every path is reached" is not left to chance: for each path the validator enumerates there is a script that follows it, and the run must arrive at exactly that path. A second property lets anything happen and asks only that the log follows some path.
- **Give the engine's decisions a second opinion that never calls them.** `followsRecipe` reads the log and the recipe; `decide` reads the state and the recipe. Two bugs were found by their disagreeing, one in each.
- **A value the generator can make empty will be empty.** Both of those bugs were about a for-each over an empty list, which leaves no event. Lists of zero to six items found them within a few hundred runs.
- **Read a redundant branch off the surviving mutants.** A special case in `decide` survived every mutation because the code after it did the same thing. It was removed, not tested.
- **Do a test's work inside the test, not where its file is loaded.** The new unit tests resolved their recipes in `describe` bodies. Stryker then could not tell which test covers a mutant of the validator, called it static, and ran the whole suite for each: the run went from ten minutes to 28, and about fifty mutants that used to survive were counted as detected because they timed out. The helper that resolves a recipe now works nothing out until a test reads it. When a mutation run slows down, look at the timeouts per file in the report before anything else.
- **Bound what a property does when the code under it is wrong.** A mutant of the path walk can give a recipe ten thousand paths, and a mutant of `decide` a run that never ends. The path property refuses a recipe with more than 1,000 paths, ten times the most seen, and the player stops after 400 decisions.
- **A test that walks a million items is a slow mutation run.** A test of the longest list a for-each can run over checked a million items twice, and the next mutation run had a hundred timeouts again. An array of that length with nothing in it tests the same bound in four milliseconds.
- **A test double that decides once is not a retry.** An effect built once and run twice makes the same choice twice. A fault meant to happen "the first time" has to be chosen when the effect runs.

## Invariants

- Invariants live in `packages/core/src/invariants/`.
- They are written and reviewed by a person.
- A coding agent may add one. Changing or removing one needs the owner's explicit approval.
- A Claude Code hook flags any edit in that folder.

## Lint preset

M0 trials `@cloudflare/oxlint-config` (0.2.0, first published 2026-11-20) as the base Oxlint config, pinned exactly, with overrides for Effect-style code.

**Trial result (M0 Part A, 2026-11-23): adopted.** Three overrides were needed. Type-aware rules work through `tsrs` without `oxlint-tsgolint`. Details in [milestones/m0.md](milestones/m0.md).

- **Why try it:** every rule is listed explicitly at error level, and it includes the strict type-aware rules this project wants: no `any`, the `no-unsafe-*` family, exhaustive switches, no floating or misused promises, and no unused disable comments.
- **What it is:** `@nkzw/oxlint-config` 4.1.0 plus about 19 Cloudflare additions, about 228 rules in total. Published by Cloudflare with provenance. It is 0.x with no stated stability policy, and nothing in it is specific to Workers.
- **What it does not cover:** a discarded Effect value. `@effect/tsgo` covers that, so both tools are needed.
- **Fallback (agreed):** if the trial needs more than about ten overrides or produces false positives on Effect code, write our own config and copy the strict type-aware rules we want.
- **Requirements (confirmed):** it needs type-aware linting through `tsrs`, currently a 7.1 beta, and is configured in `oxlint.config.ts`, not `.oxlintrc.json`.

### Known conflicts

These were inferred from the rule list on 2026-11-23, then run against Effect-style code in M0 Part A. The first three fired and are turned off. `curly` also fired and is kept. The rest did not fire on the sample.

| Rule | Conflict | Planned action |
|---|---|---|
| `import-x/no-namespace` | Bans `import * as X`, which Effect and Alchemy code uses | Off |
| `@nkzw/no-instanceof` | Blocks `instanceof` checks on tagged error classes | Off |
| `require-yield` | Flags an `Effect.gen` generator with no `yield` | Off |
| `typescript/unbound-method` | May fire on class-based services and destructured methods | Adjust if it fires |
| `quality/no-unknown-returns`, `quality/no-unknown-type-aliases` | Flag explicit `unknown`, which decoders return | Adjust if they fire |
| `typescript/no-unsafe-type-assertion`, `no-unsafe-*`, `no-explicit-any` | Friction in generic-heavy code | Keep. Fix the code, or disable per line with a reason |
| `unicorn/consistent-function-scoping` | Style only | Off for `**/*.test.ts` since M1 Part C: it fired on every helper kept inside its `describe`. On elsewhere |
| `unicorn/prefer-top-level-await` | Style only; Effect programs are run through a runtime | Adjust if noisy |
| `typescript/array-type` (forces `Array<T>`) | Style only | Keep unless it clashes with generated code |
| `no-console` | Applies everywhere, including scripts | Keep. Use Effect's logger |
| React and `jsx-a11y` rules (about 40) | Do not apply to Foldkit | Leave on; they should never fire |

`reportUnusedDisableDirectives` is an error in this preset, so every disable comment must still be needed.

## Tools confirmed in M0

Every tool above that M0 sets up works with the current stack, and none was replaced. The workarounds:

- **Stryker:** TypeScript 7 has no JS API, so its tsconfig rewrite is skipped, and it runs from the repository root so relative tsconfig `extends` still resolve. `@stryker-mutator/typescript-checker` is not used. Details in [milestones/m0.md](milestones/m0.md).
- **Vitest and Stryker run on Node,** not on the Bun runtime.
- **Test helpers are not mutated.** `packages/core/src/testing/` is left out of Stryker's `mutate` globs (M1 Part C). A full run on `packages/core` took five to seven minutes at the end of M1 Part C, nine to eleven after Part D, and takes about thirteen since M2 Part B, which added `decide` and `followsRecipe`; CI allows the whole job thirty.
- **A brand name is invisible at runtime,** so Stryker's mutant of `Schema.brand("X")` cannot be killed. Mark it with `// Stryker disable next-line StringLiteral` and a reason; never raise `ignoreStatic` to hide it, since Schemas are static code.

Story and Scene tests, per-PR integration stacks and tracing arrive with M2 and M3. How M2 builds its rails is in [milestones/m2.md](milestones/m2.md). Items still to verify are under "Not yet verified" in [versions.md](versions.md).
