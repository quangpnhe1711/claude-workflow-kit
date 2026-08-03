---
name: wf-feature-change
description: Controlled feature/change workflow body. Reconcile evidence, resolve business behavior behind the BUSINESS_READY gate, plan impact/risk/scope/tests, reuse conventions, implement, validate, E2E, independent review, product assessment, compact report. Invoked by the feature-change and work entry skills.
user-invocable: false
effort: high
---

Execute this workflow for the task passed in by the caller.

Report every phase transition with `cw` as it happens. The CLI owns run state;
never edit `state.json`. If `cw` is unavailable, continue the engineering work
and note the missing CLI once in the final report.

Two things are enforced by code, not by this file:
- `cw phase enter <node>` refuses a transition the workflow definition forbids;
- while `BUSINESS_READY` is unpassed, the PreToolUse hook **denies Edit/Write**.
  A denial is not a bug to work around — it means the gate is still open.

Open the run first:

```
cw run start feature-change --label "<short task label>"
```

If that fails because another run is active, do not start a second one. Read
`cw status`. Either continue that run, finish it, or retire it deliberately with
`cw run abandon --message "<why>"`.

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

Produce a resolved business specification and persist it to
`.ai-workflow/runs/<runId>/business-decision.md`.

**HARD GATE:** file mutation is denied by the hook until `BUSINESS_READY` passes.
`cw gate pass BUSINESS_READY` is refused unless the current phase is `business`
and `business-decision.md` exists — write the evidence, then pass the gate.

- Resolved: `cw gate pass BUSINESS_READY`
- Open decision: `cw gate wait BUSINESS_READY --message "<the open decision>"`,
  then stop and ask the user with Problem / Impact / Recommended resolution /
  Decision required. When the answer arrives, continue the **same** run:
  `cw phase enter business` then `cw gate pass BUSINESS_READY`. Never open a new
  run to answer a question.

Do not produce implementation code while waiting.

## Phase 3 — Change readiness
`cw phase enter readiness`

Invoke `wf-change-readiness`. It owns three artifacts:
`implementation-plan.md`, `impact-risk-scope.md`, `test-strategy.md`.

`cw phase complete` warns if any are missing; write them before completing.

## Phase 4 — Conventions
`cw phase enter conventions`

Run `cw conventions status` first, then invoke `wf-convention-manager`.
Reuse valid cached areas. Only refresh what the status report flags.

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

Validate against the resolved business specification and the pre-defined test
strategy, not against implementation details alone.

`cw phase complete`, then `cw phase enter e2e` for runtime/end-to-end
verification, then `cw phase complete`.

## Phase 7 — Independent review
`cw phase enter review`

Delegate to the `independent-reviewer` agent using the input contract in
`wf-implement` → *Independent review handoff*: pass the run artifact directory
and where to find the diff. Do not pass your own summary of the change.

Write the verdict to `.ai-workflow/runs/<runId>/review.md`, then
`cw artifact review.md`.

Fix task-related correctness findings, rerun impacted validation, and review
again. Maximum loops: 3. Re-entering implementation for a fix is a legal
transition: `cw phase enter implementation`.

`cw phase complete`

## Phase 8 — Product/technical assessment
`cw phase enter assessment`

Invoke `wf-product-assessment`.
Recommendations remain separate tasks unless required for correctness.

`cw phase complete`

## Phase 9 — Final report
`cw phase enter report`

Invoke `wf-final-report`. This is the only step that addresses the user at
length. Return concise outcome/evidence/risks/recommendations. No execution
diary.

```
cw phase complete
cw run complete
```

If the task is abandoned or blocked beyond recovery:
`cw run fail --message "<reason>"`.
