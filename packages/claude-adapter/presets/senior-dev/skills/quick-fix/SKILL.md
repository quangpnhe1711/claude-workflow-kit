---
name: quick-fix
description: Execute the short workflow for a small, explicitly specified change or bug fix. Triage the narrow code path, make the smallest correct change, validate focusedly, report in three lines. Escalates to bug-fix or feature-change only on concrete evidence.
disable-model-invocation: true
argument-hint: "[the small fix, with its expected result]"
effort: medium
---

Invoke `wf-quick-fix` and execute it for `$ARGUMENTS`.

The user chose the quick path deliberately. Start on it. Do not convert it into a
full workflow during triage — only concrete evidence found while investigating
may escalate it.

This entry point exists so the short workflow is only started when the user asks
for it. The body lives in `wf-quick-fix` so that `work` can route to the same
body without going through a user-only skill.
