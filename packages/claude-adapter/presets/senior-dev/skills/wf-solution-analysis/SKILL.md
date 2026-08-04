---
name: wf-solution-analysis
description: Internal analysis-only workflow body that parses free-form intake, reconciles business behavior with the current repository, measures impact, compares source-aligned solutions, creates the six required handoff artifacts, and stops at ANALYSIS_READY for explicit approval. Never implement product code.
user-invocable: false
effort: high
---

Open or continue one `solution-analysis` run. Report semantic transitions with
`cw`; never edit `state.json`.

```text
cw run start solution-analysis --label "<short analysis label>"
cw phase enter intake
```

## Smart intake

Parse the user's text into:

```text
goal
business_behavior
scope
constraints
acceptance_criteria
open_questions
assumptions
```

Infer from supplied evidence and nearby source. Ask only when an unresolved
choice materially changes expected behavior, a business rule, solution
direction, or scope. Show the structured understanding and stop for confirmation
only in that case. Do not ask for information source or conventions can resolve.

When the intake is actionable:

```text
cw phase complete
cw phase enter analysis
```

## Read-only analysis

Do not edit product source, tests, configuration, schema, or migrations. Only
read the repository, read valid convention cache, and write declared run
artifacts. Run `cw conventions status`; reuse valid areas and refresh only a
missing/stale relevant area through the existing convention mechanism.

Establish:

1. Business intent, actors, rules, expected behavior, edge cases, acceptance.
2. Current flow, architecture, conventions, reusable components, constraints.
3. Direct/downstream, data/DB, API, permission, compatibility, and regression impact.
4. At least two credible solutions when alternatives genuinely exist.
5. Complexity, compatibility, maintainability, migration/data risk, regression
   risk, and codebase fit for every option.
6. Recommended solution, implementation sequence, and proportional test strategy.

Use the matching files in `<runtimeDir>/templates/` and write all six files into
`<runtimeDir>/runs/<runId>/`:

```text
business-analysis.md
impact-analysis.md
solution-options.md
recommended-solution.md
implementation-plan.md
test-strategy.md
```

Never omit a file. For a non-applicable section write:

```text
Not applicable
Reason: <evidence-based reason>
```

`recommended-solution.md` is the handoff source of truth and must contain:
Chosen solution, Why chosen, Rejected alternatives, Trade-offs, Assumptions,
User decisions, and Approved scope.

Record each artifact with `cw artifact <filename>`. Gather the project-relative
paths of every source file that materially supports the analysis, then run:

```text
cw analysis ready --source "path/one.ts,path/two.ts"
```

This validates the contract, snapshots source hashes, publishes a readable copy
of the six files into the reported `report` directory (`docs/analysis/<run>/` by
default), moves the run to `ANALYSIS_READY`, and parks it for approval.

Present a compact business understanding, impact, options, recommendation,
proposed scope, open decisions, and the published `report` path. Then call
`PushNotification` saying the analysis is ready and approval is required. Then
stop. Do not call feature-change and do not write product code.

