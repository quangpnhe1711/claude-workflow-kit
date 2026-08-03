---
name: wf-business-decision
description: Internal hard-gate step that converts evidence into explicit desired business behavior. Coding is forbidden until BUSINESS_READY.
user-invocable: false
effort: high
---

Resolve the business behavior before implementation.

The decision must be clear enough to answer, where relevant:
- WHO can perform the behavior / permission ownership;
- WHEN / preconditions;
- WHAT action occurs;
- STATE/DATA transition;
- forbidden behavior;
- important edge cases;
- aggregate vs per-entity ownership;
- legacy/backward compatibility;
- failure behavior.

Produce:

# Resolved Business Decision
## Desired behavior
## Confirmed rules
## Rejected/outdated interpretations
## Assumptions
## Open decisions
## Status

Status:
- `BUSINESS_READY` only when no open decision can materially change implementation.
- `BUSINESS_BLOCKED` otherwise.

Do not resolve a genuine product choice by guessing.

If blocked, ask one concise decision at a time, with:
Problem / Impact / Recommended resolution / Decision required.

Persist to `.ai-workflow/runs/<runId>/business-decision.md` and record it with
`cw artifact business-decision.md`. Write the file **before** touching the gate:
`cw gate pass BUSINESS_READY` is refused while `business-decision.md` is
missing, and while the gate is open the hook denies every file edit.

Gate outcome:
- `BUSINESS_READY` -> `cw gate pass BUSINESS_READY`
- `BUSINESS_BLOCKED` -> `cw gate wait BUSINESS_READY --message "<the open decision>"`

Both are only accepted from this phase: run `cw phase enter business` first.
There is no `--force`. `cw gate override BUSINESS_READY --reason "<why>"` exists
for the case where the user has decided outside the run; it is recorded as an
override and reported as such, so never reach for it to move faster.

Return the resolved decision to the calling workflow. The only thing worth
sending to the user here is a single open decision, in the four-line form above.
When the user answers, continue the same run — do not start a new one.
