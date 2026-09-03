---
name: legacy-parity
description: Prove that a rewritten, ported, or extracted implementation reproduces the observable behavior of the one it replaces - outputs, ordering, null and empty handling, error type and timing, side effects, formatting and rounding - including the behavior nobody documented. Use for rewrites, ports, service extraction, and any change whose requirement is "same as before".
effort: high
---

## Why this skill exists

Vanilla Claude is likely to:

- compare the two implementations by **reading source**, conclude they do the
  same thing, and miss everything that lives in the gaps between the lines;
- reproduce the legacy's *intent* and lose its **accidents** — the truncation
  instead of rounding, the swallowed exception, the trailing-space trim, the
  ordering nobody specified but three consumers depend on;
- treat the newer, cleaner implementation as correct by construction and the
  legacy's oddities as bugs to fix, silently changing behavior the requirement
  said to preserve;
- validate on invented examples that reproduce its own assumptions rather than
  the system's history;
- decide the tolerance *after* seeing the first mismatch, which is choosing the
  tolerance that makes the comparison pass;
- compare return values only, ignoring side effects, error paths, and timing.

This skill adds: an observable-behavior surface to compare, a tolerance fixed
before comparing, characterization and differential testing, and a triage
classification that forces every difference to be decided rather than absorbed.

**Parity is about observable behavior, never about source similarity.**

## 1. Fix the reference and the tolerance first

Settle three things before running anything — with the user if the requirement
does not answer them:

- **Reference**: which implementation is truth, at which version or commit.
- **Observable surface**: outputs only, or side effects too — persisted rows,
  emitted events, external calls, files, and error behavior. Name what is in.
- **Tolerance**: what counts as equal. Exact bytes? Floating point within an
  epsilon? Set equality ignoring order? Which fields are normalized (generated
  ids, timestamps, hostnames)?

Then write the **allowlist of accepted differences** up front. Anything not on it
is a defect. A tolerance widened after a mismatch is not a tolerance.

## 2. The observable surface

Compare each row that applies; mark the rest `Not applicable`.

| Surface | What silently differs |
| --- | --- |
| inputs accepted | what the legacy tolerated: extra fields, wrong types coerced, whitespace, case |
| defaults | a missing field's substituted value, and whether absent differs from null |
| validation | which inputs are rejected, and at which layer (code vs DB constraint) |
| output values | the numbers themselves |
| output shape | field presence, nesting, `null` vs missing key vs empty string |
| ordering | never specified, always depended on |
| null / empty | empty list vs null vs absent; empty string vs null |
| exception type | callers catch by type; a changed type changes control flow |
| exception timing | fail-fast vs fail-at-commit changes what was already written |
| error message | only when a consumer parses or displays it contractually |
| side effects | which rows are written, in what order, and which are not |
| transaction behavior | what commits together; what survives a partial failure |
| retry / idempotency | whether a repeat produces one effect or two |
| timeouts | the boundary itself is behavior for the caller |
| serialization | date format, number format, precision, encoding, field naming |
| rounding | where it happens, in what order, half-up vs half-even, float vs minor units |
| date / time | timezone, "today", month-end, DST, week numbering |
| state mutation | what the input object looks like afterwards |
| external calls | which are made, how many, with what payload |
| logging | only when something downstream parses it |

## 3. Read the legacy for its accidents

Specifically hunt for: rounding order and mode; money as float vs integer minor
units; locale-dependent formatting and parsing; null/empty/zero conflated;
trimming, case folding, collation, truncation at a fixed width; ordering that
emerges from an index rather than an `ORDER BY`; swallowed exceptions and
defaults substituted on error; values clamped rather than rejected; the order of
side effects and what happens when the third one fails; validation enforced only
by a database constraint; branches that look dead but are reachable with
production data.

Each is a parity question. Write down the answer the legacy gives, then decide —
explicitly — preserve or fix.

## 4. Characterize before you change

When the legacy has no tests, write **characterization tests against the legacy**
first: assertions of what it currently does, right or wrong. They are the
executable specification and the only reviewable definition of "same".

Seed them from real history, not invented examples: production-shaped rows, a
recorded request corpus, the actual file the batch job consumed, the last month
of inputs. Invented fixtures reproduce your assumptions; real ones reproduce the
system's.

## 5. Compare by execution

In order of strength:

1. **Dual-run / shadow.** Execute both on the same input and diff. Strongest as a
   read-only shadow in the real environment; cheapest as a harness over a corpus.
2. **Golden files.** Snapshot legacy output over a corpus; assert the new
   implementation reproduces it.
3. **Differential property testing.** Generate inputs and assert both agree —
   worth it when the input space is large and the function is close to pure.
4. **Reconciliation query.** For data pipelines, compare output tables with
   `EXCEPT ALL` in both directions (see `sql-compare`).

Build the corpus to **break** parity, not to demonstrate it: nulls and missing
fields, empty collections, duplicates, boundary and maximum-precision values,
negative and zero amounts, the largest real record, dates at month/year/DST
boundaries, non-ASCII and mixed-case text, and inputs the legacy **rejects** —
the rejection is behavior too.

## 6. Triage every difference

```text
EQUIVALENT                          identical within the agreed tolerance
EQUIVALENT IMPLEMENTATION DIFFERENCE  internals differ, observable behavior preserved
BEHAVIOR GAP                        observable difference — then classify:
    LEGACY BUG, PRESERVE            consumers depend on it; reproduce it and comment why
    LEGACY BUG, FIX                 explicitly decided; belongs in the report as a change
    NEW BUG                         fix the new implementation
    UNDEFINED, PINNED               legacy was non-deterministic; the new behavior is chosen deliberately
UNKNOWN                             insufficient evidence — no corpus, no reachable environment
```

A difference that cannot be classified is unresolved, not acceptable. `UNKNOWN`
must survive into the report; it is the honest half of the verdict.

## Conclusions this skill must not reach

```text
the code does the same thing   != observable parity
cleaner / newer implementation != equivalent
all tests pass                 != parity (the tests were written for the new code)
same values returned           != parity (side effects and error paths are behavior)
no diff on the happy path      != parity (the corpus decides, and empty corpora prove nothing)
the legacy is obviously wrong  != licence to change it
mismatch is within tolerance   != true when the tolerance was widened to fit it
```

## Stop when

Every surface in scope is compared over a corpus that contains the awkward cases,
and every difference is classified. Uncovered areas are named rather than
implied.

Do not keep enlarging the corpus once new inputs stop producing new difference
classes; do not compare surfaces the consumer cannot observe.

## Report

```text
Reference:   legacy PricingService @ 3f1c9ab      Tolerance: exact on money (minor units),
                                                  ordering ignored, generated ids normalized
Method:      dual-run over 4,812 production-shaped records (2026-06 export)
Matched:     4,796
Differences: 16
  12  rounding: legacy truncates at 2dp, new rounds half-up   LEGACY BUG, PRESERVED
   3  empty address renders "" vs null                        EQUIVALENT IMPL. DIFF (allowlisted)
   1  line-item ordering                                      NEW BUG — fixed, test added
Not covered: refund flow (no legacy fixtures), and any tenant with >500 line items
Verdict:     BEHAVIOR GAP CLOSED for the covered surface; refund flow UNKNOWN
```

Coverage is a fraction of the corpus actually executed, plus a list of what the
corpus did not contain. "Parity verified" without both is not a checkable claim.
