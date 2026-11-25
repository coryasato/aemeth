# Versions

Verified on 2026-11-23 and re-checked in M1 Part A the same day, in M2 Part A on 2026-11-24 and in M2 Part C on 2026-11-25, with no change. M1 changed no version. The tooling rows, Foldkit and its Vite plugin were also installed and run in M0 Part A. Use the latest release that satisfies every constraint here, pin exact versions, and update this file when anything changes.

## Verified

| Package | Version | Notes |
|---|---|---|
| `effect` | 4.1.5 | Stable since 4.0.0 on 2026-10-01 |
| `alchemy` | 2.0.0-beta.87 | Beta, breaking changes expected. Peer: `effect ^4.1.4` |
| `@alchemy.run/cloudflare` | 2.0.0-beta.87 | Alchemy's Cloudflare provider, a separate package. Peers: `alchemy` at the same version, `effect ^4.1.4`, `@effect/platform-bun`, `@effect/platform-node`, `vite ^7 \|\| ^8`. A dependency of `apps/engine` and `infra` since M2 Part C |
| `@alchemy.run/test` | 2.0.0-beta.87 | Alchemy's test harness: deploys a stack to a stage, runs a suite, destroys it. Used through its Vitest adapter, on Node. Dev dependency of `infra` |
| `@effect/platform-bun`, `@effect/platform-node` | 4.1.5 | Peers of the Alchemy provider; nothing here imports them |
| `@effect/sql-sqlite-node` | 4.1.5 | SQLite through Node's own `node:sqlite`, no native build. Dev dependency of `apps/engine`: the engine's SQL log is tested on it |
| `@cloudflare/workers-types` | 5.20261125.1 | The Workers runtime's global types, for `apps/engine` and `infra`. The same version the Alchemy provider brings in |
| `@distilled.cloud/cloudflare` | 1.0.0-rc.20 | An Effect client for the Cloudflare REST API, a dependency of the provider. Candidate for the D1 blocks; not yet run in a Worker |
| `foldkit` | 0.171.0 | npm release matches the main branch. Peer: `effect ~4.1.0` |
| `@foldkit/vite-plugin` | 0.29.1 | Peer: `vite ^8` |
| `@foldkit/ui`, `@foldkit/devtools` | 0.171.0 line | Headless components; time-travel overlay |
| `@effect/platform-cloudflare` | 4.1.5 | Experimental: may break in patch releases. Optional peer: `@alchemy.run/cloudflare >=2.0.0-beta.85 <3` |
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
- **`alchemy` and `@alchemy.run/cloudflare` move together,** at the same exact version, inside the range `@effect/platform-cloudflare` accepts.
- **Alchemy's Cloudflare login is its own.** A profile in `~/.alchemy`, or `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` under `CI=true`. Wrangler's login is not used.
- **`@effect/platform-cloudflare` is imported by module, never by its index,** in anything the stack loads. The index also loads `CloudflareTracer`, which imports `cloudflare:workers` and so fails wherever the stack is planned (Bun or Node). That tracer is loaded with a dynamic `import()` inside the deployed Worker.
- **Alchemy's OAuth login cannot be made from a command without a terminal** (`NonInteractiveTerminal`), and `profile edit --add` refuses a provider that is already connected: use `--reconfigure`, in a real terminal. Access needs the Cloudflare One / Zero Trust scopes.
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

## Verified in M1 Part C (2026-11-23)

- No version changed. M1 still adds no runtime dependency to `packages/core`.
- `Schema.isMinLength` and `Schema.isMaxLength` apply to arrays, and the derived generator honours them constructively: a 64-number array ran 500 times under `it.prop` with no discards.
- `Result.succeed`, `Result.fail`, `Result.isFailure`, `Result.getOrThrow`, `Option.match` and `Option.map` are used as documented in 4.1.5.
- `Array.isArray` does not narrow a `ReadonlyArray` member out of a union in TypeScript 7.0.2; use a type guard.

## Verified in M1 Part D (2026-11-23)

- No version changed, and M1 closes with `effect` as the only runtime dependency of `packages/core`.
- `Schema.Json` has a derived generator and round-trips through `Schema.toCodecJson` and JSON text. It admits `null`.
- A `Schema.TaggedUnion` exposes its cases by tag as `.cases`, and a `Schema.Literals` its values as `.literals`. Tests use both to check that every tag was reached.
- `Result.map`, `Result.mapError` and `Result.flatMap` are used as documented in 4.1.5.
- `it.prop` stops shrinking after 100 candidates by default (`maxShrinks`), and on a fixed-length array it changes one number at a time.

## Verified in M2 Part A (2026-11-24)

Details and what was run are in [milestones/m2.md](milestones/m2.md).

- `effect/workflow` on `CloudflareWorkflowEngine` holds a run at a gate across deploys and restarts a run killed mid-step, deployed with Wrangler and with Alchemy (`AlchemyCloudflareCluster`). The same workflow runs on `WorkflowEngine.layerMemory`.
- A workflow cannot use its Durable Object's SQLite; an entity can, through `CloudflareCluster.DurableObjectSqlClient`.
- A deploy leaves a busy Durable Object on its old code for up to 300 seconds by default. `code_update_strategy` (`codeUpdateStrategy` in Alchemy) can make it immediate.
- SQLite-backed Durable Objects have point-in-time recovery for 30 days, from inside the object only. Nothing exports an object's storage from outside.
- A D1 export is taken at one bookmark while the database is unavailable to queries. It returns no row count and no checksum, and D1 SQL has no hash function, so both are computed by the caller.
- A D1 database has a name and no tags. A 75-character name was accepted.
- An R2 `put` from the Worker binding with `onlyIf: new Headers({ "If-None-Match": "*" })` writes an object once.
- Alchemy's binding clients need a `RuntimeContext`, which a workflow's layer does not have; reading it at init with `Effect.serviceOption` and providing it works.
- `wrangler` 4.168.0 was used in the scratch projects only. It is not a dependency.

## Verified in M2 Part B (2026-11-24)

No version changed, and nothing was added: `packages/core` still depends on `effect` alone, and `apps/engine` on `effect` and the two workspace packages. Read from the installed source of `effect` 4.1.5 and run in the engine's tests.

- `effect/workflow` on `WorkflowEngine.layerMemory` runs the engine's whole test suite: `Workflow.make` and `toLayer`, `execute` with `discard: true` to start a run and return, `poll` to read how it ended, `Activity.make`, `DurableDeferred.await` and `succeed` with `tokenFromExecutionId`, and `DurableClock.sleep`.
- A `DurableClock.sleep` of 60 seconds or less is an ordinary activity that sleeps on `Clock` (`InMemoryThreshold`), so the retry delays of 5 and 30 seconds move with `TestClock.adjust`.
- An activity whose body is interrupted is run again by the activity itself, on a schedule that starts at 400 ms, under the same name and attempt. That is the in-memory stand-in for a Worker killed mid-step.
- An activity's `execute` is an effect built once. Whatever must differ between its first run and a re-run has to be decided when it runs (`Effect.suspend`).
- Completing a `DurableDeferred` a second time does nothing on the in-memory engine: the first result is kept.
- `Effect.updateContext` with `Context.omit` takes services out of the context an effect runs in; `Effect.provideContext` only adds. Together they give a block the services it declared and none of the engine's.
- `Schema.TaggedError<Self, { readonly brand: unique symbol }>()` is what `@effect/tsgo` asks for (`schemaClassMissingBrand`), and a payload field called `name` shadows the error's own (`errorPayloadShadowsName`).
- `@effect/tsgo` reports a missing service as its own error beside TypeScript's, so `@ts-expect-error` alone does not cover a line that is meant not to compile. One comment line with both `@ts-expect-error` and `@effect-diagnostics-next-line missingEffectContext:off` does.
- `@effect/tsgo` warns on every use of `effect/workflow` (`unstableApiUsage`). `allowedUnstableApis` in `tsconfig.base.json` allows it for `apps/engine` only, which is also the only package meant to import it.
- `TestClock.withLive` runs an effect on the real clock inside an `it.effect` test. The workspace's `lib` has no `setTimeout`.

## Verified in M2 Part C (2026-11-25)

Run against the owner's Cloudflare account on a stage that was destroyed afterwards; details in [milestones/m2.md](milestones/m2.md).

- The Worker bundles from this workspace's packages (`workspace:*`, TypeScript sources, JSON recipe files) with `main: import.meta.url` in `apps/engine` and the stack in `infra`. A first deploy of the whole stage takes about 15 seconds, a redeploy about 8.
- The class form `Cloudflare.Worker<Self>()(id, props, init)` takes props as an Effect that needs `Stack` and yields other resources; the plain call form does not. `env` on the props binds plain variables, read at run time from `Cloudflare.WorkerEnvironment`. A resource's props may be an Effect too.
- `@alchemy.run/test/Vitest` works with Vitest 5 on Node: `deploy(Stack)` in `beforeAll`, again inside a test, and `destroy(Stack)` in `afterAll`. Its `executeWhenReady` retries every 404, so it is no use against an API whose own answers include 404.
- The Worker's `access` prop with an email policy and a `non_identity` policy for a `Cloudflare.Access.ServiceToken` works. **Access is not in force the moment it is deployed:** for some seconds after a stage is created, and once seen just after a redeploy, a request reaches the Worker with `ctx.access` undefined.
- `ctx.access.getIdentity()` returns nothing for a service token. Its client id is the `common_name` claim of the `Cf-Access-Jwt-Assertion` header.
- An entity on `DurableObjectSqlClient` keeps a run's log across deploys and a kill; `Schema.Option` and a `Schema.Union` of errors travel through an entity's RPCs.
- `Cloudflare.Telemetry()` records Effect spans of a request only. Spans from the cluster's Durable Objects are recorded once `CloudflareTracer.layer` of `@effect/platform-cloudflare` is provided to the cluster's layer. They are in the `otel` dataset of the Workers Observability query API (`.../workers/observability/telemetry/query`), beside the platform's own (`sqlite`, `d1_run`, `r2_put`).
- `RemovalPolicy.retain` and `forceDestroy` take the stage through `Effect.map(Stack, ...)`. Not yet seen at work: nothing has been deployed to `production`.
- `@effect/tsgo` reported `import.meta.url` as unknown only where it was written inside a resource's props; the same expression in a `const` above it is accepted.
- `alchemy state ls --backend cloudflare` creates the state store if there is none. It is not a read.
- The integration workflow passed in GitHub Actions on the first pull request, in about four minutes, with `CLOUDFLARE_ACCOUNT_ID` and an API token as repository secrets under `CI=true`. The permissions the token is thought to need are in [../infra/README.md](../infra/README.md).

## Not yet verified

- PlanetScale Postgres branching, before the Postgres variant of recipe 4.
- D1's point-in-time restore to a bookmark, which recipe 4's revert step assumes, before M7. Read in M2 Part A: it restores in place through REST or Wrangler, for 30 days on Workers Paid.
- `@distilled.cloud/cloudflare` and the D1 REST calls from inside a Worker, in M2 Part D.
- Why a block's span is missing from Cloudflare's traces for the first step of a run, and cut at 60 seconds with no attributes for a step that ran 90 (M2 gap 16).
- Production's data kept on destroy, in M2 Part E.

## Documentation sources

- Effect: https://effect.website and https://github.com/Effect-TS/effect
- Alchemy: https://alchemy.run and https://alchemy.run/llms.txt
- Foldkit: https://foldkit.dev/llms.txt, https://foldkit.dev/llms-full.txt, https://github.com/foldkit/foldkit
- Cloudflare Artifacts: https://developers.cloudflare.com/artifacts/
- Cloudflare Workers, Durable Objects, D1 and R2: https://developers.cloudflare.com/llms.txt
- `@effect/platform-cloudflare`: its `README.md` and `src/` in `node_modules`, which are ahead of the website
- Oxlint type-aware linting: https://oxc.rs/docs/guide/usage/linter/type-aware.html
