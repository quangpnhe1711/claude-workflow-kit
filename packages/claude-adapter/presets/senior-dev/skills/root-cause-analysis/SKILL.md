---
name: root-cause-analysis
description: Establish a falsifiable causal chain for a defect whose cause is not visible in the code already read - wrong data with no obvious branch, intermittent or environment-dependent failure, a symptom far from its origin, or a fix that did not hold. Not for a defect whose cause you can already point at.
effort: high
---

## Why this skill exists

Vanilla Claude is likely to:

- treat the **exception site** as the cause — the stack trace names where the
  program noticed, which is downstream of where the state went wrong;
- commit to the **first plausible hypothesis** and then read the code looking for
  confirmation of it, never for the evidence that would kill it;
- accept **correlation** ("this changed recently and the bug appeared") as cause;
- **edit code to see if the symptom disappears**, which confirms nothing when two
  hypotheses predict the same disappearance;
- fix the one call site that reproduces and never ask whether the same defect
  class exists at four other call sites;
- declare "fixed" without a check that **failed before** the change.

This skill adds: symptom-boundary framing, first-bad-state tracing, competing
hypotheses with designed falsifiers, a four-level causal vocabulary, defect-class
search, and a stop rule.

## 1. Bound the symptom before explaining it

A cause you cannot bound is a guess. Write down both halves:

```text
FAILS:  order 88123, tenant 4, submitted 2026-08-30 after 23:00 UTC
WORKS:  order 88124, tenant 4, submitted the next morning
```

Then vary one dimension at a time and record which side each case lands on. The
boundary is the diagnosis: the smallest difference that flips the outcome names
the mechanism. "Sometimes wrong" is not an observation — find one failing case
with real values, then find its nearest passing neighbour.

Dimensions worth crossing, in the order they usually pay:

| Dimension | The question it answers |
| --- | --- |
| Input / data | which record property flips it — null, size, unicode, sign, boundary |
| Time | does it fail only across a day/month/DST/year boundary, or under load |
| Environment / config | same code, two environments — diff the config, not the code |
| Version | is there a last-good commit (`git log -S`, `git bisect` if scriptable) |
| Concurrency | does it survive serial execution but not parallel |
| Ordering | does it depend on which request/job arrives first |
| Scale | does it appear only past N rows — that is a different mechanism |

Cheap and decisive: if the failing and passing cases differ in exactly one field,
you have the trigger before reading any code.

## 2. Find the first incorrect observable state

Do not read the flow forward from the entry point. Walk **backwards** from where
the wrong value is observed, asking one question at each hop:

> Is the value already wrong *here*?

```text
response / UI        wrong  -> keep going back
serializer / DTO     wrong  -> keep going back
service / domain     correct        <- the divergence is in this gap
repository / query
database / state
```

The boundary where correct becomes wrong is the **divergence point**. This
terminates, unlike forward reading, and it survives a call graph you do not
already understand.

When the flow is not a call stack — a job, an event chain, a batch — the same
move applies to persisted state: find the earliest stored record that is already
wrong, and the writer of that record is the divergence point.

If the value is wrong at the very first place it exists, the cause is in the
input or in the construction, not in the pipeline.

## 3. Compete hypotheses; design falsifiers

At the divergence point, write **at least two** mechanisms that would produce
what you observed. One hypothesis is not an analysis, it is a preference.

For each, state the *discriminating prediction* — something that must be true if
this hypothesis holds and false if the other does:

```text
H1  the discount is applied after the DTO is built
    predicts: the persisted row is correct, only the response is wrong
H2  the discount is never applied for this tenant's plan
    predicts: the persisted row is wrong too

Discriminator: read the stored row for order 88123.  (one query, no code change)
```

Rules:

- Prefer the **cheapest falsifier**, not the most thorough one. A log line, a
  query, or a unit test on the suspect function usually separates hypotheses
  faster than reading three more files.
- Do not modify product code to discriminate while a read-only check can do it.
  An edit that makes the symptom vanish is consistent with several hypotheses and
  proves none of them.
- A hypothesis that predicts nothing you can check is not a hypothesis. Either
  find a consequence or drop it.
- Record the hypotheses you **eliminated** and what killed them. That is what
  makes the surviving one credible, and it is what the reviewer needs.

## 4. Name the four levels separately

| Level | Definition | Test |
| --- | --- | --- |
| `SYMPTOM` | what the user or monitor observed | would the reporter recognise this sentence? |
| `PROXIMATE FAILURE` | where the program noticed — throw site, failed assertion, wrong render | is this merely *detecting* bad state that arrived from elsewhere? |
| `ROOT CAUSE` | the decision or omission that makes the wrong state inevitable given the inputs | does removing exactly this make the failure impossible? |
| `CONTRIBUTING CONDITION` | what made it reachable, frequent, or invisible: a missing constraint, a swallowed exception, a default that hides the gap, a test asserting the wrong behavior | would fixing only this hide the defect rather than remove it? |

A root-cause claim must answer all three:

1. **why** the failure occurs — the mechanism, not the location;
2. **why under these conditions** — why the passing neighbour passes;
3. **why the fix prevents recurrence** — and what it does not prevent.

If you cannot answer (2), you have a location, not a cause.

## 5. Mechanisms worth checking explicitly

Ordering (value read before its input is ready), shared mutable state, stale
cache or memoization, missing await / lost promise / fire-and-forget, transaction
boundary (read outside the write's transaction; side effect not covered by the
rollback), lost update between two writers, non-idempotent retry, partial failure
leaving inconsistent state, null-vs-absent-vs-empty conflated, integer division
and rounding, timezone and DST, locale-dependent parsing or collation, off-by-one
on ranges and pagination, unstable sort under ties, resource exhaustion (pool,
file handle, thread) presenting as a timeout, a dependency version difference
between environments, a config default that only one environment overrides.

## 6. Ask whether the defect is a class

Before fixing, search for the same mechanism elsewhere: other callers of the same
function, other places constructing the same DTO, sibling handlers copied from
this one, the same query pattern in a second module.

Report what you find even when it is out of scope. A cause with four call sites
is an `impact-analysis` question, not four independent patches — and fixing one
while the others remain is a defect that reappears next week.

## 7. Prove the fix

- Write the failing check **before** the fix when the repro is automatable. It
  proves the causal claim and becomes the regression guard.
- Find **existing tests that encode the bug** — a test asserting the wrong
  behavior must be corrected deliberately, never deleted quietly.
- Verify against the *boundary*, not only the reported case: the failing case now
  passes **and** the passing neighbour still passes.
- Fix the cause. Patch a symptom only when the symptom *is* the cause, or the
  user accepted a stopgap — and say which.

## Conclusions this skill must not reach

```text
the exception site         != the root cause
"changed recently"         != caused by that change
"symptom disappeared"      != hypothesis confirmed (several fixes predict that)
one reproducing call site  != the only site with this defect
tests pass now             != the cause is gone (they may never have covered it)
"cannot reproduce"         != not a bug
plausible mechanism        != evidenced mechanism
```

When reproduction is impossible, say `NOT_REPRODUCED` and continue on
deterministic evidence only — a code path that provably produces the value, a
stored row that only one branch could have written. Never imply runtime
confirmation you do not have.

## Stop when

One causal explanation accounts for the symptom **and** for the passing
neighbour, every competing hypothesis that materially changes the fix has been
eliminated or explicitly recorded as unresolved, and you know which check will
fail before the fix and pass after it.

Do not keep reading for a more elegant explanation once the surviving hypothesis
determines the same change.

## Report

```text
Symptom:      totals shown pre-discount on the order confirmation (order 88123)
Boundary:     fails whenever a discount applies; identical order without one is correct
Divergence:   OrderDto built in OrderController.confirm:88, before
              DiscountService.apply mutates the order — persisted row is correct
Eliminated:   "discount not applied for this plan" — the stored row has it
Root cause:   DTO construction is ordered before the mutation that it reads
Contributing: no test covers confirm() with a discount
Fix:          build the DTO after apply; failing test added first (order-confirm.test.ts)
Defect class: OrderExportJob builds the same DTO at the same point — reported, out of scope
```
