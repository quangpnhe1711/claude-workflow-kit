---
name: bug-fix
description: Execute the controlled bug-fix workflow: reproduce, trace legacy/current code, identify root cause, resolve business behavior, plan, impact/risk/scope, test strategy, convention reuse, implementation, validation, E2E, review, product assessment, and concise report.
disable-model-invocation: true
argument-hint: "[bug + reproduction + expected/actual]"
effort: high
---

Execute this workflow for `$ARGUMENTS`.

Report every phase transition with `cw` as it happens. The CLI owns run state;
never edit `state.json`.

Open the run first:

```
cw run start bug-fix --label "<short defect label>"
```

## Phase 0 — Input
Expected input:
- bug/symptom;
- reproduction steps when available;
- expected behavior;
- actual behavior;
- environment/data prerequisites when relevant.

Infer minor missing details from evidence. Do not block for information that
can be safely discovered.

## Phase 1 — Reproduce and establish facts
`cw phase enter root-cause`

Invoke `wf-bug-root-cause`.

Required gate output:
- reproduction status;
- current/legacy code flow;
- why current behavior occurs;
- symptom vs contributing factors vs root cause.

**HARD GATE:** do not modify code until root cause is sufficiently established.

- Established: `cw gate pass ROOT_CAUSE_READY`
- Not establishable from available evidence:
  `cw gate wait ROOT_CAUSE_READY --message "<what is missing>"`, then raise a
  concise blocker.

If reproduction is impossible but root cause can be established from
deterministic code/data evidence, state that evidence and pass the gate. If
neither can be established, wait on the gate.

## Phase 2 — Resolve business behavior
`cw phase enter business`

Invoke `wf-business-decision` using:
- expected behavior from user;
- reproduced behavior;
- current code;
- existing requirements/docs/tests as evidence.

**HARD GATE:** `BUSINESS_READY` is required before coding.

- Resolved: `cw gate pass BUSINESS_READY`
- Open decision: `cw gate wait BUSINESS_READY --message "<the open decision>"`
  and stop for that decision only.

## Phase 3 — Change readiness
`cw phase enter readiness`

Invoke `wf-change-readiness`.

It must produce:
- implementation plan;
- direct + indirect impact;
- risks;
- scope boundaries;
- test strategy.

Do not code before readiness is complete.

`cw phase complete`

## Phase 4 — Conventions
`cw phase enter conventions`

Invoke `wf-convention-manager`.

Prefer cached code/comment/test/database conventions.
Do not rescan the entire codebase if valid conventions already exist.
Refresh only relevant missing/stale/conflicting sections.

`cw phase complete`

## Phase 5 — Implement
`cw phase enter implementation`

Invoke `wf-implement`.

Fix the root cause with the smallest safe change.
Do not patch only the symptom unless the evidence shows the symptom is itself
the root cause.
Do not add optional improvements.

`cw phase complete`

## Phase 6 — Validate
`cw phase enter validation`

Invoke `wf-validation-e2e`.

Run appropriate regression validation, then `cw phase complete`,
`cw phase enter e2e` for runtime verification that the reported symptom is gone,
then `cw phase complete`.

If failures are caused by the change, fix within approved scope and rerun.
If unrelated regression is discovered, record it; raise only if it blocks
trustworthy completion.

## Phase 7 — Independent review
`cw phase enter review`

Delegate the final diff/result to `independent-reviewer`.
If reviewer finds a task-related correctness issue, fix it
(`cw phase enter implementation`) and rerun affected validation.
Maximum review/fix loops: 3. After that, report unresolved findings rather than
looping indefinitely.

`cw phase complete`

## Phase 8 — Product/technical assessment
`cw phase enter assessment`

Invoke `wf-product-assessment`.

Do not automatically implement recommendations.

`cw phase complete`

## Phase 9 — Report
`cw phase enter report`

Invoke `wf-final-report`.

Return only the concise final report. No execution diary.

```
cw phase complete
cw run complete
```
