---
name: performance-investigation
description: Find why something is slow by measuring it - define the metric and percentile, baseline it, locate the dominant cost, change one variable, remeasure, and check correctness - instead of optimizing by inspection. Use for a slow endpoint, query, job, build, or page, and whenever an optimization is proposed with no measurement behind it.
effort: medium
---

## Why this skill exists

Vanilla Claude is likely to:

- optimize by **reading**: spot a loop, add a cache, call it faster, with no
  before/after number;
- improve **average** latency while making p95/p99 worse — batching, added
  serialization, a shared lock — and never notice, because the mean moved;
- measure on development-scale data, where the N+1 with 20 rows costs nothing and
  the missing index is invisible;
- attack the cost it can see rather than the **dominant** one, spending effort on
  8% of the total;
- change three things at once, then be unable to say which helped;
- add a cache without answering what invalidates it, turning a latency fix into a
  correctness bug;
- report "much faster" with no workload, no percentile, and no repetition.

This skill adds: an explicit metric and target, a reproducible baseline,
bottleneck classes with the evidence that identifies each, the one-variable rule,
and a correctness check on every optimization.

## 1. Define the metric before touching anything

"Slow" is not actionable. Fix all four:

- **What**: one endpoint, query, job, page, or build step.
- **Which metric**: latency, throughput, resource utilization, tail latency, or
  cost. They trade against each other — a batch that triples throughput can
  double p99.
- **Which percentile**: p50 and p99 are different problems with different causes.
  p50 is usually algorithmic or I/O volume; p99 is usually contention, queueing,
  GC, retries, or a cold path.
- **At what scale**: rows, concurrency, payload size. Most performance defects
  are invisible at dev scale and obvious at production scale.
- **Target**: the number that means done. Without it the work has no stop
  condition.

## 2. Baseline, reproducibly

Measure before changing anything, on production-shaped data. A 20-row table hides
every N+1 and every missing index.

Honest measurement: warm up first (JIT, connection pool, cache), repeat and
report the distribution rather than one run, hold the environment fixed, measure
the same thing each time, and note what you could not control. A single run is an
anecdote.

Cheap and usually decisive: time the operation end to end, then time the suspected
span inside it. If those two numbers are close, the suspect is the cost; if not,
you were looking at the wrong thing.

## 3. Locate the dominant cost — with evidence, not intuition

Use the tool that reports where time goes: a profiler, framework request timing,
`EXPLAIN ANALYZE` (the *actual* rows and time, not the estimate), the browser
performance panel, build tracing. With none available, bisect by timing spans.

Then answer one question: **what fraction of the total is the largest single
cost?** Until that changes, optimizing anything else is wasted.

| Class | Evidence that identifies it |
| --- | --- |
| N+1 / query count | query count scales with result size — count queries per request |
| missing or unused index | `EXPLAIN` shows a sequential scan, or an index the predicate cannot use (function or cast on the column, leading wildcard, type mismatch) |
| over-fetching | selecting every column and relation to use two fields; counting all rows on every page; loading a table to filter in code |
| algorithmic complexity | time grows super-linearly with input; nested scan over two collections |
| serialization | large payload, deep object graph; time concentrated in encode/decode |
| network / external dependency | wall time dominated by waiting; latency tracks the dependency's own latency |
| serial I/O | independent calls awaited one at a time — total ≈ sum, not max |
| locking / contention | p99 ≫ p50 under concurrency; fine single-threaded |
| connection or thread-pool starvation | latency rises with load while CPU stays low; queue wait in the pool metrics |
| CPU | profiler shows compute at the top; utilization near saturation |
| allocation / GC | high allocation rate; pauses correlate with the tail |
| caching | miss rate high, or the key includes something volatile so it never hits |
| cold start | first request slow, subsequent fast — a different problem entirely |
| large payload | response size, not compute, dominates; compression absent |

Note that several classes present as "the database is slow". Query count, plan
shape, and pool wait distinguish them.

## 4. Change one material variable, then remeasure

One change at a time; remeasure between changes. Two simultaneous fixes make the
measurement uninterpretable and hide a regression.

Preference order: **do less work** (fewer rows, fewer round trips, fewer calls) →
**do it once** (batch, prefetch, cache, memoize) → **do it faster** (better
algorithm, then constant factors). Micro-optimization is last and usually costs
more readability than it buys.

Every cache is a correctness question: what invalidates it, what is stale in the
meantime, who else writes the underlying data, and what happens on a stampede. If
those have no answer, the cache is a defect in waiting.

## 5. Check correctness, every time

A performance fix that changes results is a defect with a good benchmark. After
each change: the affected tests pass; the output is identical on a fixture set
(byte-identical where feasible); ordering is unchanged unless deliberately
changed; and the tail did not get worse while the mean improved.

## Conclusions this skill must not reach

```text
faster on my machine         != faster in production (data volume, concurrency, network)
mean improved                != p95/p99 improved
this loop looks expensive    != this loop is the dominant cost
fewer lines / cleaner        != faster
added a cache                != correct (invalidation is unproven until stated)
query is faster              != request is faster (it may be 8% of the total)
lower plan cost estimate     != lower actual time (compare EXPLAIN ANALYZE actuals)
one run was faster           != a real difference (variance, warm-up, noise)
```

## Stop when

The target metric is met at the stated percentile and scale, **or** the evidence
shows the suspected bottleneck is not material — in which case say so and stop
rather than optimizing something else opportunistically.

Continuing past the target trades maintainability for a number nobody needs.

## Report

```text
GET /orders?status=open   p95, 5k-order tenant, 20 runs after warm-up, target <200ms

before  1,840 ms   142 queries   dominant cost: N+1 on order.customer (78% of wall time)
after      96 ms     3 queries   batched customer load

p50    1,510 -> 74 ms      p99   2,240 -> 130 ms      (tail improved, not traded away)
Correctness: order-list tests pass; response body byte-identical on the fixture set.
Not measured: behavior under concurrency — single-client benchmark only.
```
