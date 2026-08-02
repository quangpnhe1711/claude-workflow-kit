---
name: work
description: Route an engineering task to the correct project workflow. Use when the user provides a task but is unsure whether to run bug-fix or feature-change.
disable-model-invocation: true
argument-hint: "[task + inputs]"
---

Classify `$ARGUMENTS` using evidence, not keyword matching.

Route:
- Existing behavior is wrong/broken and expected behavior is known or inferable -> invoke `bug-fix`.
- New capability, business-rule change, redesign, or requirement/document-driven change -> invoke `feature-change`.
- If the task contains both, choose the workflow that owns the primary business change and treat the defect as evidence within it.

Do not create a third ad-hoc workflow.

If classification itself changes what inputs are required and cannot be
resolved from the supplied task, ask one concise question. Otherwise invoke the
selected workflow with the original arguments.

The selected workflow opens the run with `cw run start`. Do not open one here.
