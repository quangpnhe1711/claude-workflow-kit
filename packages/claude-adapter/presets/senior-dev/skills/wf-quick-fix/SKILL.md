---
name: wf-quick-fix
description: Short workflow body for a small, explicitly specified change. Triage the narrow code path, make the smallest causal change, validate focusedly, report in three lines. Escalates to wf-bug-fix or wf-feature-change on concrete evidence. Invoked by the quick-fix and work entry skills.
user-invocable: false
effort: medium
---

Execute this workflow for the small fix passed in by the caller.

The requested outcome is already sufficiently clear. Find the narrow
implementation cause, make the smallest correct change, validate it, stop.

**This is not a smaller version of the full workflow.** No evidence
reconciliation, no business gate, no readiness package, no convention discovery,
no product assessment, no independent reviewer, no long report.

`quick-fix` carries no gates, so the `PreToolUse` hook does not block edits here.
That is the point — and the reason the escalation rules below are not optional.

Open the run:

```
cw run start quick-fix --label "<short fix label>"
```

If another run is active, do **not** `--force`: that retires a real workflow run.
Report it and let the user decide. If `cw` is unavailable, do the work and
mention the missing CLI once.

## Phase 1 — Triage

`cw phase enter triage`

Goal: locate the relevant implementation and confirm this really is a narrow fix.

Start narrow. Normally inspect only:

- the directly relevant component/file;
- the nearest permission/condition/helper it depends on;
- the corresponding backend authorisation **only when the request depends on it**;
- the nearest existing test.

Do **not** automatically: scan the repository, read architecture docs or
requirement documents (BRD/TKCB/TKCT), inspect git history, run full convention
discovery, or open unrelated modules. Use cached conventions if they already
exist; do not refresh them.

The user's stated outcome is authoritative when it is explicit. "Cho MNG được
tạo Action" is a decision already made — do not ask whether MNG should be able
to. Inspect only enough implementation to know what must change.

Root cause here is one concise internal conclusion, not a document:

```
Expected: --skip-mcp skips MCP prerequisites.
Actual:   the Python check runs before the skip-mcp branch.
Cause:    the installer validates Python before evaluating the option.
```

That is sufficient. Do not trace commit origin unless the fix depends on it.

### Ask nothing, normally

Quick-fix normally asks **zero** questions. Ask only when investigation finds a
material ambiguity that makes the requested fix impossible to implement without
inventing behaviour.

- Can you implement the explicitly requested behaviour without inventing a
  business decision? **Proceed.**
- Would you have to invent one? **Escalate** (below).

Not reasons to stop: more than one file involved; both FE and BE need editing;
several implementation options exist; a business capability changes *because the
user asked for it*.

### Escalate when the narrow path does not hold

Escalate when investigation actually finds:

- genuinely ambiguous business behaviour;
- DB/schema change or data migration;
- unclear authorisation semantics;
- a significant state/workflow transition change;
- an important API contract change;
- a backward-compatibility decision;
- broad cross-module business impact;
- root cause still uncertain after the narrow investigation;
- the fix is materially larger than the request implied.

Target: uncertain root cause on a defect → `wf-bug-fix`. A business
behaviour/change request → `wf-feature-change`.

How to escalate, carrying what you already learned:

```
cw note "escalating to <bug-fix|feature-change>: <the concrete finding>"
cw run start <bug-fix|feature-change> --force --reason "escalated from quick-fix: <finding>"
```

Then invoke `wf-bug-fix` / `wf-feature-change` and **hand it the evidence you
already gathered** — the files you read, the flow you traced, the conclusion you
reached. Do not restart analysis from zero. Tell the user in one line that the
task escalated and why.

`cw phase complete`

## Phase 2 — Fix

`cw phase enter fix`

Implement the smallest causal change.

- No unrelated refactor, no cleanup outside the touched path.
- Follow the surrounding repository conventions.
- No new abstraction for a one-line fix, no architecture change.
- No optional improvements, no adjacent fixes, even obvious ones.
- No new tests, docs or changelog entries by default.
- If the request says exactly what to change, do that — unless the actual code
  proves it would create a material correctness problem, in which case say so in
  one line before proceeding differently.

`cw phase complete`

## Phase 3 — Validate

`cw phase enter validate`

Focused validation, cheapest sufficient evidence first:

1. the nearest unit/component test;
2. typecheck/lint/build for the affected package, when cheap;
3. one focused runtime or manual probe, when it is what actually proves the fix.

Do **not** run the full repository E2E, every package's tests, or the whole
integration suite — unless the project has no cheaper relevant check, the touched
area is genuinely risky, or the fix sits on a shared/core path.

Examples: a UI visibility fix → the component test if it exists, plus the
frontend typecheck. An installer flag fix → the installer test, plus one CLI
probe. A small backend condition → the nearest service/API test.

Then a lightweight diff check — no reviewer agent:

- the intended change is present;
- nothing unrelated crept into the diff;
- validation actually passed.

If a check fails because of this change, fix it (`cw phase enter fix` is a legal
transition) and rerun. If it fails for an unrelated reason, say so in one line
and leave it alone.

`cw phase complete`

## Finish

```
cw run complete
```

No artifacts are required by this workflow, and none should be written by
default. If the task escalated, the full workflow owns its own artifacts.

## Output

Narration during execution: none. No "I'm reading…", no "now I'll inspect…".

Final response, usually exactly this shape:

```
Fixed:
<what changed>

Cause:
<one short sentence>

Validation:
<what was actually run>
```

Example:

```
Fixed:
MNG now sees Create Action using the existing backend permission.

Cause:
The frontend visibility condition excluded MNG even though the create API
already permitted it.

Validation:
Frontend typecheck passed and the create-action visibility case was verified.
```

No long report. No recommendations. No follow-up list.

## Speed budget

Optimise for latency. Inspect the direct code path first, prefer precise
Grep/Read over broad exploration, stop investigating once the causal change is
established. Do not collect evidence "just in case", and do not read files that
cannot change the decision.

Enough evidence to make this fix safely **beats** maximum understanding of the
subsystem.
