# Versions

Verified on 2026-11-23 and re-checked in M1 Part A the same day, with no change. The tooling rows, Foldkit and its Vite plugin were also installed and run in M0 Part A. Use the latest release that satisfies every constraint here, pin exact versions, and update this file when anything changes.

## Verified

| Package | Version | Notes |
|---|---|---|
| `effect` | 4.1.5 | Stable since 4.0.0 on 2026-10-01 |
| `alchemy` | 2.0.0-beta.87 | Beta, breaking changes expected. Peer: `effect ^4.1.4` |
| `foldkit` | 0.171.0 | npm release matches the main branch. Peer: `effect ~4.1.0` |
| `@foldkit/vite-plugin` | 0.29.1 | Peer: `vite ^8` |
| `@foldkit/ui`, `@foldkit/devtools` | 0.171.0 line | Headless components; time-travel overlay |
| `@effect/platform-cloudflare` | 4.1.5 | Experimental: may break in patch releases |
| `@effect/sql-d1`, `@effect/sql-sqlite-do`, `@effect/sql-pg` | 4.1.5 | |
| `@effect/vitest` | 4.1.5 | Requires Vitest 5 |
| `@effect/tsgo` | 0.73.4 | Replaces the Effect language service on TypeScript 7. Run as `effect-tsgo tsc` |
| `typescript` | 7.0.2 | Alchemy's own repository uses 7.1 beta. Has no JS API |
| `oxlint` | 1.94.0 | Held back from 1.95.0: `@effect/tsgo` 0.73.4 supports up to 1.94.0 |
| `tsrs` | 7.1.0-beta.tsrs4 | Oxlint's type-aware backend. Held back from `tsrs5` for the same reason |
| `@cloudflare/oxlint-config` | 0.2.0 | Trial passed in M0 Part A, see [quality-rails.md](quality-rails.md) |
| `oxfmt` | 0.80.0 | |
| `vitest` | 5.1.1 | Runs on Node, not on the Bun runtime |
| `vite` | 8.3.8 | |
| `@stryker-mutator/core`, `@stryker-mutator/vitest-runner` | 10.1.1 | Needs the `tsconfigFile` workaround, an explicit `plugins` entry, and to run from the repository root, see [milestones/m0.md](milestones/m0.md) |
| `knip` | 6.48.0 | Parses with oxc, independent of TypeScript |
| `lefthook` | 2.2.2 | |
| `@types/bun` | 1.4.5 | Types for the Claude Code hook in `.claude/hooks`. Local runtime is Bun 1.4.4 |

## Constraints

- **The `effect` version must satisfy both Alchemy and Foldkit.** Today that means 4.1.4 or later within 4.1. Foldkit's peer range is `~4.1.0`, so a new `effect` minor is adopted once Foldkit's range includes it. Foldkit is moving under the Effect organization, so this is expected to follow quickly.
- **Foldkit feature development is paused.** Its author joined the Effect team on 2026-11-19, and a successor is being built inside Effect with a migration path. Critical fixes continue. Use the npm release.
- **Several Effect modules are marked unstable** and may break in minor releases: `effect/rpc`, `effect/http`, `effect/http-api`, `effect/workflow`, `effect/cluster`, `effect/sql`, `effect/cli`, `effect/ai`. The paths are not under `effect/unstable/`.
- **Alchemy does not run inside a Worker.** Its plan and apply functions need Node or Bun.
- **`@effect/tsgo` sets the ceiling for Oxlint and tsrs.** Check its "Supported Package Versions" table before moving either.
- **Vitest and Stryker run on Node.** `bun --bun vitest` fails to start its workers. Node 22.18 or later is required (the Oxlint preset loads `oxlint.config.ts` with Node); Node 26 is used.
- **TypeScript 7 has no JS API.** Tools that call it (Stryker's tsconfig rewrite, `@stryker-mutator/typescript-checker`) need a workaround or are not used.

## Verified in M0 Part A (2026-11-23)

- Effect's `Arbitrary` is Effect's own generator, not fast-check. `effect` has no dependencies. The module is marked unstable. `@effect/vitest`'s `it.prop` takes Schemas directly.
- Stryker works with Vitest 5 under Bun with the `tsconfigFile` workaround. knip and lefthook work with TypeScript 7.
- The Foldkit Vite plugin builds under Bun, and a Foldkit Story test passes under Vitest 5.

## Verified in M0 Part C (2026-11-23)

- Stryker runs `packages/core` with Vitest 5 under Bun's isolated linker. Its sandbox breaks a relative tsconfig `extends` unless the sandbox copies the repository from its root, so `bun run mutate` runs Stryker from the root.
- GitHub Actions: `actions/checkout@v7.0.1`, `oven-sh/setup-bun@v2.2.0`, `actions/setup-node@v7.1.0` are the latest releases. CI pins Bun 1.4.4 and Node 26.12.1.

## Verified in M1 Part A (2026-11-23)

- `Schema.toJsonSchemaDocument` (stable) generates draft 2020-12 JSON Schema. It returns `{ dialect, schema, definitions }`; a standalone file adds `$schema` and renames `definitions` to `$defs`. `isPattern` is emitted only for a RegExp with the `u` flag. `Schema.Number` also admits the strings `"Infinity"`, `"-Infinity"` and `"NaN"`; use `Finite` or `Int` in documents.
- `Arbitrary.filter` on an array stalls under `it.prop` (every value discarded). Build generators constructively. `it.prop` takes run counts as `{ arbitrary: { runs } }`.
- `effect/Graph` is marked unstable throughout; M1 does not use it.
- Oxlint 1.94.0 has `require-unicode-regexp`.
- `ajv` 8.20.0 was used in the scratch project only, to check the generated JSON Schema. It is not a dependency.

## Verified in M1 Part B (2026-11-23)

- The generator derived from a Schema gives a Struct at most `size` properties, so a Struct with that many required fields never gets its optional keys. Pass a larger `size` to `it.prop` (`{ arbitrary: { runs, size } }`).
- A derived generator supports `isPattern`, so branded ids with patterns need no hand-written generator.
- `Schema.Finite` admits `-0`, which JSON text writes as `0`.
- `Schema.Record` with a branded, pattern-checked key rejects other keys under `onExcessProperty: "error"`, and becomes `propertyNames` in the JSON Schema.
- `Schema.decodeResult` is what `@effect/tsgo` asks for (`preferTypedSchemaDecoder`) when the input already has the Schema's `Encoded` type.
- `@types/bun` 1.4.5 is now also a dev dependency of `packages/recipes`, for its `generate` script.

## Not yet verified

- What Cloudflare currently offers for point-in-time recovery of SQLite-backed Durable Objects, before M2.
- PlanetScale Postgres branching, before the Postgres variant of recipe 4.
- D1's point-in-time restore to a bookmark, which recipe 4's revert step assumes, before M7.
- That a D1 export is one consistent snapshot whose row count and checksum can be taken with it, which recipe 1's check assumes, before M2.

## Documentation sources

- Effect: https://effect.website and https://github.com/Effect-TS/effect
- Alchemy: https://alchemy.run and https://alchemy.run/llms.txt
- Foldkit: https://foldkit.dev/llms.txt, https://foldkit.dev/llms-full.txt, https://github.com/foldkit/foldkit
- Cloudflare Artifacts: https://developers.cloudflare.com/artifacts/
- Oxlint type-aware linting: https://oxc.rs/docs/guide/usage/linter/type-aware.html
