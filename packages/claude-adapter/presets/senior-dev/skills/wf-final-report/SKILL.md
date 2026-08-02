---
name: wf-final-report
description: Internal final reporting step that produces a compact evidence-focused completion report without narrating routine work.
user-invocable: false
effort: low
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

If `caveman:caveman-compress` is available, use it for the user-facing version
of this report. Otherwise keep the compact format above unchanged.
