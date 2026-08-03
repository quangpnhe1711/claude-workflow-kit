---
name: bug-fix
description: Execute the controlled bug-fix workflow: reproduce, trace legacy/current code, identify root cause, resolve business behavior, plan, impact/risk/scope, test strategy, convention reuse, implementation, validation, E2E, review, product assessment, and concise report.
disable-model-invocation: true
argument-hint: "[bug + reproduction + expected/actual]"
effort: high
---

Invoke `wf-bug-fix` and execute it for `$ARGUMENTS`.

This entry point exists so the full workflow is only started when the user asks
for it. The workflow body lives in `wf-bug-fix` so that `work` can route to the
same body without going through a user-only skill.
