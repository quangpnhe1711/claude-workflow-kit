# Review report

For: a code review or audit result.

```markdown
# Review — <what was reviewed>

## Scope
Diff, files, or commit range reviewed. What was read, and what was not.

## Findings
Ordered by severity. For each:

### P0 — Critical | P1 — High | P2 — Medium | P3 — Improvement
- **Location**: `file:line`
- **Current behavior**: what the code does now
- **Evidence**: what proves it — code, test output, command
- **Consequence**: what goes wrong, and when
- **Recommended correction**: the smallest change that resolves it

## Checks run
Anything executed during the review, and its result.

## Verdict
`READY`, `READY WITH FOLLOW-UP`, or `NOT READY`.
```

No style opinions, no invented requirements, no restating what the diff does.
If nothing was found, say so and name what was looked for.
