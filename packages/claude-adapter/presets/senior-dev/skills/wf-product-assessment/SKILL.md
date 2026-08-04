---
name: wf-product-assessment
description: Internal LEVEL 3 or explicitly requested post-implementation assessment for evidence-backed business, product, UX, data, maintainability, security, auditability, and scaling concerns.
user-invocable: false
effort: medium
---

Run only after implementation and appropriate validation. E2E is not a
precondition when the risk-based validation decision found it unjustified.

Do not modify code.

Assess the completed behavior in context:
- business/product consistency;
- user workflow/UX;
- data consistency;
- maintainability/technical debt created or exposed;
- security/permissions;
- auditability/history;
- scaling/future constraints only where concrete evidence exists.

Only report an observation when:
1. it was materially revealed by the current scope; and
2. there is concrete requirement/code/DB/UI/test evidence; and
3. it has plausible impact.

Do not invent nice-to-have features.
Do not recommend "AI", realtime, notifications, dashboards, refactors, etc.
merely because they sound useful.

For each recommendation:
- ID
- Observation
- Evidence
- Impact
- Recommendation
- Priority: Critical/High/Medium/Low/Future
- Scope: Current correctness / Separate task / Product decision / Technical debt

Only Critical/High correctness/safety issues may force reopening the current task.
Other recommendations remain report-only.

If nothing material exists: `No material follow-up recommendations.`

Persist to `<runtimeDir>/runs/<runId>/assessment.md` and record it with
`cw artifact assessment.md`.

Return the findings to the calling workflow. `wf-final-report` decides what
reaches the user; do not print the assessment separately.
