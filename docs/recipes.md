# Recipes

Six recipes drive the design. All six are written as recipe documents in milestone 1 so the recipe format is tested against more than one shape. They are built in this order, each adding primitives the earlier ones lack.

| # | Recipe | Primitives it adds | Kind of target | Aemeth target |
|---|---|---|---|---|
| 1 | Restore drill | Sequence, data passing between blocks, undo, always-run steps, checks | D1 | Aemeth's D1 index |
| 2 | Environment cleanup | Approval gate, destructive action, for-each over a list | Alchemy stacks | Aemeth's per-PR preview stacks |
| 3 | Gradual release | Production write with a clean undo, staged checks | Workers | Deploying Aemeth |
| 4 | Schema migration | Steps that cannot be undone | D1 first, Postgres later | Schema changes to Aemeth's D1 index |
| 5 | Secret rotation | Fan-out with partial failure | Secrets and their consumers | Aemeth's API tokens |
| 6 | Artifacts pipeline | Long waits on outside work, a non-infrastructure target | Cloudflare Artifacts | Changes to Aemeth's code |

Aemeth is its own first workload ([decision 0001](decisions/0001-product-scope.md)). Blocks still take their targets as recipe inputs, so the same recipes work on anything else.

Recipe 4 targets D1 first, because Aemeth's own index needs schema changes as it grows. A Postgres variant on PlanetScale follows as new blocks ([decision 0004](decisions/0004-persistence.md)).

## 1. Restore drill

Proves that a backup can be restored. Production is only read.

1. Export the production database.
2. Create a temporary database.
3. Restore the export into it.
4. Check that row counts and checksums match.
5. Destroy the temporary database. Always runs.
6. Record the result. Always runs.

Invariants:
- Production is never written.
- The temporary database is destroyed in every final state.
- A successful run always has matching checksums.

When the target is Aemeth itself, the drill adds a check on the run archive: a sample of archived event logs is replayed through `transition`, and each must reach the final state the index records.

## 2. Environment cleanup

Removes stale preview stacks and orphaned resources.

1. List preview stacks older than a threshold, and resources with no owning stack.
2. Approval gate showing exactly what will be destroyed.
3. Destroy each approved item.
4. Record what was destroyed and what failed.

Invariants:
- Nothing is destroyed that was not shown at the gate.
- No stack outside the preview stages is ever destroyed.

## 3. Gradual release

Promotes a new version to production in stages.

1. Plan the changes.
2. Approval gate showing the plan.
3. Shift a share of traffic to the new version.
4. Check error rates. Repeat steps 3 and 4 up to full traffic.
5. On a failed check, roll back to the previous version.
6. Record the result. Always runs.

Invariants:
- Nothing writes to production before an approval.
- A failed check always ends with the previous version serving all traffic.

## 4. Schema migration

Applies a database migration safely.

1. Create a copy of the database: a temporary database restored from an export on D1, or a branch on PlanetScale.
2. Apply the migration to the copy.
3. Check the copy.
4. Approval gate. Steps marked as not undoable are called out.
5. Apply to production.
6. Smoke test. On failure, revert where possible.

Invariants:
- A step that cannot be undone never runs before an approval.
- The copy is removed in every final state.

On D1 the first three steps reuse the restore drill's blocks.

## 5. Secret rotation

Replaces a credential everywhere it is used.

1. Create the new credential.
2. Deploy it to each consumer.
3. Check each consumer works with it.
4. Approval gate before revoking.
5. Revoke the old credential.

Invariants:
- The old credential is never revoked while any consumer still uses it.
- A partial failure leaves every consumer on a working credential.

## 6. Artifacts pipeline

A change pipeline for agent-written code on Cloudflare Artifacts, which provides Git-compatible repositories without review, checks or a merge gate.

1. Fork the repository for one task.
2. Issue a short-lived, scoped token.
3. Wait for the work to be pushed.
4. Run checks.
5. Approval gate, by a person or a policy.
6. Merge and record.

Status: an idea, not yet scheduled. Known limits as of 2026-11-23:
- Artifacts push events are announced but not available, so the engine must drive each step.
- Aemeth can record what it brokers (forks, tokens, pushes, checks, merges), not what an agent does inside its own session.
- Aemeth is not an agent factory and will not become one. This recipe covers the pipeline around the repository only.
