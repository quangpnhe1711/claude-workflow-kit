---
name: wf-bug-fix
description: Controlled defect workflow body. Reproduce and establish causal root cause behind the ROOT_CAUSE_READY gate, resolve expected behavior behind BUSINESS_READY, plan, implement the smallest root-cause fix, validate, E2E, independent review, assessment, compact report. Invoked by the bug-fix and work entry skills.
user-invocable: false
effort: high
---

Execute this workflow for the defect passed in by the caller.

Report every phase transition with `cw` as it happens. The CLI owns run state;
never edit `state.json`.

Enforced by code, not by this file:
- `cw phase enter <node>` refuses transitions the definition forbids;
- while `ROOT_CAUSE_READY` **or** `BUSINESS_READY` is unpassed, the PreToolUse
  hook **denies Edit/Write**. A denial means a gate is still open.

Open the run first:

```
cw run start bug-fix --label "<short defect label>"
```

If another run is active, do not start a second one — see `cw status`.

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

Required gate output, persisted to `.ai-workflow/runs/<runId>/root-cause.md`:
- reproduction status;
- current/legacy code flow;
- why current behavior occurs;
- symptom vs contributing factors vs root cause.

**HARD GATE:** `cw gate pass ROOT_CAUSE_READY` is refused unless the current
phase is `root-cause` and `root-cause.md` exists.

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

**HARD GATE:** `BUSINESS_READY` requires `business-decision.md` and the
`business` phase to be current.

- Resolved: `cw gate pass BUSINESS_READY`
- Open decision: `cw gate wait BUSINESS_READY --message "<the open decision>"`
  and stop for that decision only. The answer continues the **same** run.

## Phase 3 — Change readiness
`cw phase enter readiness`

Invoke `wf-change-readiness`. It owns `implementation-plan.md`,
`impact-risk-scope.md`, `test-strategy.md`.

Do not code before readiness is complete.

`cw phase complete`

## Phase 4 — Conventions
`cw phase enter conventions`

Run `cw conventions status`, then invoke `wf-convention-manager`.
Reuse valid cached areas; refresh only what the status report flags.

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

Delegate to `independent-reviewer` using the input contract in `wf-implement` →
*Independent review handoff*. Pass the artifact directory and diff location, not
your own summary. Persist the verdict to `review.md`, then `cw artifact review.md`.

If the reviewer finds a task-related correctness issue, fix it
(`cw phase enter implementation`) and rerun affected validation.
Maximum review/fix loops: 3. After that, report unresolved findings rather than
looping indefinitely.

`cw phase complete`

## Phase 8 — Product/technical assessment
`cw phase enter assessment`

Invoke `wf-product-assessment`. Do not automatically implement recommendations.

`cw phase complete`

## Phase 9 — Report
`cw phase enter report`

Invoke `wf-final-report`. Return only the concise final report. No execution
diary.

```
cw phase complete
cw run complete
```
