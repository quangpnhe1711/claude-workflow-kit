---
name: wf-feature-from-analysis
description: Internal feature-change continuation for a trace-linked approved solution-analysis run. Check relevant-source freshness, reuse the six existing artifacts without repeating business or solution analysis, refresh only stale portions, then implement, validate, review, assess, and report.
user-invocable: false
effort: high
---

Require an active `feature-change` run with `sourceAnalysisRunId` and current
phase `freshness`. Do not start another run and do not recreate the approved
analysis.

## Freshness

Run:

```text
cw analysis freshness
```

- `VALID`: complete `freshness` and continue.
- `STALE`: do not implement. Inspect only the reported changed paths and their
  necessary boundaries. Update only affected copies of the six analysis
  artifacts in the feature run. If the chosen solution, business behavior, or
  approved scope must change, stop for explicit user approval before proceeding.
  Record the targeted refresh and recheck:

```text
cw analysis refresh --source "affected/file.ts,other/file.ts" --reason "<what was refreshed>"
cw analysis freshness
```

`BUSINESS_READY` remains closed until freshness is valid, so repository mutation
is forbidden during this phase.

## Continue from approved inputs

Use `recommended-solution.md` as the approved business/solution source of truth,
`impact-analysis.md` as impact/risk/scope, and the existing implementation plan
and test strategy. Do not enter `evidence`, `business`, or `readiness`; the
runtime marks them skipped for this branch.

```text
cw phase complete freshness
cw phase enter conventions
```

Reuse `wf-convention-manager` proportionally, then follow the existing full
feature path from conventions onward:

```text
conventions -> implementation -> validation -> conditional e2e -> review
-> assessment -> report -> done
```

Invoke the existing specialist skills for those phases. Keep the implementation
inside the approved scope. Validate against the approved artifacts, preserve
compatibility unless explicitly changed, and keep E2E conditional on actual
risk. Complete the feature run only after its normal artifact contracts pass.

