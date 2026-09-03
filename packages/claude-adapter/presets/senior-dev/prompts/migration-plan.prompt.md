# Migration plan

For: a schema or data migration that has to be executed in order.

```markdown
# Migration — <what changes>

## Change and classification
Additive / expand / tightening / destructive / data-only, and why.

## Steps
| # | Step | Statement or job | Lock and duration | Release |
Expand, migrate, switch, contract as separate rows. Mark the release boundary
after which rollback is no longer possible.

## Deploy invariant
What old code does against the new schema, and what new code does against the
old one, at each step.

## Backfill
Batching, resumability, idempotency, throttling, and the query that proves it
finished.

## Rollback
Per step: how it is undone. For the destructive step, name the recovery path
and its data-loss window honestly — `restore from backup` is an answer, with
its cost.

## Verification
The queries that must return zero, the data the migration was rehearsed
against, and the application tests run against both schemas.

## Blast radius
ORM models, generated types, raw SQL, views, triggers, foreign keys, indexes,
replicas, ETL and warehouse consumers, fixtures, backup scripts.
```
