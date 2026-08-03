---
name: feature-change
description: Execute the controlled feature/change workflow for requirement, design, database or code inputs that may conflict or be outdated. Reconcile evidence, obtain a clear business decision, plan impact/risk/scope/tests, reuse conventions, implement, validate E2E, review, assess product issues, and report.
disable-model-invocation: true
argument-hint: "[desired outcome + requirement/design/DB/code inputs]"
effort: high
---

Invoke `wf-feature-change` and execute it for `$ARGUMENTS`.

This entry point exists so the full workflow is only started when the user asks
for it. The workflow body lives in `wf-feature-change` so that `work` can route
to the same body without going through a user-only skill.
