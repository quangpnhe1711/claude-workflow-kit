---
name: wf-standard-change
description: Adaptive LEVEL 2 workflow body for bounded multi-file, multi-layer, API, query, permission, state, or local business-behavior changes. Perform only necessary impact analysis, implement, and verify proportionally. Escalate to a full bug-fix or feature-change workflow only on concrete LEVEL 3 risk. Invoked by work and the public change/fix entry skills.
user-invocable: false
effort: medium
---

Execute the bounded medium change passed by the caller. Use this flow:

`UNDERSTAND -> TARGETED IMPACT -> IMPLEMENT -> TARGETED/INTEGRATION VERIFY -> REPORT`

Do not invoke the full phase-skill stack. This skill owns the L2 run end to end.

Open the run and record the classification. If the active run is already
`standard-change` because a quick path escalated in place, keep that run and do
not call `cw run start` again:

```text
cw run start standard-change --label "<short task label>"
cw note "Level: L2 — Medium"
```

If another run is active, do not retire it without a deliberate reason. If `cw`
is unavailable, continue the engineering task and mention that once in the
final response.

## Phase 1 — Targeted impact

`cw phase enter impact`

Read the directly affected path and only the upstream/downstream code needed to
understand behavior and compatibility.

Determine, as applicable:

- current and expected behavior;
- causal root cause for a defect;
- affected FE, API, service, query/data, permission, state, or integration path;
- local contract and backward-compatibility boundary;
- the cheapest verification that can prove the change.

For conventions, reuse a valid cache when it exists. If one or two neighboring
files establish the local pattern, use them and stop. Do not run repository-wide
convention discovery by default.

Stop investigating when evidence supports a correct, maintainable change with
no material unresolved risk. Do not audit outside scope or keep searching for a
more elegant solution after the current one is sufficient.

Ask a business question only when all are true:

1. at least two behaviors are plausible;
2. the correct choice cannot be inferred from the request, acceptance criteria,
   reproduction, supplied documents, current behavior, or prior decisions; and
3. the choice materially changes business data, permission, state, or contract.

If so:

```text
cw note "Waiting for decision: <exact concise question>"
cw phase enter await-decision
```

Ask one concise question. When answered, continue the same run with
`cw phase enter impact`. UI implementation detail is not a business blocker.

### Escalate only on LEVEL 3 evidence

Escalate when investigation finds a material risk involving migration or
production data, authentication/authorization/security, payment, concurrency or
transactions, cross-service behavior, important backward compatibility, a major
business-flow or contract change, or broad multi-module impact.

State the transition once:

`Escalated L2 -> L3 because: <concrete finding>`

Then preserve the evidence already gathered:

```text
cw note "escalating L2 -> L3 to <bug-fix|feature-change>: <finding>"
cw run escalate <bug-fix|feature-change> --reason "<finding>"
```

Invoke `wf-bug-fix` for a defect or `wf-feature-change` for a behavior change.
Pass the files, flow, root-cause/impact conclusions, and open decision already
found. Do not restart discovery.

Otherwise, `cw phase complete`.

## Phase 2 — Implement

`cw phase enter implementation`

Implement the smallest maintainable change that covers the understood impact.

- Avoid unrelated refactors and optional improvements.
- Preserve compatibility unless the requested behavior changes it.
- Add or update only tests that naturally cover the changed behavior.
- Treat implementation as distinct from verification.

Inspect the focused diff, then `cw phase complete`.

## Phase 3 — Risk-based validation

`cw phase enter validation`

Choose the cheapest sufficient evidence in this order:

1. nearest unit/function/component test;
2. affected API/service/component test;
3. affected-package typecheck, lint, or build when useful;
4. integration test when behavior crosses layers and targeted tests do not cover
   the boundary;
5. E2E only when a real critical path or integration risk remains.

Do not run the full suite or browser E2E merely because they exist. A quick
manual UI check is valid when automation would cost more than the risk it
reduces.

Record actual results. Separate:

- automated checks run;
- manual checks performed;
- behavior not verified;
- unrelated failures.

If a task-caused check fails, return to implementation, fix, and rerun. If the
only remaining coverage is a reasonable manual interaction, completion status
may be:

```text
IMPLEMENTED
TARGETED TESTS PASSED
MANUAL UI VERIFICATION REQUIRED
```

Provide numbered manual steps with an expected result for every step.

`cw phase complete`

## Finish and report

If the original request explicitly asks for a report, document, handover,
release note, review result, impact/test report, BRD/TKCB comparison, or an
audience-specific deliverable, invoke `wf-final-report` before completing the
run. It selects and reuses the matching template.

Otherwise use a quick report containing only valuable sections:

```text
Level: L2 — Medium

Cause / Reason: <for a defect or relevant reason, or omit>
Changed: <factual outcome>
Verification: <actual checks>
Manual verify: <steps with expected results, or omit>
Remaining risk: <evidence-backed remaining risk, or omit>
```

Then run `cw run complete`.

Never imply that implemented means verified, build means functionally tested, or
manual verification required means failed.
