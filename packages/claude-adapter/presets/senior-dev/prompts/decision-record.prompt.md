# Decision record

For: one architectural, irreversible, or contested decision, recorded so the
reason survives the people who made it.

```markdown
# <decision, stated as a decision>

- **Date**: <YYYY-MM-DD>
- **Status**: Proposed | Accepted | Superseded by <link>
- **Decided by**: <who actually decided>

## Context
The situation that forced a choice. Constraints that were real at the time.

## Decision
What was decided, precisely enough to be checked against the code later.

## Alternatives considered
Each with why it was rejected. An alternative with no reason was not considered.

## Consequences
What this makes easy, what it makes hard, and what it forecloses.

## Reversibility
How this is undone, and what that would cost. `Not reversible without <X>` when
that is the truth.
```

One decision per record. If it needs two, it is two records.
