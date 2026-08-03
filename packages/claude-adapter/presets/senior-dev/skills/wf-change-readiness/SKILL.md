---
name: wf-change-readiness
description: Internal pre-code step that creates implementation plan, cross-module impact analysis, risk analysis, scope boundaries, and test strategy.
user-invocable: false
effort: high
---

Require `BUSINESS_READY`. If absent, do not continue.

Create one coherent pre-code package:

## Implementation plan
- affected layers/files/modules;
- data/schema/migration/backfill;
- API contract;
- FE/UI;
- permissions;
- compatibility;
- sequence of implementation.

## Impact analysis
Search beyond immediately named files.
Classify:
- Direct impact
- Indirect/downstream impact

Consider:
- list/detail screens;
- shared APIs;
- filters/search;
- dashboard/report/export;
- permissions;
- integrations;
- scheduled jobs/events;
- legacy consumers.

## Risk analysis
Use Critical/High/Medium/Low where meaningful.
Consider production data, migration, compatibility, security, permission,
concurrency/transactions, regressions, audit/history, legacy records.

## Scope
- Required in-scope
- Explicitly out-of-scope
- Optional/future observations

Do not implement optional items.

## Test strategy
Derive tests from business rules before implementation:
- happy path;
- negative/permission;
- boundary/edge cases;
- regression;
- legacy/backward compatibility;
- migration/data;
- E2E scenarios.

## Artifact contract

This phase owns three files and the workflow definition declares all three:

| File | Content |
| --- | --- |
| `implementation-plan.md` | the plan section above |
| `impact-risk-scope.md` | impact analysis, risk analysis, scope |
| `test-strategy.md` | the test strategy |

Persist all three to `.ai-workflow/runs/<runId>/`, then record each with
`cw artifact <filename>`. The runtime enforces this: `cw phase complete` and the
next `cw phase enter` are both refused while one of the three is missing or
empty, so implementation cannot begin without them. Write the files — do not
reach for `--allow-missing-artifacts`, which is an audited exception for the case
where the artifact genuinely does not apply.

Return the package to the calling workflow. Do not write it out to the user.
