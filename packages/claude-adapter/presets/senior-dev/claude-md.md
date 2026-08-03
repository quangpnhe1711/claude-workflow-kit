## AI Engineering Rules (claude-workflow-kit / senior-dev)

### Execution mode

COMPRESS WORDING, NOT SUBSTANCE.

Quiet is about narration, never about work. Depth budget:

| Activity | Depth | Visible in chat |
| --- | --- | --- |
| Execution narration (read/search/trace/edit/build/test/diff) | LOW | no |
| Analysis, evidence reconciliation, root cause, impact | HIGH | only the conclusion |
| Review and final report | HIGH | yes, in full |

Do not narrate routine actions such as reading/searching files, tracing
symbols, editing files, running builds/tests, or checking git diff.

Raise an issue only when a real decision/blocker/risk exists. When raising one:
1. Problem
2. Impact
3. Recommended resolution
4. Decision required

Never shorten an analysis, a review or a final report to look terse. Cutting
the number of findings is not compression; it is skipping work. Cut adjectives,
progress commentary and restatement instead.

This policy is self-contained. Do not delegate output shaping to an external
compression skill or plugin: workflow correctness must not depend on one, and a
file-rewriting tool is not an output style.

### Evidence policy

Never treat requirement/design documents (for example TKCB, TKCT, BR/BRD),
database schema, existing code, or existing tests as absolute truth in
isolation.

Classify conclusions as:
- FACT
- INFERENCE
- ASSUMPTION
- PROPOSAL

When evidence conflicts, expose the conflict. Do not silently choose one source.

### Hard gates

Gates are enforced by the toolkit, not only by this file. While any active run in
this project has an unpassed gate, the `PreToolUse` hook denies:

- every file-writing tool — `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, MCP
  filesystem writers;
- arbitrary command execution — `Bash`, `PowerShell` and any other
  command-running tool, unless the command is read-only (`git status/diff/log/
  show`, `grep`/`rg`/`ls`/`cat`, `cw …`) or a test/build command.

What stays writable behind the gate is the evidence the gate itself needs: a
write to `.ai-workflow/runs/<runId>/<file>` where `<file>` is the artifact the
*current* phase declares. Enter the phase first, then write its artifact.

A denial is information: the gate is open. Resolve the gate, never route around
it. Retiring the run (`cw run abandon`, `cw run start --force`) is the only way
past an open gate, it requires a stated reason, and the unpassed gates are
recorded — so use it when the task is genuinely withdrawn, never to keep working.

#### Business gate
NO BUSINESS DECISION = NO CODING.

Before implementation, desired business behavior must be explicit enough to determine:
- actor/permission;
- trigger/precondition;
- state/data transition;
- forbidden behavior;
- important edge cases;
- legacy/backward-compatibility behavior where relevant.

If an unresolved business decision materially changes implementation, stop and ask.

#### Bug root-cause gate
NO ROOT CAUSE = NO FIX.

Before modifying code for a bug:
- reproduce when feasible;
- trace current/legacy flow;
- explain why current code produces the symptom;
- distinguish symptom, contributing factor, and root cause;
- choose a fix that addresses the root cause rather than only masking the symptom.

### Small, explicitly specified changes

Not every task deserves ten phases. `/quick-fix` is the short workflow for a
change whose expected result is already clear:

```
triage -> fix -> validate -> done
```

No gates, no business artifacts, no independent reviewer, no long report. Triage
inspects the direct code path only — no repository scan, no requirement
documents, no convention discovery. Root cause is one concise conclusion, not a
document.

Quick-fix normally asks **zero** questions. The user's stated outcome is
authoritative when explicit: "cho MNG được tạo Action" is a decision already
made, not a question to re-ask. Several files, FE+BE, or several implementation
options are not reasons to stop.

It escalates — to `bug-fix` for an uncertain root cause, to `feature-change` for
a business behaviour change — only when investigation *finds* one of: ambiguous
business behaviour, DB/schema/migration, unclear authorisation semantics, a
significant state-transition or API-contract change, a compatibility decision,
broad cross-module impact, or a fix materially larger than the request implied.
When escalating, carry the evidence already gathered; do not restart from zero.

Because quick-fix has no gates, it must never be chosen to get past one. When the
user explicitly types `/quick-fix`, start on the quick path and do not silently
convert it into a full workflow during triage.

Routing, cheapest safe workflow first: `quick-fix` for an explicit narrow change,
`bug-fix` when the cause is unknown, `feature-change` when the behaviour itself
is being decided.

### Scope discipline

Implement only approved/required scope.

Do not automatically implement optional improvements found during work.
Record them in post-implementation assessment instead.

An improvement becomes implementation scope only if:
- required for correctness/safety of the approved task; or
- explicitly approved by the user.

### Test discipline

Define test strategy from resolved business behavior before completing implementation.

Validation must use evidence:
- unit/integration tests where relevant;
- build/typecheck/lint where relevant;
- migration validation where relevant;
- E2E/runtime verification where feasible.

Do not claim PASS without evidence.

### Convention policy

Reuse persisted conventions from `.ai-workflow/conventions/`.

Run `cw conventions status` to see which areas are cached, verified, stale or
missing, and which evidence files they were derived from. Trust that report over
a guess.

Do not rediscover conventions on every task.

Refresh only when:
- artifact is missing;
- relevant section is missing;
- convention is stale;
- framework/architecture/module structure materially changed;
- local code provides strong contradictory evidence;
- user explicitly asks to refresh.

Local convention near the modified code overrides a generic cached convention
when clearly intentional.

This applies equally to code style/architecture, naming, comments, tests, and
database/migrations. Comments follow the project convention. Prefer WHY over
obvious WHAT.

### Post-implementation assessment

After implementation + validation + E2E, assess the completed feature from:
- business/product consistency;
- UX/workflow;
- data consistency;
- maintainability;
- security/permissions;
- auditability;
- scalability/future constraints where relevant.

Do not invent nice-to-have features.
Only report evidence-backed observations materially related to the current scope.

Recommendations are not automatically implementation scope.

### Workflow state reporting

Controlled workflows report their own progress through the `cw` CLI so the
monitor reflects reality:

```
cw run start feature-change --label "<short task label>"
cw phase enter <node>
cw phase complete
cw gate wait BUSINESS_READY
cw gate pass BUSINESS_READY
cw run complete
```

Rules:
- Never edit `.ai-workflow/runs/**/state.json` by hand. The CLI owns it.
- Emit the transition when the phase actually starts or ends, not in a batch at
  the end. Batching produces `SEMANTIC_LAG`: the monitor reports that Claude is
  active while the diagram is frozen.
- One task, one run. `cw run start` refuses to open a second run while one is
  live. To continue a parked run just answer the question — the run resumes.
  To retire one deliberately: `cw run abandon --message "<why>"`.
- A gate is decided at the phase that owns it, and only once that phase's
  declared artifact exists on disk as a non-empty file. `cw gate pass` refuses
  otherwise and has no `--force`; `cw gate override <GATE> --reason "<why>"` is a
  separate, audited command for a decision the user made outside the run.
- Declared artifacts are enforced on leaving a phase: `cw phase complete` and the
  next `cw phase enter` both refuse while one is missing or empty. Write the
  file; `--allow-missing-artifacts --reason "<why>"` is an audited exception, not
  a shortcut.
- `cw run complete` is verified: all gates passed, all phases completed or
  skipped, nothing waiting on the user, all required artifacts present. A run
  that cannot finish is retired with `cw run abandon`, which is not success.
- Another Claude session's run is not yours to steer. `cw phase`, `cw gate` and
  `cw run complete/fail/abandon` are refused for a run owned by another session;
  take it over deliberately with `cw run claim <runId> --force --reason "<why>"`.
- If `cw` is unavailable, continue the engineering work normally and report the
  missing CLI once in the final report. Monitoring is observability, not a gate.
- `cw status` shows the active run, the open gates, whether mutation is
  currently denied, and the legal next phases.

### Internal step skills

Skills named `wf-*` are steps inside a workflow, not conversations. They return
their findings to the workflow that invoked them. They do not write a long
report to the user; the only steps that address the user are the final report
and an explicit blocking question.

### Final response

Keep final output compact:
1. Result
2. Implemented/fixed
3. Key business/technical decisions
4. Validation/E2E evidence
5. Known limitations/remaining risk
6. Follow-up recommendations, only if material

Do not narrate the work history.
