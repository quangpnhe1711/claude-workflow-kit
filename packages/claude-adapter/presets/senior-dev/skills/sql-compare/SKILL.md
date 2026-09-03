---
name: sql-compare
description: Decide whether two SQL statements return the same multiset of rows for every legal input, and characterize every difference that remains - projection, join semantics, NULL logic, aggregation fan-out, ordering and pagination, parameter binding, and vendor dialect. Use when rewriting, optimizing, porting, or migrating a query, or when a legacy query and its replacement must agree.
effort: high
---

## Why this skill exists

Vanilla Claude is likely to:

- compare two queries **structurally**, see the same tables and columns, and call
  them equivalent;
- miss that a predicate on the nullable side of a `LEFT JOIN` in the `WHERE`
  clause silently turns it into an `INNER JOIN` and drops unmatched rows;
- miss that `NOT IN (subquery)` returns **zero rows** when the subquery yields a
  single NULL, while `NOT EXISTS` does not;
- miss fan-out: joining to a one-to-many table before aggregating multiplies the
  rows being summed, so `SUM` doubles while `COUNT(*)` looks plausible;
- accept "same row count on my sample" as proof, when the difference is duplicate
  multiplicity, NULL handling, or ordering under ties;
- treat `UNION` and `UNION ALL` as interchangeable, and `COUNT(*)` as
  interchangeable with `COUNT(col)`;
- verify against data that contains none of the cases that break it.

This skill adds: a normalization step that makes real differences visible, a
semantic checklist ordered by how often each item silently changes results,
counterexample construction, and executable proof strategies.

Work through the sections and record each item as `SAME`,
`DIFFERENT (<consequence>)`, or `UNKNOWN (<what would settle it>)`. Skip a
section that cannot apply and say so.

## 1. Normalize before comparing

Rewrite both statements into one shape so that only real differences remain:

- expand `SELECT *` to the actual column list from the schema;
- qualify every column with its table; resolve aliases to base tables;
- rewrite implicit joins (`FROM a, b WHERE a.id = b.a_id`) as explicit `JOIN`;
- inline or name CTEs and subqueries consistently;
- resolve `USING (x)` to `ON a.x = b.x` — and note that `USING` collapses the two
  columns into one in the projection;
- normalize literal formatting, keyword case, whitespace.

Do not "simplify" while normalizing. Preserve parentheses exactly:
`a AND b OR c` is not `a AND (b OR c)`, and rewriting `NOT (x AND y)` needs
De Morgan **plus** the three-valued-logic check below.

## 2. Projection

Same columns, same order, same names? A renamed alias breaks consumers reading by
name; a reordered projection breaks consumers reading by index.

Types after expression changes: `SUM(int)` vs `SUM(numeric)`, `COUNT(*)` (never
NULL, bigint) vs `COUNT(col)` (skips NULLs) vs `COUNT(DISTINCT col)`, integer
division vs decimal division, implicit cast in concatenation, numeric precision
and scale after arithmetic — a `numeric(10,2)` sum and a float sum differ at the
cent, which matters for money.

`DISTINCT` present on one side only: decide whether the join shape made it
unnecessary, or whether it was masking duplicates the other side will now emit.

## 3. Join semantics — the highest-yield section

- **Join type.** `INNER` vs `LEFT` changes row count whenever the right side is
  missing.
- **Outer join defeated by WHERE.** `LEFT JOIN r ... WHERE r.status = 'x'` is an
  inner join: the predicate rejects the NULL-extended rows. To stay outer it must
  move into `ON`, or be written `WHERE r.status = 'x' OR r.id IS NULL`. For inner
  joins, `ON` and `WHERE` placement is equivalent — the asymmetry is the trap.
- **Cardinality / fan-out.** A join to a one-to-many table multiplies rows. Check
  whether one query de-duplicates (`DISTINCT`, `GROUP BY`, `DISTINCT ON`, a
  `LIMIT 1` correlated subquery, a window function) while the other assumes
  uniqueness. Verify uniqueness against the schema's keys, never against sample
  data.
- **`EXISTS` vs `IN` vs `JOIN`.** `EXISTS` and `IN` are semi-joins and do not
  multiply rows; `JOIN` does. `NOT IN` with any NULL in the subquery returns no
  rows at all; `NOT EXISTS` does not. This is a defect, not a nuance.
- **Semi/anti-join rewrites** must preserve "at least one" vs "exactly one".
- **Self-joins and non-equi joins** change cardinality in ways the schema's keys
  do not constrain.

## 4. Predicates and NULL (three-valued logic)

- `NULL = NULL` is unknown; `WHERE x <> 'a'` excludes rows where `x IS NULL`;
  `NOT (x > 5)` is not `x <= 5` for nullable `x`.
- `IS NULL` / `IS NOT NULL` / `IS DISTINCT FROM` are the only NULL-safe
  comparisons; `= NULL` never matches.
- An `OR` chain rewritten to `IN`, or `IN` rewritten to a join, must preserve NULL
  behavior and multiplicity.
- `COALESCE` added or removed changes which rows match **and** what aggregates
  count.
- Ranges: `BETWEEN` is inclusive both ends; `col <= '2026-08-31'` on a
  *timestamp* column excludes almost the whole last day — use `< next_day`.
- Type coercion in comparisons: string↔number, timestamp↔date, `CHAR` trailing
  spaces vs `VARCHAR`, implicit casts that disable an index.
- Collation and case sensitivity: `'A' = 'a'` is true in some collations. Same
  for accent sensitivity and `LIKE` behavior.
- Timezone: `AT TIME ZONE`, session timezone, `NOW()` vs `CURRENT_DATE`, and
  whether both queries bucket a day in the same zone. A report that shifts by one
  day at midnight is this.

## 5. Aggregation and grouping

- Same `GROUP BY` key set? An extra key splits groups, a missing one merges them.
- `SUM` over no rows is NULL, not 0 — check whether one side wraps it in
  `COALESCE`. `COUNT` over no rows is 0. A `GROUP BY` with no matching rows
  returns **no row**, while a bare aggregate returns **one row** with NULL.
- `HAVING` vs `WHERE`: moving a predicate across the aggregation changes the
  aggregate's inputs.
- Grouping before vs after a join changes what is aggregated — the fan-out
  double-count.
- `AVG` ignores NULLs; `SUM(x)/COUNT(*)` does not. `MIN`/`MAX` over an empty set
  are NULL.
- Window functions: same `PARTITION BY`, same `ORDER BY`, **same frame**. The
  default frame `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` differs from
  `ROWS ...` whenever the order key has ties. `ROW_NUMBER`, `RANK` and
  `DENSE_RANK` differ exactly on ties.
- `GROUPING SETS` / `ROLLUP` emit extra rows with NULL keys.

## 6. Set operations, CTEs, subqueries

- `UNION` de-duplicates; `UNION ALL` does not. Swapping them changes both the row
  count and the cost.
- `EXCEPT` / `INTERSECT` de-duplicate; the `ALL` forms preserve multiplicity.
- A CTE may be an optimization fence or may be inlined depending on vendor and
  version; that is a performance difference, not a correctness one — unless the
  CTE is `WITH RECURSIVE`, or is referenced twice and contains a volatile
  function (`now()`, `random()`, a sequence), in which case inlining changes
  results.
- Correlated subquery vs join: the subquery returns one value and errors or takes
  an arbitrary row when it returns several, depending on vendor.
- Scalar subquery over no rows yields NULL, not zero rows.

## 7. Ordering, limits, pagination

- Ordering differences only matter to the consumer — until they meet `LIMIT`.
  Without a **total** order, `LIMIT` picks arbitrarily among ties, so two
  "equivalent" paginated queries return different pages. A tie-break on a unique
  column is what makes pagination reproducible.
- NULL ordering defaults differ by vendor (`NULLS FIRST` / `NULLS LAST`).
- `OFFSET` pagination and keyset pagination diverge under concurrent writes.
- `ORDER BY` inside a subquery or view is not guaranteed to survive.

## 8. Parameters and binding

Same count, order, and types. A positional rewrite that reorders `$1`/`?` is a
runtime defect the SQL text hides. Check: a parameter used twice on one side and
once on the other; list parameters (`IN (?)` expanded by the driver vs
`= ANY($1)`); **empty-list behavior** — `IN ()` is a syntax error in most vendors,
so the code that builds the query must handle it identically on both sides. Any
string interpolation into the SQL is a defect to report regardless of
equivalence.

## 9. Dialect, when the two targets differ

Identifier quoting and case folding; `LIMIT/OFFSET` vs `TOP` vs `FETCH FIRST`;
concatenation (`||` vs `+` vs `CONCAT`, and whether NULL poisons the result);
`ISNULL`/`NVL`/`IFNULL` vs `COALESCE`; date arithmetic and truncation; integer
division; boolean vs 0/1; empty string treated as NULL (Oracle); MySQL without
`ONLY_FULL_GROUP_BY` permitting unaggregated columns and returning an arbitrary
row; default collation; `MERGE`/upsert semantics; and whether the isolation level
makes a read-committed query see a different snapshot mid-statement.

## 10. Prove it — reasoning finds candidates, execution settles them

**Counterexample construction.** For each suspected difference, build the
smallest row set that makes the two queries disagree, and say so concretely:

```text
H: WHERE p.status='paid' defeats the LEFT JOIN
Counterexample: one order with no payments row
  old -> 1 row (payment columns NULL)   new -> 0 rows
```

A named counterexample is stronger than any amount of prose, and it doubles as
the fixture.

**Minimal fixture.** Seed exactly the awkward cases and run both: NULL in a join
key, a duplicate child row, an empty child set, a boundary date at midnight and
at month end, the empty parameter list, maximum precision values, negative and
zero amounts, a tie in the `ORDER BY` key, a unicode/case-varying string.

**Bidirectional set difference** on real data:

```sql
(SELECT ... FROM a_query EXCEPT ALL SELECT ... FROM b_query)
UNION ALL
(SELECT ... FROM b_query EXCEPT ALL SELECT ... FROM a_query);
```

`EXCEPT ALL` (or `MINUS`) preserves multiplicity and therefore catches duplicate
differences that `EXCEPT` hides. Both directions are required: one direction only
proves containment.

**Cheap pre-passes:** `COUNT(*)`, `COUNT(DISTINCT pk)` (the gap between them is
fan-out), per-column `SUM`/`MIN`/`MAX` cross-checks, and a count of NULLs per
column.

Compare execution plans only for a performance question. A plan difference is
never a correctness difference.

## Conclusions this skill must not reach

```text
same tables and columns   != equivalent
same row count            != same rows
same rows on sample data  != equivalent (the sample may lack NULLs and duplicates)
EXCEPT returned nothing   != equivalent (use EXCEPT ALL, and both directions)
tests pass                != equivalent (tests encode the old query's assumptions)
"the rewrite is cleaner"  != equivalent
same plan cost            != same result
```

## Stop when

Equivalence or non-equivalence is established for the semantics the caller
actually depends on, and every remaining difference is classified with its
consequence. Formatting, alias naming, join order, CTE-vs-subquery structure and
plan shape are out of scope unless the consumer observes them.

## Report

```text
Verdict: NOT EQUIVALENT   (verified by EXCEPT ALL both directions, staging 2026-08-30)

1. LEFT JOIN payments + WHERE p.status='paid' drops unpaid orders.
   Counterexample: order with no payment row -> old 1 row, new 0.   143 rows lost.  HIGH
2. SUM(amount) is NULL for empty groups; the old query wrapped it in COALESCE(...,0).
   Report renders blank instead of 0.                                              MEDIUM
3. ORDER BY created_at is not a total order; with LIMIT 50 page contents vary
   between runs. Tie-break on id required.                                         MEDIUM
4. UNKNOWN: session timezone on the reporting connection was not verified;
   day bucketing may shift by one day.
```

Never report `EQUIVALENT` from reading alone when data was reachable and the
comparison was not run. Say `EQUIVALENT BY ANALYSIS — not executed` and name what
would confirm it.
