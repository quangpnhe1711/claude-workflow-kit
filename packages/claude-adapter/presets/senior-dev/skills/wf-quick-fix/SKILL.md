---
name: wf-quick-fix
description: L0-L1 fast workflow body for trivial and small explicitly specified changes. Inspect the direct path, change it, verify minimally or targetedly, and stop. Escalate to wf-standard-change for L2 or a full bug/feature workflow for L3 only on concrete evidence. Supports detailed reports on explicit request.
user-invocable: false
effort: low
---

Execute the fast path passed by the caller:

`UNDERSTAND -> ROOT CAUSE IF NEEDED -> CHANGE -> MINIMAL/TARGETED VERIFY -> REPORT`

Do not invoke evidence reconciliation, readiness, convention discovery, product
assessment, an independent reviewer, or E2E by default.

Open the run and record the mission:

```text
cw run start quick-fix --label "<short fix label>"
cw mission classify --type <taskType> --complexity <trivial|low> [--flags "..."]
```

`classify` routes: if the declared type or flags turn out to need a deeper path,
the same run escalates in place. Lightning and Fast owe two confidence numbers
before the fix phase — `requirement` and `scope`, plus `rootCause` for a defect —
and nothing else. See `wf-mission-board` for what to emit; a checkpoint is only
needed if a real decision appears (`wf-checkpoint`).

Use L0 for a mechanical/local change whose behavior and location are obvious.
Use L1 for a bounded bug or small behavior change that needs a concise causal
explanation. If another run is active, do not force-retire it. If `cw` is
unavailable, continue the task and mention that once at the end.

## Phase 1 — Understand

`cw phase enter triage`

Start with the directly relevant file, its nearest dependency/condition, and the
nearest existing test. Expand only when the cause is not yet supported.

Do not automatically scan the repository, read architecture or requirement
documents, inspect git history, refresh conventions, or audit unrelated modules.
Reuse a valid convention cache if already relevant; otherwise one or two nearby
files are sufficient to establish a local pattern.

- L0: confirm the target and make the direct change. Do not invent a root-cause
  analysis for a typo, CSS adjustment, label, constant, or behavior-preserving
  refactor.
- L1 defect: establish one concise causal explanation. Reproduction may be code
  evidence when a runtime reproduction would cost more than the risk it reduces.

The user's explicit expected behavior is already a decision. Ask only when at
least two materially different business/data/permission/contract behaviors are
plausible and the correct one cannot be inferred safely.

### Escalation

Escalate to L2 when the task proves to require bounded multi-file/multi-layer
impact analysis, FE+BE behavior, a local API/query/permission/state change, or a
root cause beyond the narrow path.

Escalate directly to L3 when evidence reveals migration or production-data risk,
authentication/authorization/security, payment, concurrency/transaction,
cross-service behavior, important contract/backward compatibility, a major
business flow, or broad multi-module impact.

State the transition once:

`Escalated L1 -> L2 because: <concrete finding>`

or the applicable L0/L1 -> L3 transition. Preserve what is already known:

```text
cw note "escalating <from> -> <to>: <finding>"
cw run escalate <standard-change|bug-fix|feature-change> --reason "<finding>"
```

Then invoke exactly one body:

- L2 -> `wf-standard-change`
- L3 defect -> `wf-bug-fix`
- L3 feature/change -> `wf-feature-change`

Pass the files, trace, and conclusions already gathered. Do not restart analysis.

If the fast path still holds, `cw phase complete`.

## Phase 2 — Change

```text
cw mission confidence requirement <0-100>
cw mission confidence scope <0-100>
cw phase enter fix
```

Entering `fix` is refused while a confidence floor is unmet. If the change is so
mechanical that assessing it is theatre, say so once and record the user's
decision: `cw mission accept-risk --reason "<why>"`.

Implement the smallest correct change.

- No unrelated refactor or adjacent cleanup.
- Follow the surrounding local convention.
- Add no abstraction, test, documentation, or changelog entry unless it directly
  supports correctness or the user requested it.
- Stop once behavior is correct, maintainable, and low risk.

`cw phase complete`

## Phase 3 — Minimal or targeted verification

`cw phase enter validate`

Choose the cheapest sufficient evidence:

1. syntax or focused diff inspection for a truly mechanical L0 change;
2. nearest unit/function/component/API test for L1;
3. affected-package typecheck/lint/build when it catches relevant errors cheaply;
4. one focused runtime or manual probe when that proves the behavior best.

Do not run the full suite, repository E2E, or browser automation by default. If
manual UI interaction takes seconds and risk is low, give manual verification
steps instead of building E2E coverage.

For every manual step include the expected result. Record unverified behavior as
not verified; never convert implementation, review, build, or unit-test success
into a stronger testing claim.

If a task-caused check fails, return to `fix`, correct it, and rerun. Leave
unrelated failures unchanged and report them only when relevant.

`cw phase complete`

## Finish and report

If the original request explicitly asks for a report, detailed report, document,
handover, release note, review result, impact/test report, BRD/TKCB comparison,
or a BA/PO/Test/End User deliverable, invoke `wf-final-report` and reuse the
matching `<runtimeDir>/templates/*.md` file (normally
`.ai-workflow/templates/*.md`). Task level never limits report depth.

Otherwise return a quick report with only applicable sections:

```text
Level: <L0 — Trivial|L1 — Small fix>

Cause / Reason: <L1 defect or relevant reason only>
Changed: <factual outcome>
Verification: <actual checks>
Manual verify: <numbered actions + expected results, when needed>
Remaining risk: <evidence-backed remaining risk, when present>
```

`IMPLEMENTED — MANUAL UI VERIFICATION REQUIRED` is a valid completed outcome when the
code and appropriate automated checks are complete and only a quick UI/browser
interaction remains.

Run `cw run complete` after any requested report has been produced.

Optimize for latency: stop investigating as soon as the evidence supports a
safe causal change.
