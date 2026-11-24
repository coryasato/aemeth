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
| Integration | A temporary Alchemy stack per pull request, destroyed afterwards | `apps/engine`, `infra` |
| Tracing | Effect tracing exported over OTLP, one span per run step | `apps/engine` |

## Property tests

Found in M1 Part A ([milestones/m1.md](milestones/m1.md)):

- **Build generators constructively.** `Arbitrary.filter` that rejects small values stalls, so use `minLength`, bounded ranges, and add the wanted shape (a cycle, a back edge) by construction.
- **Guide event sequences by state.** Uniform random events end a run within a few events and missed a planted bug; picking among the events that could arrive in the current state found and shrank it.
- **Assert coverage.** Each property test over a generator counts the shapes or states it reached, and a following test fails if a required one was never reached, so a property cannot pass vacuously.
- **Give a large Struct a larger `size`.** The derived generator gives a Struct at most `size` properties, so optional keys of a Struct with many required fields are never generated at the default. Found by a coverage test in M1 Part B.
- **Decode a fixed document for each Schema, with unknown fields rejected.** A property over a derived generator follows the Schema, so it cannot see a field that a mutant removed. One document that uses every tag does.

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
| `unicorn/consistent-function-scoping` | Style only | Adjust if noisy |
| `unicorn/prefer-top-level-await` | Style only; Effect programs are run through a runtime | Adjust if noisy |
| `typescript/array-type` (forces `Array<T>`) | Style only | Keep unless it clashes with generated code |
| `no-console` | Applies everywhere, including scripts | Keep. Use Effect's logger |
| React and `jsx-a11y` rules (about 40) | Do not apply to Foldkit | Leave on; they should never fire |

`reportUnusedDisableDirectives` is an error in this preset, so every disable comment must still be needed.

## Tools confirmed in M0

Every tool above that M0 sets up works with the current stack, and none was replaced. The workarounds:

- **Stryker:** TypeScript 7 has no JS API, so its tsconfig rewrite is skipped, and it runs from the repository root so relative tsconfig `extends` still resolve. `@stryker-mutator/typescript-checker` is not used. Details in [milestones/m0.md](milestones/m0.md).
- **Vitest and Stryker run on Node,** not on the Bun runtime.
- **A brand name is invisible at runtime,** so Stryker's mutant of `Schema.brand("X")` cannot be killed. Mark it with `// Stryker disable next-line StringLiteral` and a reason; never raise `ignoreStatic` to hide it, since Schemas are static code.

Story and Scene tests, per-PR integration stacks and tracing arrive with M2 and M3. Items still to verify are under "Not yet verified" in [versions.md](versions.md).
