# Change report

For: what was implemented — a feature, a change, a refactor, a UI or copy
change — written for a developer or a technical lead.

```markdown
# <what changed, one line>

## Summary
Two or three sentences: what the system does now that it did not before, and why.

## Changes
| File / area | Change | Reason |
Only files that carry meaning. Group mechanical edits into one row.

## Behavior
Before -> after, in the terms a user or caller experiences.
Write `No business behavior changed.` when it is a pure refactor.

## Acceptance criteria
| # | Criterion | Code path | Verification | Result |
One row per criterion, `VERIFIED` / `NOT VERIFIED (reason)`.
Omit the section when the request carried no criteria.

## Verification
What was actually run, and its result. Name the commands and tests.
List what was not verified, and manual steps with their expected result.

## Impact
Consumers, contracts, data, or configuration affected outside the changed files.
`None beyond the changed files.` when that is true.

## Follow-up
Evidence-backed observations left out of scope. Omit when there are none.
```

Do not include an execution diary, a phase list, or how the work was organized.
