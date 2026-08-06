---
name: wf-bug-fix
description: Full LEVEL 3 defect workflow body. Establish causal root cause behind ROOT_CAUSE_READY, resolve material business behavior behind BUSINESS_READY, plan high-risk impact, implement, validate proportionally, conditionally run E2E, independently review, assess, and report at the requested depth.
user-invocable: false
effort: high
---

Execute this workflow for the defect passed in by the caller.

This is the full path for LEVEL 3 risk. If the defect is L0-L2, return it to
`wf-quick-fix` or `wf-standard-change`.

Report every phase transition with `cw` as it happens. The CLI owns run state;
never edit `state.json`.

Enforced by code, not by this file:
- `cw phase enter <node>` refuses transitions the definition forbids;
- while `ROOT_CAUSE_READY` **or** `BUSINESS_READY` is unpassed, the PreToolUse
  hook **denies Edit/Write**. A denial means a gate is still open.

Open the run first:

```
cw run start bug-fix --label "<short defect label>"
cw mission classify --type bug-fix --complexity high [--flags "..."]
cw mission plan --objective "<one sentence>" --scope "a,b" --out-of-scope "..."
```

A Deep defect owes `PLAN`, `INVESTIGATION`, `ROOT_CAUSE`, `DESIGN` and `CODE`
checkpoints, plus whatever the structural flags add, and a `rootCause` confidence
of at least 75%. An unopened pre-implementation checkpoint denies repository
writes exactly like the hard gate. Use `wf-checkpoint` and `wf-mission-board`.

If the active run is already `bug-fix` because L1/L2 escalated in place, keep
that run and do not call `cw run start` again. Continue with the first required
L3 phase and reuse the findings already recorded in the event log. If a
different run is active, do not start a second one — see `cw status`.

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

Required gate output, persisted to `<runtimeDir>/runs/<runId>/root-cause.md`:
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

Record what the earlier phases established, then enter the phase:

```text
cw mission evidence <category> SUFFICIENT      # per area actually established
cw mission confidence rootCause <0-100>        # >= 75: no root cause, no fix
cw mission confidence requirement <0-100>
cw mission confidence scope <0-100>
cw mission confidence businessRule <0-100>
cw mission confidence architecture <0-100>
cw mission confidence design <0-100>
cw mission confidence implementation <0-100>
cw phase enter implementation
```

The entry is refused while any floor is unmet, evidence is `MISSING`/
`CONFLICTING`/`OUTDATED`, a checkpoint is unanswered, or a CRITICAL risk is open.

Invoke `wf-implement`.

Fix the root cause with the smallest safe change.
Do not patch only the symptom unless the evidence shows the symptom is itself
the root cause.
Do not add optional improvements.

`cw phase complete`

## Phase 6 — Validate
`cw phase enter validation`

Invoke `wf-validation-e2e`.

Run appropriate targeted/integration regression validation. Then decide whether
E2E materially reduces a remaining risk.

- Justified critical journey or cross-layer gap: complete validation, enter
  `e2e`, verify the symptom is gone, and complete it.
- Not justified: complete validation, then
  `cw phase skip e2e --message "<why lower-level/manual evidence is sufficient>"`.

Do not run E2E merely because this is the full workflow. The graph permits both
paths into review.

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

Invoke `wf-final-report`. It returns a quick report unless the original request
explicitly asks for a detailed, template-backed deliverable. No execution diary.

```
cw phase complete
cw run complete
```
