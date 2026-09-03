# Parity report

For: the result of comparing two implementations or two queries — a rewrite
against its legacy, or a rewritten query against the original.

```markdown
# Parity — <A> vs <B>

## Reference and tolerance
Which side is the source of truth, at which version. What counts as equal
(exact, rounding tolerance, ordering ignored, normalized fields), agreed before
comparing.

## Method
How equivalence was checked: dual-run over a corpus, golden files, set
difference in both directions, static analysis only. Corpus size and where it
came from.

## Verdict
`EQUIVALENT`, `EQUIVALENT BY ANALYSIS — not executed`, or `NOT EQUIVALENT`.

## Differences
| # | Difference | Evidence | Classification | Consequence |
Classification is `LEGACY BUG, PRESERVED`, `LEGACY BUG, FIXED`, `NEW BUG`,
`TOLERANCE`, or `UNDEFINED — pinned`.

## Not covered
Inputs, flows, or edge cases the comparison did not exercise. This section is
what makes the verdict interpretable — never leave it empty by omission.
```

Never report equivalence from reading alone when execution was available. Never
widen the tolerance to remove a mismatch.
