---
name: wf-final-report
description: Produce truthful QUICK or template-backed DETAILED engineering reports. Use on demand when the user asks for a report/báo cáo, document, summary/tổng hợp, review result, implementation/bug/impact/change/test report, handover, release note, BRD/TKCB comparison, or BA/PO/Tester/End User deliverable; full workflows also invoke it for their final response.
user-invocable: false
effort: medium
---

Separate report depth from execution depth. Task level never decides document
depth; the user's request does.

## Select the mode

Use **QUICK REPORT** when finishing engineering work and the user did not request
a detailed document. Use **DETAILED REPORT** when the user asks for a report,
detailed report, documentation, summary/review deliverable, implementation or
bug report, impact/change/test report, handover, release note, BRD/TKCB
comparison, or a document for a named audience.

A report-only request does not open or rerun an engineering workflow. Read the
available task context, diff, test output, and run artifacts; do not implement.

## QUICK REPORT

Use this stable order, omitting sections that add no value:

1. `Level`
2. `Cause / Reason`
3. `Changed`
4. `Verification`
5. `Manual verify`
6. `Remaining risk`

Keep it concise. A high-risk task can still have a short status response.

## DETAILED REPORT

Select exactly the matching source under `<runtimeDir>/templates/` (normally
`.ai-workflow/templates/`):

| Request / context | Template |
| --- | --- |
| defect investigation or fix | `bug-report.md` |
| implementation report / technical handover | `implementation-report.md` |
| completed feature | `feature-report.md` |
| pre-implementation impact assessment | `impact-analysis.md` |
| test results | `test-report.md` |
| code review | `code-review-report.md` |
| non-bug change summary | `change-report.md` |
| release note | `release-note.md` |
| BA/PO/Tester/End User/business stakeholder | `business-change-report.md` |
| label, copy, placeholder or tooltip change | `text-label.md` |
| UI change with visible behaviour | `ui-change.md` |
| styling, spacing or responsive change | `css-layout.md` |
| permission, authentication, authorization or security | `permission-report.md` |
| structural / architecture decision | `architecture-report.md` |
| behaviour-preserving refactor | `refactor-report.md` |
| research, comparison or recommendation with no code | `research-report.md` |
| documentation deliverable | `documentation-report.md` |
| the approved plan itself | `execution-plan.md` |
| one material technical decision | `decision-record.md` |

`cw mission template` prints the template the classified task type maps to. Use it
instead of defaulting to `implementation-report.md` for everything.

Read the selected template and preserve its title, heading order, terminology,
status vocabulary, and table columns. Reuse the existing project template even
if it differs from the packaged default. Do not invent a new format per task.

Audience takes precedence over technical report type. For a business-only
audience, always use `business-change-report.md`, even when the underlying work
is a bug, feature, or implementation. For a mixed business + developer audience,
use the two-part output below.

If the requested type is ambiguous, infer it from the work: defect -> bug,
implemented capability -> feature/implementation, pre-code request -> impact,
verification-only -> test, review-only -> code review, otherwise change. Ask
only when choosing the wrong audience or document type would materially change
the deliverable.

For a mixed business + developer audience, produce two clearly separated parts:

1. `Business Summary` using business language and the business template's
   relevant structure.
2. `Technical Implementation` using the appropriate technical template.

Do not put class, method, controller, repository, SQL, or low-level design detail
into a business-only report.

## Evidence and truthfulness

Use only the user request, supplied documents, current code/diff, run artifacts,
and actual verification output. Never fill a template by guessing.

- Not applicable -> write `Not applicable` or remove an optional section when
  the template permits it.
- Not run -> write `Not verified` / `Not tested`.
- Outside available scope -> write `Unknown from current scope`.
- No business behavior change -> write `No business behavior changed.`
- No evidence-backed risk or remaining issue -> do not invent one.

Keep state claims distinct:

- `Implemented` is not `Verified`.
- `Code reviewed` is not `Tested`.
- `Build passed` is not a functional test.
- `Unit test passed` is not E2E.
- `Manual verification required` is not failure.

Never run extra E2E or a full test suite to make a report look complete. Report
what was actually done and make uncovered areas visible.

Use the template-specific final vocabulary exactly:

- Test: `PASS`, `PASS WITH MANUAL VERIFICATION`, `FAIL`.
- Code review: `READY`, `READY WITH FOLLOW-UP`, `NOT READY`.
- Code review priority: `P0 — Critical`, `P1 — High`, `P2 — Medium`,
  `P3 — Improvement`.
- Completion lines may include `IMPLEMENTED`, `FIXED`,
  `TARGETED TESTS PASSED`, `MANUAL UI VERIFICATION REQUIRED`, `BLOCKED`, or
  `FAILED`, but only when supported.

## Persist when a run owns a report

Persist only when the active run is currently in a phase that declares
`final-report.md` (normally the full workflow's `report` phase). Write the
rendered content — not the source template — to
`<runtimeDir>/runs/<runId>/final-report.md`, then run
`cw artifact final-report.md`.

If a report/status is requested while another phase or gate is current, return
it read-only from available evidence. Do not advance phases, write an undeclared
artifact, or bypass a gate merely to save the report. With no active run, return
the document directly and do not fabricate runtime state.

Return only the report. Do not include an execution diary or describe template
selection mechanics.
