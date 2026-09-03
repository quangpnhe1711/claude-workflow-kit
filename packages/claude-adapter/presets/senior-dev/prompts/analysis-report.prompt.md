# Analysis report

For: analysis, options, and a recommendation, with no code written.

```markdown
# <question being answered>

## Understanding
The goal, the business behavior involved, the scope, and the constraints — as
established from the request and the code, not restated from the request alone.

## Current state
How the system does this today, with real paths. The existing pattern a
solution would follow or break.

## Options
Only genuinely different approaches. For each:
- what it does
- cost and complexity
- risk, compatibility, and migration burden
- how well it fits the existing codebase

State plainly when there is only one defensible approach, and why.

## Recommendation
The chosen option and the reason. What was rejected and why.

## Assumptions and open decisions
Assumptions made to proceed, and the decisions that genuinely need the user.

## Implementation outline
The sequence of work, at the level of files and boundaries — not a task list
with estimates.

## Verification strategy
How the result would be proven correct, per acceptance criterion where they exist.
```

Stop here. Analysis output is not permission to implement.
