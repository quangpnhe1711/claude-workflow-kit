---
name: work
description: Route an engineering task to the correct project workflow. Use when the user provides a task but is unsure whether to run quick-fix, bug-fix or feature-change.
disable-model-invocation: true
argument-hint: "[task + inputs]"
effort: high
---

Classify `$ARGUMENTS` using evidence, not keyword matching.

**Start with the cheapest safe workflow.** Escalation later is normal and cheap;
running a ten-phase workflow over a one-line change is not.

Route by invoking the workflow body directly:

- Explicit request, narrow-looking scope, clear expected result, no known DB
  migration, no known business ambiguity, no known contract change
  -> invoke `wf-quick-fix`.
- Existing behavior is wrong/broken and the expected behavior is known or
  inferable, but the cause is not obvious -> invoke `wf-bug-fix`.
- New capability, business-rule change, redesign, or requirement/document-driven
  change -> invoke `wf-feature-change`.

Do not demand proof of all of the quick-fix conditions through broad analysis
before choosing it. Start narrow; `wf-quick-fix` escalates itself when
investigation finds a real reason to.

Examples that route `wf-quick-fix`:
- "Cho MNG hiển thị nút tạo Action; BE đã support."
- "Fix duplicate import trong comm-line-chips."
- "`--skip-mcp` vẫn check Python."
- "Popup user picker che Submit."

Examples that do **not**:
- "Thiết kế lại luồng Action cho nhiều phòng." -> `wf-feature-change`.
- "Cho phép sửa Liên lạc" when several communication types exist and scope is
  unspecified -> `wf-feature-change`.
- "Thay đổi cách permission của MNG hoạt động toàn module."
  -> `wf-feature-change`.

If the task contains both a defect and a business change, choose the workflow
that owns the primary business change and treat the defect as evidence within it.

Route to `wf-quick-fix` / `wf-bug-fix` / `wf-feature-change`, never to
`quick-fix` / `bug-fix` / `feature-change`: those are user entry points and
cannot be invoked by the model.

Do not create a fourth ad-hoc workflow.

If classification itself changes what inputs are required and cannot be
resolved from the supplied task, ask one concise question. Otherwise invoke the
selected workflow with the original arguments.

The selected workflow opens the run with `cw run start`. Do not open one here.
