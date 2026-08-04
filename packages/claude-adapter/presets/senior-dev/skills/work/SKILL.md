---
name: work
description: Classify an engineering task by risk as LEVEL 0, 1, 2, or 3 and route it to the cheapest safe workflow. Use when the user provides a task but does not want to choose between the fast, medium, or full controlled path. Route report-only requests directly to standardized reporting.
disable-model-invocation: true
argument-hint: "[task + inputs]"
effort: medium
---

Classify `$ARGUMENTS` before doing task work. Use evidence available in the
request and nearby scope; do not perform a broad audit merely to classify.

## Analysis-only request

If the user asks to analyze business behavior, measure impact, compare/select a
solution, or produce a plan against the current source without implementation,
invoke `wf-solution-analysis`. Free-form input is valid: parse goal, behavior,
scope, constraints, acceptance criteria, open questions, and assumptions. Do
not route this request to report-only merely because its output is a document.

An explicitly approved solution-analysis handoff routes to
`wf-feature-from-analysis`; it does not restart normal feature discovery.

## Report-only request

If the user asks only to report/báo cáo, summarize/tổng hợp, review results, document existing
work, create a handover/release note, or compare supplied business documents —
and does not ask for implementation — invoke `wf-final-report`. Do not open an
engineering workflow.

## Task levels

- **L0 — Trivial:** text/label/typo, small CSS, constant/config, tiny condition,
  or behavior-preserving local refactor with obvious scope.
- **L1 — Small fix:** bounded bug or component/function/API/filter/validation
  change with a narrow reproducible path and low regression risk.
- **L2 — Medium:** multiple files or layers, FE+BE, a bounded local business or
  API behavior change, DB query, permission/state logic, or integration within a
  clear boundary.
- **L3 — High risk:** schema/data migration, production-data risk,
  authentication/authorization/security, payment, concurrency/transaction,
  cross-service behavior, important compatibility or contract change, major
  business flow, or broad multi-module impact.

Route exactly one workflow body:

- L0-L1 -> `wf-quick-fix`
- L2 -> `wf-standard-change`
- L3 defect -> `wf-bug-fix`
- L3 feature/business change -> `wf-feature-change`

Do not route by words such as "bug" or "feature" alone. Do not stack workflow
skills. A selected workflow may escalate later on concrete evidence and must
carry forward what it already learned.

Typical examples:

- Rename a label, adjust spacing, remove a duplicate import -> L0.
- Fix one validation condition or a known component bug -> L1.
- Change a bounded FE + API flow or local permission/state rule -> L2.
- Add a migration, change authentication, payment, transactions, or a critical
  public contract -> L3.

Ask no classification question unless the answer changes the required inputs or
would choose materially different data/permission/contract behavior. Otherwise
make the safest reasonable inference and start.

Tell the selected body the level and pass the original task unchanged. The body
opens the run with `cw run start`; do not open one here.
