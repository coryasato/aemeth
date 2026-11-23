# Versions

Verified on 2026-11-23. Use the latest release that satisfies every constraint here, pin exact versions, and update this file when anything changes.

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
| `@effect/tsgo` | 0.73.x | Replaces the Effect language service on TypeScript 7 |
| `typescript` | 7.0.2 | Alchemy's own repository uses 7.1 beta |
| `oxlint` | 1.94 or later | |
| `oxfmt` | 0.79 or later | |

## Constraints

- **The `effect` version must satisfy both Alchemy and Foldkit.** Today that means 4.1.4 or later within 4.1. Foldkit's peer range is `~4.1.0`, so a new `effect` minor is adopted once Foldkit's range includes it. Foldkit is moving under the Effect organization, so this is expected to follow quickly.
- **Foldkit feature development is paused.** Its author joined the Effect team on 2026-11-19, and a successor is being built inside Effect with a migration path. Critical fixes continue. Use the npm release.
- **Several Effect modules are marked unstable** and may break in minor releases: `effect/rpc`, `effect/http`, `effect/http-api`, `effect/workflow`, `effect/cluster`, `effect/sql`, `effect/cli`, `effect/ai`. The paths are not under `effect/unstable/`.
- **Alchemy does not run inside a Worker.** Its plan and apply functions need Node or Bun.

## Not yet verified

To check in milestone 0:
- Whether Effect's `Arbitrary.schema` is built on fast-check or is Effect's own generator.
- Stryker, knip and lefthook compatibility with Vitest 5 and TypeScript 7.
- The Foldkit Vite plugin under Bun.
- What Cloudflare currently offers for point-in-time recovery of SQLite-backed Durable Objects, before milestone 2.
- PlanetScale Postgres branching, before the Postgres variant of recipe 4.

## Documentation sources

- Effect: https://effect.website and https://github.com/Effect-TS/effect
- Alchemy: https://alchemy.run and https://alchemy.run/llms.txt
- Foldkit: https://foldkit.dev/llms.txt, https://foldkit.dev/llms-full.txt, https://github.com/foldkit/foldkit
- Cloudflare Artifacts: https://developers.cloudflare.com/artifacts/
- Oxlint type-aware linting: https://oxc.rs/docs/guide/usage/linter/type-aware.html
