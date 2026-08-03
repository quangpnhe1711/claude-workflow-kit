---
name: wf-validation-e2e
description: Internal validation step that executes the predefined test strategy, build/integration checks, and E2E/runtime verification with evidence.
user-invocable: false
effort: high
---

Validate against resolved business behavior and the pre-code test strategy.

Run only relevant commands, plus necessary broader regression checks based on impact.

Evidence may include:
- unit tests;
- integration/API tests;
- build;
- typecheck/lint;
- migration/schema checks;
- runtime verification;
- browser/API E2E;
- data-state verification.

For each relevant business rule, map evidence to the rule.

If a test fails:
- determine whether caused by the change;
- fix task-caused failures within approved scope and rerun;
- record unrelated failures separately;
- raise only when unrelated failure prevents trustworthy completion.

E2E should verify the real flow where feasible, not just compilation.

Never mark PASS because code "looks correct".

Persist concise commands/results/evidence to
`.ai-workflow/runs/<runId>/validation.md` and record it with
`cw artifact validation.md`. The independent reviewer reads this file directly,
so record the actual commands and their actual output, not a claim of success.

Return the result to the calling workflow. Raise to the user only a failure that
blocks trustworthy completion.
