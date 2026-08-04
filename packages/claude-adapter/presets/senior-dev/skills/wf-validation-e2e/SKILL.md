---
name: wf-validation-e2e
description: Internal LEVEL 3 validation step. Execute risk-based automated, integration, runtime, manual, and optional E2E verification with truthful evidence. E2E is selected only when it materially closes a remaining risk.
user-invocable: false
effort: medium
---

Validate against resolved behavior and actual risk. Verification is not a fixed
checklist and E2E is not a default completion condition.

Use the cheapest sufficient evidence in this order:

1. targeted unit/function/component tests;
2. affected API/service/component tests;
3. relevant typecheck, lint, or build;
4. integration tests for behavior crossing real layer boundaries;
5. E2E/runtime scenarios only for a critical journey or coverage gap that the
   prior checks cannot prove.

Do not run the full repository suite when a targeted set covers the affected
boundary. Do not run browser E2E to make the report look more complete. Manual
verification is valid when it is faster and proportionate to the remaining UI
or interaction risk.

For each applicable rule or risk, record:

- check/command or manual action;
- expected result;
- actual result;
- `PASS`, `FAIL`, or `NOT VERIFIED`;
- whether a failure is task-caused or unrelated.

Persist `<runtimeDir>/runs/<runId>/validation.md` with distinct sections:

```markdown
# Validation

## Automated
## Integration
## Manual
## Not Verified
## Unrelated Failures
## E2E Decision
```

In `E2E Decision`, state `REQUIRED` or `NOT JUSTIFIED` and the concrete risk
reason. If E2E runs in the later `e2e` phase, append its scenario and actual
result to this artifact. Record it with `cw artifact validation.md`.

If a task-caused check fails, fix within approved scope and rerun. Record an
unrelated failure without fixing it unless it prevents trustworthy completion.

Valid final assessments include:

- `PASS`
- `PASS WITH MANUAL VERIFICATION`
- `FAIL`

Never mark PASS because code looks correct. Keep these distinctions explicit:
implemented is not verified; build passed is not functional testing; unit tests
are not E2E; manual verification required is not failure.
