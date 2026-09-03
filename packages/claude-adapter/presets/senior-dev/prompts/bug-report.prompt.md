# Bug report

For: a defect investigated, fixed, or both.

```markdown
# <symptom, one line>

## Symptom
What was observed, with concrete input and output. Who it affected, since when
if known.

## Reproduction
The narrowest reliable case, or `NOT_REPRODUCED` with what was tried and what
evidence was used instead.

## Root cause
The causal chain, with `file:line` at each hop. A location is not a cause: say
why the wrong value becomes inevitable. If only a symptom patch was applied,
say so explicitly and why.

## Fix
What changed and why it addresses the cause. Note any test that encoded the
buggy behavior and had to be corrected.

## Regression risk
What else runs through the changed path, and how that was checked.
Other call sites sharing the same cause, if any — even when out of scope.

## Verification
The failing case, now passing, named. Other checks run. What is still
unverified, and manual steps with expected results.
```

`Fixed` requires a check that failed before and passes now. Otherwise write
`Implemented — not verified` and say what would prove it.
