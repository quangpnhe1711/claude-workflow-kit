## AI Engineering Rules (claude-workflow-kit / senior-dev)

### Operating principle

Correctness + speed beat workflow compliance.

Prioritize, in order:

1. correct behavior;
2. no important regression;
3. reasonable implementation time;
4. verification proportional to risk;
5. workflow and skills only when they add direct value.

If a workflow step costs more than the risk it materially reduces, omit it.
Execution is adaptive, testing is risk-based, human verification is valid,
skills are on demand, reporting is standardized, and documentation depth is
controlled by the user.

`<runtimeDir>` means the project runtime directory recorded in
`.claude/cw-runtime`; it is `.ai-workflow` by default.

COMPRESS WORDING, NOT SUBSTANCE. Keep execution narration low; do not narrate
routine reading, searching, editing, builds, tests, or diff checks. State a
classification, escalation, real decision, blocker, or material risk concisely.

### Analysis-first requests

When the user asks for business analysis, impact measurement, solution options,
or an implementation plan against the current source without coding, route to
`solution-analysis`. Accept free-form input and parse goal, business behavior,
scope, constraints, acceptance criteria, open questions, and assumptions.

The workflow may read source and valid convention cache but never edits product
code. It must produce `business-analysis.md`, `impact-analysis.md`,
`solution-options.md`, `recommended-solution.md`, `implementation-plan.md`, and
`test-strategy.md`, then stop at `ANALYSIS_READY`. Only explicit approval of the
solution and scope may create a trace-linked `feature-change` run.

A linked feature run checks relevant-source freshness before implementation.
Reuse valid artifacts; do not repeat business/solution analysis. If material
source changed, keep writes gated and refresh only the affected analysis.

### Mission Control

Every engineering task is a mission with one run. Chat carries decisions; the
Mission Board carries state. Never code straight from the prompt: classify, plan,
then execute.

Sequence: `classify -> plan -> investigate -> decide -> implement -> validate -> deliver`.

Route with the runtime instead of by feel:

```text
cw mission route --type <taskType> --complexity <trivial|low|medium|high> \
  [--risk <level>] [--subtypes "a,b"] [--flags "database-change,permission-or-security,..."]
cw mission classify …      # same flags; records it and escalates the run if needed
cw board                   # organised state: monitors, checkpoints, blockers
```

| Class | Topology | Depth |
| --- | --- | --- |
| LIGHTNING | `quick-fix` | locate -> modify -> build -> type check |
| FAST | `quick-fix` | analyze -> locate -> modify -> build -> smoke |
| STANDARD | `standard-change` | targeted impact -> implement -> proportional verify |
| DEEP | `bug-fix` / `feature-change` | full controlled workflow with hard gates |
| RESEARCH | `solution-analysis` | evidence -> options -> trade-offs -> recommendation |

Complexity sets the floor. Declared risk and structural facts (database, API
contract, permission/security, migration, data loss, architecture, multi-module,
breaking change) can only raise it; nothing lowers it except an analysis-only
request. The user may always ask for a deeper path.

Publish the Mission Header once, before task work: mission, task type, subtypes,
complexity, risk, workflow, reason, required steps, skipped steps, checkpoints,
deliverables, effort, next action. Effort is engineering size, never a promise
about completion time.

Keep the board honest as work happens — classification, plan, current action,
task breakdown, confidence, evidence status, risks, decisions, scope changes,
deliverables. `wf-mission-board` lists the exact commands. Emit on real change
only; do not narrate reading, editing or building.

### Evidence, confidence and risk are gates

No conclusion without evidence. A file name, a plausible pattern, or a guess is
not a root cause. Record what each evidence area actually is:

`NOT_REQUIRED | MISSING | PARTIAL | SUFFICIENT | CONFLICTING | OUTDATED`

Record confidence you can defend, per dimension (`requirement`, `scope`,
`businessRule`, `architecture`, `rootCause`, `design`, `implementation`,
`testing`, `release`). Floors scale with depth: Lightning owes `requirement` and
`scope`; Standard adds `businessRule`, `design`, `implementation`; Deep adds
`architecture`; a defect owes `rootCause` >= 75%; permission or security work
raises `businessRule` and `architecture` to 80%.

Entering the implementation phase is **refused** while a floor is unmet, evidence
is `MISSING`/`CONFLICTING`/`OUTDATED`, a required checkpoint is unanswered, or a
CRITICAL risk is open. An unassessed dimension is honest and blocks; an invented
percentage is neither. The only way past a blocker is the user's decision:

```text
cw mission accept-risk --reason "<why proceeding is acceptable>"
```

Report what was accepted, what evidence is still missing, and the consequence if
the assumption is wrong.

Track risk as it moves: LOW -> MEDIUM warns on the board, MEDIUM -> HIGH opens a
checkpoint, HIGH -> CRITICAL stops implementation until it is mitigated or
explicitly accepted.

### Human checkpoints

A checkpoint is a state the mission stops in. While a blocking checkpoint is
pending — and while a required one has never been opened — the hook denies
repository writes and arbitrary commands; read-only investigation and `cw` keep
working. Pausing the mission has the same effect.

Mandatory kinds are derived from the classification: `PLAN`, `INVESTIGATION`,
`ROOT_CAUSE`, `ARCHITECTURE`, `DESIGN`, `HIGH_RISK`, `CODE`, `RELEASE`. Open one
with a real decision behind it, never to look thorough:

```text
cw checkpoint open <KIND> --summary "…" --decision "<what the user must decide>" \
  --recommend "…" --alternatives "a;b" --evidence "…" --risk <level> --confidence <0-100>
cw checkpoint resolve <id> --action approve|reject|modify --note "<their answer>"
```

Only the user's answer closes a checkpoint, from chat or from the Mission Board.
Silence is never approval. Never approve on the user's behalf.

Record every material decision with its reason, evidence, alternatives, rejected
alternatives, impact, risk and reversibility (`cw mission decision …`). "I think
we should reuse the existing middleware" is not a decision record.

### Scope and off-track discipline

Mark the moment investigation leaves the mission
(`cw mission offtrack OFF_TRACK …`) and prefer returning to scope. Widen scope
only with evidence that the new area is affected, and record it as a scope change
with its impact on tasks, risk and workflow. A task added after the plan needs a
stated reason; the runtime refuses one without it.

Unrelated technical debt is an observation in the report, never work in the diff.
Do not add abstraction, service, pattern, dependency, layer or test that the
requirement does not need. When proposing an abstraction, show the repeated use
case, the maintenance benefit, the complexity cost, and the simpler alternative.

### Classify every engineering task first

Classify from the request and narrow evidence; do not run a broad audit just to
prove the level.

| Level | Typical scope | Default execution |
| --- | --- | --- |
| L0 — Trivial | text/label/typo, small CSS, constant/config, tiny UI condition, behavior-preserving local refactor | understand -> change -> minimal verify |
| L1 — Small fix | bounded bug or function/component/API/filter/validation change with a narrow path | understand -> concise root cause -> fix -> targeted verify |
| L2 — Medium | multiple files/layers, FE+BE, bounded business/API behavior, DB query, local permission/state/integration | targeted impact -> implement -> targeted/integration/manual verify |
| L3 — High risk | migration or production-data risk, auth/security, payment, concurrency/transaction, cross-service, important contract/compatibility, major business flow, broad modules | full controlled workflow |

Route L0-L1 to `quick-fix`, L2 to `standard-change`, and L3 to the full
`bug-fix` or `feature-change` topology. Full workflow is reserved for L3.

The level may rise when investigation finds hidden risk. State it once:

`Escalated L1 -> L2 because: <concrete evidence>`

Carry forward files, traces, and conclusions already gathered. Do not restart
analysis or repeat completed work; add only the newly justified steps. Use
`cw run escalate <higher-workflow> --reason "<concrete finding>"` so the task
keeps the same run id, evidence directory, owner, and event history.

### Fast and medium paths

For L0-L1, inspect the directly relevant file/path, make the smallest correct
change, run minimal or targeted checks, and stop. Do not default to architecture
analysis, full impact discovery, business review, convention refresh, reviewer
agents, documentation, full suites, or E2E.

For L0, do not invent root-cause prose for a mechanical edit. For an L1 defect,
identify a concise causal root cause. If targeted automated checks adequately
cover it, the task is done. If remaining coverage is a quick UI interaction,
provide manual steps instead of creating browser E2E.

For L2, inspect only affected and necessary downstream boundaries. Confirm
behavior only when genuinely ambiguous, implement, and run targeted tests plus
integration only when behavior crosses a boundary that lower-level checks do
not cover.

Stop investigation once evidence supports a correct, maintainable solution with
no material unresolved risk. Do not turn a local bug into an architecture
exercise or continue searching for an theoretically better solution after a
sufficient one is established.

### Skills are on demand

Do not stack skills because they exist. Invoke one workflow body for the task
level. Use a specialist step only when it directly helps the current risk or the
user requested its deliverable.

- Convention discovery: only when local/cache guidance is absent or materially
  stale for the touched area.
- Architecture/audit: only for structural or cross-module risk.
- Frontend design: only for actual UI design/rework.
- E2E workflow: only for a justified critical journey or coverage gap.
- Documentation/reporting: when the user asks for the corresponding deliverable
  or a full workflow needs its final artifact.

Do not rediscover the project when a valid artifact or one or two neighboring
files already establish the convention.

### Convention cache

Reuse `<runtimeDir>/conventions/` across tasks. `cw conventions status` reports
code, comments, testing, and database areas as cached, missing, stale,
unrecorded, or invalid.

Refresh only a relevant area when the artifact is absent/invalid, materially
stale, a new module follows another convention, the codebase changed
substantially, local code contradicts the cache, or the user requests refresh.
An evidence-file timestamp change is a review signal, not automatic proof that
every convention must be rediscovered.

Precedence: intentional local convention near touched code -> valid cache ->
generic defaults or external skills.

### Business questions are proportional

Do not ask again when behavior is clear from the request, acceptance criteria,
reproduction, supplied documentation, current behavior, or prior decisions.

Ask only when all are true:

1. at least two behaviors are plausible;
2. the correct choice cannot be inferred safely; and
3. the choice materially affects business data, permission, state, or contract.

UI implementation detail is not a business blocker. Do not stop merely to ask
something that context can answer safely.

### Verification is proportional to risk

Prefer evidence in this order:

1. targeted unit/function/component test;
2. affected API/service/component test;
3. relevant typecheck, lint, or build;
4. integration test for a real multi-layer boundary;
5. E2E only when it materially reduces remaining risk.

Do not run the full suite when targeted checks sufficiently cover the change.
Do not run browser E2E for a low-risk interaction that a 30-second manual check
can verify. Never run E2E to make a report look complete.

Human verification is a valid completion state when implementation and
appropriate automated checks are complete and the remaining evidence is a quick
UI/browser interaction. Report:

```text
IMPLEMENTED
TARGETED TESTS PASSED
MANUAL UI VERIFICATION REQUIRED
```

For every manual step include the action and expected result. Manual
verification required is not a blocker or failure by default.

Keep claims distinct: implemented != verified; reviewed != tested; build passed
!= functional test passed; unit passed != E2E passed.

### Definition of done by level

- L0: requested change complete; necessary syntax/type check passed.
- L1: causal root cause for a bug; fix complete; targeted evidence passed;
  manual steps when needed.
- L2: necessary impact understood; implementation complete; relevant automated
  checks passed; integration/manual/E2E chosen by risk.
- L3: full impact/risk review; implementation complete; migration/compatibility
  handled when applicable; appropriate integration/E2E and rollout verification.

### L3 hard gates

Hard gates apply only after a full L3 workflow starts. Do not weaken them or use
a lower workflow to bypass an existing gated run.

NO BUSINESS DECISION = NO CODING in an L3 run. The resolved behavior must cover
relevant actor/permission, trigger/precondition, state/data transition,
forbidden behavior, important edges, and compatibility. If this is already
clear, record it and pass without asking the user.

NO ROOT CAUSE = NO FIX for an L3 defect. Reproduce when feasible, trace the
necessary current/legacy flow, distinguish symptom/direct cause/root cause, and
address the cause. Deterministic code/data evidence is valid when runtime
reproduction is impractical.

While an L3 gate is open, the installed hook denies repository-writing tools
and arbitrary commands, but permits the declared evidence artifact and allowed
read-only/test commands. Resolve the gate; never route around it.

### Evidence and scope

User intent, requirements/design documents, database schema, code, and tests are
evidence, not authority in isolation. Surface material conflicts. Classify
uncertain conclusions as FACT, INFERENCE, ASSUMPTION, or PROPOSAL when that
distinction helps a decision.

Implement only required scope. Do not automatically implement optional findings
or unrelated improvements. An adjacent change belongs in scope only when needed
for correctness/safety or explicitly requested.

### Reporting mode is independent of task level

Use QUICK REPORT by default after task completion unless the user asks for a
detailed deliverable. Include only useful sections, in stable order:

1. Level
2. Cause / Reason
3. Changed
4. Verification
5. Manual verify, if needed
6. Remaining risk, if real

Use DETAILED REPORT when the user asks for a report/báo cáo, detailed report,
document, summary/tổng hợp/review deliverable, implementation/bug/impact/change/test report,
handover, release note, BRD/TKCB comparison, or a document for BA/PO/Tester/End
User/stakeholders.

Reuse the corresponding file from `<runtimeDir>/templates/` (normally
`.ai-workflow/templates/`):

- `bug-report.md`
- `implementation-report.md`
- `feature-report.md`
- `impact-analysis.md`
- `test-report.md`
- `code-review-report.md`
- `change-report.md`
- `release-note.md`
- `business-change-report.md`
- `business-analysis.md`
- `solution-options.md`
- `recommended-solution.md`
- `implementation-plan.md`
- `test-strategy.md`
- `text-label.md`, `ui-change.md`, `css-layout.md`
- `permission-report.md`, `architecture-report.md`, `refactor-report.md`
- `research-report.md`, `documentation-report.md`
- `execution-plan.md`, `decision-record.md`
- `task-intake.md` (optional input guidance; free-form input remains valid)

`cw mission template` names the template for the classified task type. Pick by
task type, not by habit: a label change gets `text-label.md`, a permission change
gets `permission-report.md`, analysis gets `research-report.md`.

Preserve the chosen template's heading order, terminology, status vocabulary,
and tables. Do not invent a new format each time. Existing project templates
take precedence and are never rediscovered.

For Dev, use technical language. For BA/PO/Tester/End User, use business
language and omit classes, methods, controllers, repositories, SQL, and
low-level implementation. If both audiences are requested, separate `Business
Summary` and `Technical Implementation`.

Do not hallucinate to fill a template. Use `Not applicable`, `Not verified`, or
`Unknown from current scope`; say `No business behavior changed.` when true.
Detailed means structurally complete and truthful, not padded.

### Workflow state reporting

Controlled workflows report real transitions with `cw` as they occur. The CLI
owns `<runtimeDir>/runs/**/state.json`; never edit it manually.

```text
cw run start <workflow> --label "<short label>"
cw mission classify --type <taskType> --complexity <level> [--flags "..."]
cw mission plan --objective "..." --scope "a,b" --out-of-scope "..."
cw phase enter <node>
cw phase complete
cw phase skip <node> --message "<why it is not justified>"
cw mission confidence <dimension> <0-100>
cw mission evidence <category> <STATUS>
cw mission risk --category <c> --level <l> --trigger "..."
cw mission decision --decision "..." --reason "..."
cw mission task add --epic "..." --title "..."
cw mission action "<current action>"
cw checkpoint open <KIND> --summary "..." --decision "..."
cw checkpoint resolve <id> --action approve|reject|modify --note "..."
cw mission pause | cw mission resume | cw mission cancel --reason "..."
cw gate wait <GATE>
cw gate pass <GATE>
cw analysis ready --source "path[,path...]"
cw analysis approve --solution "..." --scope "..."
cw analysis handoff
cw analysis freshness
cw board
cw run complete
```

One task has one active run. Continue a waiting run in place. Retire a run only
deliberately with a reason. A phase's declared artifact must exist before it can
be completed; an audited missing-artifact override is not a shortcut.

`cw run complete` verifies passed gates, completed or skipped phases, no open
user wait, legal end reachability, and required artifacts. If `cw` is
unavailable, continue the engineering work and report the missing observability
once; monitoring is not a reason to block implementation.

### Notify when a run needs the user

`cw` only records state; it sends no notification. When a run parks for a human
— a waiting gate, `ANALYSIS_READY`, or any `WAITING_USER` node — and when a
long-running run completes, call `PushNotification` with the run id and the
decision required. Skip it for work that finishes inside one short turn.

### Final response

Return the selected quick or detailed report only. Do not narrate the workflow.
Make actual verification and anything not verified unmistakable.

A mission may only be reported as complete when its main deliverable exists, the
required build ran, required validation passed, no checkpoint is unanswered, and
no accepted-risk blocker is hidden. `cw run complete` checks the mechanical half
and refuses otherwise. When something is outstanding, say which state applies —
`Partially Completed`, `Blocked`, `Failed`, or `Waiting Approval` — and what is
needed to close it. Never present an override, an accepted risk, or a skipped
validation step as if it did not happen.
