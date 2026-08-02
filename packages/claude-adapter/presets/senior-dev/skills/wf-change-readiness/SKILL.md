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

Persist to `.ai-workflow/runs/<runId>/implementation-plan.md`,
`impact-risk-scope.md` and `test-strategy.md`, then record each with
`cw artifact <filename>`.
