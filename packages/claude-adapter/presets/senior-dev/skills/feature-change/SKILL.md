---
name: feature-change
description: Execute the controlled feature/change workflow for requirement, design, database or code inputs that may conflict or be outdated. Reconcile evidence, obtain a clear business decision, plan impact/risk/scope/tests, reuse conventions, implement, validate E2E, review, assess product issues, and report.
disable-model-invocation: true
argument-hint: "[desired outcome + requirement/design/DB/code inputs]"
effort: high
---

Execute this workflow for `$ARGUMENTS`.

Report every phase transition with `cw` as it happens. The CLI owns run state;
never edit `state.json`. If `cw` is unavailable, continue the engineering work
and note the missing CLI once in the final report.

Open the run first:

```
cw run start feature-change --label "<short task label>"
```

## Phase 0 — Ingest evidence
Inputs may include:
- desired business outcome/user intent;
- requirement/design documents (for example TKCB, TKCT, BR/BRD);
- database/schema;
- current code;
- tests;
- compatibility/data constraints.

Documents are evidence, not authority.

## Phase 1 — Reconcile requirements
`cw phase enter evidence`

Invoke `wf-evidence-reconciliation`.

Required:
- desired outcome;
- current behavior;
- documented behavior by source;
- contradictions;
- facts/inferences/assumptions/proposals;
- candidate resolution.

Do not silently prefer documents over code, or code over documents.

`cw phase complete`

## Phase 2 — Business decision
`cw phase enter business`

Invoke `wf-business-decision` using the reconciled evidence.

Produce a resolved business specification.

**HARD GATE:** coding is forbidden until status is `BUSINESS_READY`.

- Resolved: `cw gate pass BUSINESS_READY`
- Open decision: `cw gate wait BUSINESS_READY --message "<the open decision>"`,
  then stop and ask the user with Problem / Impact / Recommended resolution /
  Decision required. When the answer arrives, continue the same run:
  `cw phase enter business` then `cw gate pass BUSINESS_READY`.

Do not produce implementation code while waiting.

## Phase 3 — Change readiness
`cw phase enter readiness`

Invoke `wf-change-readiness`.

Required:
- implementation plan;
- cross-screen/module impact;
- risk analysis;
- in/out scope;
- test strategy derived from resolved business behavior.

`cw phase complete`

## Phase 4 — Conventions
`cw phase enter conventions`

Invoke `wf-convention-manager`.

Reuse cached code/comment/test/database conventions.
Only discover missing/stale/conflicting areas.
Local intentional conventions near touched code override generic cache.

`cw phase complete`

## Phase 5 — Implement
`cw phase enter implementation`

Invoke `wf-implement`.

Follow the resolved business decision and approved scope, not documents blindly.
Keep backward compatibility unless the resolved decision explicitly changes it.

`cw phase complete`

## Phase 6 — Validate + E2E
`cw phase enter validation`

Invoke `wf-validation-e2e`.

Validate implementation against the resolved business specification and the
pre-defined test strategy, not against implementation details alone.

`cw phase complete`, then `cw phase enter e2e` for runtime/end-to-end
verification, then `cw phase complete`.

## Phase 7 — Independent review
`cw phase enter review`

Delegate final diff/result to `independent-reviewer`.

Fix task-related correctness findings, rerun impacted validation, and review
again. Maximum loops: 3. Re-entering implementation for a fix is a legal
transition: `cw phase enter implementation`.

`cw phase complete`

## Phase 8 — Product/technical assessment
`cw phase enter assessment`

Invoke `wf-product-assessment`.

Look for evidence-backed product, business, UX, data, maintainability,
auditability, security, or scaling issues related to this scope.
Recommendations remain separate tasks unless required for correctness.

`cw phase complete`

## Phase 9 — Final report
`cw phase enter report`

Invoke `wf-final-report`.

Return only concise outcome/evidence/risks/recommendations. No execution diary.

```
cw phase complete
cw run complete
```

If the task is abandoned or blocked beyond recovery: `cw run fail --message "<reason>"`.
