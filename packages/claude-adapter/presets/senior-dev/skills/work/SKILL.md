---
name: work
description: Mission Control router. Classify an engineering task by type, complexity and risk, pick the shortest safe workflow (Lightning, Fast, Standard, Deep, Research), publish the Mission Header, and route to exactly one workflow body. Use when the user hands over a task without choosing a path.
disable-model-invocation: true
argument-hint: "[task + inputs]"
effort: medium
---

Classify `$ARGUMENTS` before doing task work. Use the request and nearby evidence
only; never run a repository audit to produce a classification.

## 1. Classify

Pick one **primary task type** and any real subtypes from:

`ui-change ux-change text-label css-layout bug-fix validation crud api-change
small-feature medium-feature large-feature security permission authentication
authorization database migration cache notification export import integration
performance refactor architecture research documentation devops build
configuration testing release`

Pick a **complexity**:

- `trivial` — one file or one obvious location, no business logic, no API, no
  database, no permission effect.
- `low` — one module, simple logic, clear scope, local change.
- `medium` — several files or layers, a business rule, FE+BE, an API contract, or
  effects across more than one flow.
- `high` — several modules, architecture, large database change, permission or
  security, wide refactor, migration, backward compatibility, hard rollback.

Declare the **structural flags** that are actually true (these drive mandatory
checkpoints, so do not guess them and do not pad them):

`database-change api-contract-change permission-or-security migration
backward-compatibility data-loss-risk production-impact multi-module
architecture-change analysis-only review-before-apply deployment
cache-invalidation breaking-change multiple-solutions`

## 2. Route

Ask the runtime rather than deciding depth by feel:

```text
cw mission route --type <taskType> --complexity <trivial|low|medium|high> \
  [--risk <none|low|medium|high|critical>] [--subtypes "a,b"] [--flags "a,b"]
```

It answers with the workflow class, the topology, the mandatory checkpoints, the
validation steps that apply, the steps that are skipped, the confidence
thresholds, and the report template. Complexity sets the floor; risk and the
structural flags can only raise it.

| Class | Body skill | Typical work |
| --- | --- | --- |
| LIGHTNING | `wf-quick-fix` | label, copy, CSS, spacing, icon, static content |
| FAST | `wf-quick-fix` | small validation, small CRUD/API, bounded defect |
| STANDARD | `wf-standard-change` | multi-file or multi-layer bounded change |
| DEEP | `wf-bug-fix` (defect) / `wf-feature-change` | permission, security, migration, architecture, wide refactor |
| RESEARCH | `wf-solution-analysis` | analyse, compare, recommend; no code |

Report-only requests — report/báo cáo, summary/tổng hợp, review of finished work,
handover, release note, document comparison — go straight to `wf-final-report`.
Do not open an engineering workflow for them.

An approved solution-analysis handoff routes to `wf-feature-from-analysis`; it
never restarts feature discovery.

## 3. Publish the Mission Header

Answer with this block, once, before any task work:

```text
Mission: <one sentence>
Task type: <primary>   Subtypes: <list or none>
Complexity: <level>   Risk: <level>
Workflow: <class> (<topology>)
Reason: <why this depth, one line>
Required steps: <from the router>
Skipped steps: <from the router>
Checkpoints: <mandatory checkpoints, or none>
Deliverables: <what the user will receive>
Effort: <VERY_SMALL..VERY_LARGE — engineering effort, not a completion promise>
Next action: <the immediate next step>
```

Ask a classification question only when the answer changes the required inputs or
selects materially different data, permission or contract behavior. Otherwise
make the safest reasonable inference and start.

## 4. Hand over

Invoke exactly one body skill. Pass the original task unchanged, plus the
classification and flags. The body opens the run and records the classification:

```text
cw run start <topology> --label "<short label>"
cw mission classify --type <taskType> --complexity <level> [--flags "..."] [--risk <level>]
```

Do not open the run here, do not stack workflow skills, and do not route on the
words "bug" or "feature" alone. A body may escalate later on concrete evidence
and must carry forward what it already learned.
