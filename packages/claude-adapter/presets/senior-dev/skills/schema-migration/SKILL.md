---
name: schema-migration
description: Plan and verify a schema or data migration that survives a mixed-version deployment - compatibility in both directions, expand/contract sequencing, locking behavior on a large table, idempotent restartable backfill, the irreversible step, and data invariants that prove the result. Use whenever a change touches DDL or rewrites existing rows.
effort: high
---

## Why this skill exists

Vanilla Claude is likely to:

- write the migration and a `down()` and call that a rollback plan — while the
  `down()` for a dropped column cannot restore the data;
- forget that **both application versions run against one database** during a
  deploy, and produce a step where the old code breaks on the new schema;
- add a `NOT NULL` column with a default, or a unique constraint, in one
  statement — instant on one engine, a locking full-table rewrite on another;
- write a single-statement `UPDATE` over millions of rows: one transaction, held
  locks, bloated log, and no way to resume after it is killed;
- backfill and then switch reads, missing the rows written *during* the backfill;
- verify by "the migration ran without error", which says nothing about whether
  the data is correct;
- treat the destructive step as reversible because the code that used the column
  can be reverted.

This skill adds: a classification that dictates sequencing, an explicit
two-direction compatibility matrix, locking analysis before writing DDL, backfill
properties, a named point of no return, and proof by data invariant.

## 1. Classify — the class dictates the sequence

| Class | Examples | Shape |
| --- | --- | --- |
| **Additive** | nullable column, new table, new index | one step |
| **Expand** | new column that will replace an old one | expand → migrate → switch → contract |
| **Tightening** | `NOT NULL`, unique/FK constraint, narrower type | only after the data already complies |
| **Destructive** | drop column/table, rename, precision-losing type change | never in one step; has a point of no return |
| **Data-only** | backfill, correction, reshaping | separate deployment from DDL |

Anything past additive uses expand / migrate / contract, in **separate
deployments**:

```text
1. expand    add the new shape; dual-write; read the old
2. migrate   backfill in batches; verify with invariant queries
3. switch    read the new shape; keep writing both
4. contract  stop writing the old; drop it — a later release, once rollback
             past step 3 is no longer wanted
```

A rename is expand/contract, never `ALTER ... RENAME` on a live table: the rename
breaks every running instance of the old code at once.

## 2. The deploy invariant — state it in both directions

At every instant during rollout, old and new application code may both be running
against the same database. For each step, answer both:

```text
old code + new schema  ->  works?  why?
new code + old schema  ->  works?  why?
```

The migration is correct only if both hold at every step, or the deploy is
explicitly ordered and gated and you say so. This is what makes "add the column
`NOT NULL` with a default" a bad first step (old inserts omit it and fail on some
engines; the rewrite locks the table) and "add nullable, backfill, then tighten"
a good one.

Also state, when they exist: the ORM's cached schema or generated model (a stale
model selecting a dropped column breaks old pods), connection pools holding
prepared statements against the old shape, and replicas that apply DDL with lag.

## 3. Establish locking behavior before writing the DDL

The same statement is metadata-only on one engine and a full rewrite on another,
and a rewrite on a large hot table is an outage. For the **target engine and
version**, establish:

- which `ALTER` forms rewrite the table or take an exclusive lock;
- whether index creation can be built online/concurrently, what that costs, and
  what happens if it fails (an invalid index left behind);
- whether adding a constraint validates existing rows under a lock, and whether
  it can be added unvalidated and validated separately;
- the **lock queue**: a blocked DDL statement blocks every query queued behind
  it, so a "short" lock on a busy table is not short;
- whether the migration runner sets `lock_timeout` / `statement_timeout` — and
  set them, so a blocked migration fails fast instead of stalling the service.

State what you established for this engine. If it cannot be established, say so
and treat the statement as blocking.

## 4. Backfill: batched, idempotent, restartable

Never one `UPDATE` over a large table. Required properties:

- **batched** by primary-key range, bounded size, committed per batch;
- **idempotent** — re-running a batch must not double-apply (write the derived
  value, do not increment; guard with `WHERE new_col IS NULL` or a version
  marker);
- **restartable** — progress recorded, so a killed job resumes where it stopped;
- **throttled** — pauses on replication lag or lock waits;
- **complete under concurrency** — rows written *during* the backfill must be
  covered, either by the application's dual-write or by a final sweep of rows
  modified after the job started;
- **verifiable** — a query that counts remaining work and must reach zero.

Decide explicitly what happens to rows that cannot be converted: skipped and
reported, or the migration stops. Silently leaving them is the worst option.

## 5. Name the irreversible step

For each step write the rollback:

- **Additive** — revert the code; the column stays. Harmless.
- **Expand / migrate** — revert the code; the new column goes stale. Say whether
  re-running the backfill repairs it.
- **Switch** — revert the code; the old column is still written, so it is safe.
  This is the last cheaply reversible point.
- **Contract / destructive** — **no rollback.** The recovery path is a restore or
  a re-derivation. Name it, name its data-loss window, and mark the step:

```text
POINT OF NO RETURN: step 4 (DROP COLUMN orders.total)
Recovery: restore from the nightly snapshot; up to 24h of writes lost.
```

If the honest recovery is "restore from backup", check that a restore is actually
practiced, and treat the step as a decision for the user (`deep-change`).

## 6. Prove it with data invariants, not with exit codes

Before contract, and before calling the migration done:

```sql
-- nothing left to backfill
SELECT count(*) FROM t WHERE new_col IS NULL AND <needs backfill>;
-- old and new agree, NULL-safely
SELECT count(*) FROM t WHERE new_col IS DISTINCT FROM <expression over old cols>;
-- the constraint about to be added would hold
SELECT count(*) FROM t WHERE NOT (<constraint>) OR <constraint> IS NULL;
-- no row was damaged: aggregate cross-check
SELECT sum(old_col), sum(new_col_converted) FROM t;
```

Each must return the expected value, and each belongs in the report. Also verify:
the migration runs against a **production-shaped** copy, not an empty test
schema; it is re-runnable; row counts before/after match the prediction; and the
application test suite passes against **both** the pre- and post-migration schema
for every step where both must work.

## 7. The rest of the blast radius

ORM models and generated types; raw SQL and reporting queries; views, triggers,
functions, materialized views; indexes the new predicate needs and old indexes
now dead; foreign keys in both directions; replicas, CDC/ETL consumers and
warehouse schemas; fixtures and seed data; backup/restore scripts that enumerate
columns; database-level permissions on the new object.

## Conclusions this skill must not reach

```text
the migration ran without error   != the data is correct
down() exists                     != rollback is possible
it is fast on my dev database     != it is fast on 40M production rows
the new column is populated       != rows written during the backfill are covered
tests pass on the new schema      != old code survives the new schema
the constraint was added          != the pre-existing rows comply (validate separately)
adding a column is always safe    != true with NOT NULL, a volatile default, or an engine that rewrites
```

## Stop when

Every step has: a stated class, both directions of the deploy invariant, its
locking behavior, its rollback (or an explicit point of no return), and the query
that proves it. That is the plan.

Do not design for schema changes the requirement does not ask for, and do not
keep exploring alternative shapes once one satisfies the invariant safely.

## Report

Use `.claude/prompts/migration-plan.prompt.md` when a document is requested.
Otherwise:

```text
orders.total_cents replaces orders.total (float -> bigint minor units), 40M rows

1 (this PR)  add total_cents nullable + dual-write   metadata-only lock; safe
2            backfill 10k batches, resumable, ~25min; guarded WHERE total_cents IS NULL
3            switch reads; keep dual-write           last reversible point
4 (later)    drop orders.total                       POINT OF NO RETURN — restore only, 24h window

Invariant proof (on 2026-08 snapshot):
  remaining NULLs                          0
  round(total*100) IS DISTINCT FROM cents  0 rows
  sum(total)*100 = sum(total_cents)        matched
Both directions: old code ignores total_cents; new code falls back to total until step 3.
```
