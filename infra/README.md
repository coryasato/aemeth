# infra

The Alchemy stack that declares everything Aemeth deploys. In M2 that is the engine: the Worker, the four Durable Object classes of its cluster, the D1 index with its migrations, the R2 archive, and the Cloudflare Access application in front, with the service token CI calls it by. The web app joins in M3, and the seeded sample database the restore drill runs on later in M2 Part D.

- `alchemy.run.ts`: the stack. The Worker and the resources it binds are declared beside the engine's code, in [`apps/engine/src/cloudflare`](../apps/engine/src/cloudflare); the stack puts them together and returns the Worker's URL and the service token.
- `test/engine.integ.ts`: the integration suite. It deploys the stack to a stage, drives the deployed engine over HTTP, and destroys the stage.
- `vitest.integration.config.ts`: the Vitest project of that suite. It is not part of `bun run test`.

## Stages

One stack, three kinds of stage. Every resource carries its stage in its name.

| Stage | What it is | Durable Objects take new code | Data on destroy | Fixtures |
|---|---|---|---|---|
| `production` | The real one | when idle, within five minutes | kept | no |
| `staging` | What production operates first ([decision 0008](../docs/decisions/0008-out-of-band-path.md)) | when idle, within five minutes | destroyed | no |
| `pr-<number>`, `test_<name>` | Thrown away after a pull request or a test run | at once | destroyed | yes |

A deploy to a stage with any other name is refused: a slip such as `prod` is not a stage.

The fixtures are two fake blocks, a recipe of them (`test-gated`) and two routes under `/test`, which let the integration suite take a run through a gate, a deploy and a kill, and read what the engine keeps outside a run's log. They are in [`apps/engine/src/cloudflare/fixtures.ts`](../apps/engine/src/cloudflare/fixtures.ts).

## Commands

Run from this folder. Alchemy runs under Bun.

| Command | What it does |
|---|---|
| `bunx alchemy plan --stage <stage>` | Shows what a deploy would change. Changes nothing |
| `bunx alchemy deploy --stage <stage>` | Deploys the stage. This is also the out-of-band path of [decision 0008](../docs/decisions/0008-out-of-band-path.md) |
| `bunx alchemy destroy --stage <stage>` | Destroys the stage and, except in `production`, its data |
| `bunx alchemy logs --env-file ../.env --stage <stage>` | The Worker's recent log lines; a defect's cause is written there as text |
| `bun run test:integration` (from the repository root) | Deploys `$ALCHEMY_TEST_STAGE`, or `test_$USER`, runs the suite and destroys the stage: about four minutes. `NO_DESTROY=1` keeps the stage |
| `ALCHEMY_DEV=1 bun run test:integration` | The same suite on local emulators, in about 30 seconds. There is no Access and no deploy that kills a Durable Object locally, so the two tests of those are skipped. It still creates, and deletes, the real service token |

Read from the environment when the stack is deployed, and not in the repository. A `.env` at the repository root holds them for `bun run test:integration`; the Alchemy commands, run from this folder, read it with `--env-file ../.env`:

| Variable | What it is | Without it |
|---|---|---|
| `AEMETH_ACCESS_TEAM` | The Zero Trust team domain, `https://<team>.cloudflareaccess.com`. The engine checks the signature of every Access token against this team's keys, and its issuer, audience and expiry (M2 decision 30) | Nothing is deployed. Under `ALCHEMY_DEV=1` it is not needed |
| `AEMETH_OWNER_EMAIL` | The person Access lets in besides the service token | Only the service token gets through |
| `AEMETH_D1_TOKEN` | The engine's own API token, with `D1 Write` and nothing else, kept as a secret of the Worker. The restore drill's blocks call the D1 API with it. It is not the deploy token ([decision 0008](../docs/decisions/0008-out-of-band-path.md)) | The stage runs no drill: its blocks are refused the D1 service and fail |

## Credentials

- **By hand:** an Alchemy profile (`bunx alchemy profile edit --add Cloudflare`, kept in `~/.alchemy`). The OAuth login must include the **Cloudflare One / Zero Trust** scopes as well as **Developer Platform**: the stack creates an Access application and a service token.
- **In CI:** `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `AEMETH_D1_TOKEN` as repository secrets, and `AEMETH_ACCESS_TEAM` as a repository variable. The token needs, on the account: Workers Scripts Write, D1 Write, Workers R2 Storage Write, Access: Apps and Policies Write, Access: Service Tokens Write, Secrets Store Write (the state store's own secret) and Account Settings Read. The first pull request passed with the owner's token; whether it has exactly these permissions was not checked from here.

Deployment state is kept on the account, in the `alchemy-state-store` Worker, and shared by CI and whoever deploys by hand (M2 decision 6).
