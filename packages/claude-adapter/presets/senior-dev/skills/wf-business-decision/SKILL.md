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
`cw artifact business-decision.md`.

Gate outcome:
- `BUSINESS_READY` -> `cw gate pass BUSINESS_READY`
- `BUSINESS_BLOCKED` -> `cw gate wait BUSINESS_READY --message "<the open decision>"`
