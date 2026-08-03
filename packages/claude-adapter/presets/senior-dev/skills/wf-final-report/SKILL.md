---
name: wf-final-report
description: Internal final reporting step that produces a compact evidence-focused completion report without narrating routine work.
user-invocable: false
effort: high
---

Produce only:

## Result
PASS / PASS WITH KNOWN LIMITATION / BLOCKED / FAIL

## Implemented / Fixed
Short factual bullets.

## Key decisions
Only material business or technical decisions.

## Validation
Commands/checks + concise PASS/FAIL evidence, including E2E status.

## Known limitations / remaining risks
Only real remaining items.

## Follow-up assessment
Only evidence-backed recommendations from product assessment, with priority/scope.
If none: `No material follow-up recommendations.`

Do not include:
- "I read..."
- "Then I..."
- progress history;
- long file-by-file narration;
- speculative improvements.

Persist to `.ai-workflow/runs/<runId>/final-report.md` and record it with
`cw artifact final-report.md`.

This is the one step that speaks to the user at length. Compress wording, never
substance: every real finding, risk and limitation stays in. Do not delegate
this to an external compression skill.

Brevity here is a property of the *wording*, not of the thinking. This step runs
at high reasoning effort on purpose: deciding which risks are real, which
limitations matter and which findings are load-bearing is the hardest judgement
in the run. A short report produced by thinking less is how a known limitation
goes unmentioned. Think hard, then write tersely.
