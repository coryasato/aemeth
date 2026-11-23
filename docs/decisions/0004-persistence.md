# 0004: Persistence

Date: 2026-11-23. Status: accepted.

## Decision

- **Run events** live in the run's Durable Object, in SQLite. The event log is append-only and is the source of truth for a run.
- **The index** of recipes, recipe versions and runs lives in D1.
- **The archive** of finished runs lives in R2. When a run reaches a final state, its full event log is written to R2 as one immutable object.
- **Aemeth itself does not use Postgres.**

## Why an archive

The event log is the audit trail and the most valuable data Aemeth holds, and a Durable Object per run is not a backup. The archive gives finished runs a durable copy outside the object that produced them, lets runs be queried and replayed without waking their objects, and gives the restore drill something meaningful to verify: an archived log, replayed through `transition`, must reach the final state the index records.

Runs still in flight exist only in their Durable Object. What Cloudflare offers for recovering that storage is to be confirmed (see [../versions.md](../versions.md)).

## Targets are separate from Aemeth's own data

The database a recipe acts on is a different question:

- The first restore drill targets D1. Export, import and creating a temporary database are HTTP calls a Worker can make.
- The schema migration recipe also targets D1 first, because Aemeth's own index needs migrations. Postgres is a later variant of that recipe, on PlanetScale when deployed and local Postgres in development. Because targets are recipe inputs, the variant is new blocks, not a redesign.

## Why not local Postgres first

A deployed Worker cannot reach a local database, and a Postgres drill needs `pg_dump` and `pg_restore`, which cannot run in a Worker.
