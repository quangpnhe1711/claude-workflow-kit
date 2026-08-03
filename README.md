# Claude Workflow Kit

**A structured development workflow for Claude Code — with hard gates, persisted
evidence, and a live diagram that shows where Claude actually is.**

Claude Workflow Kit installs into any repository and adds:

- **business decision gates** — no coding until the desired behaviour is explicit;
- **root-cause gates for bugs** — no fix until the cause is established;
- **reusable skills** — analysis, planning, implementation, validation, review;
- **persisted run context** — every phase writes evidence files to disk;
- **a repository convention cache** — discovered once, reused across tasks;
- **runtime hooks** — Claude Code lifecycle events feed the run state;
- **a live workflow monitor** — the phase graph plus what Claude is doing now.

It does **not** replace Claude Code. It is a layer on top: skills, agents, hooks,
a `CLAUDE.md` block, a small CLI (`cw`) and a local monitor server. Claude Code
still does the work; this kit decides what order the work happens in and records
what happened.

Requirements: Node.js ≥ 18.17, Claude Code, git.

---

## Contents

| | |
| --- | --- |
| [1. Quick Start — first 5 minutes](#1-quick-start--first-5-minutes) | install, verify, monitor, first run |
| [2. Monitor — practical guide](#2-monitor--practical-guide) | what the screen means |
| [3. Test the monitor in 5 minutes](#3-test-the-monitor-in-5-minutes) | literal walkthrough |
| [4. Core concepts](#4-core-concepts) | workflow, skill, agent, gate, artifact, run |
| [5. Core rules](#5-core-rules) | what is enforced, and how strictly |
| [6. Workflow guide](#6-workflow-guide) | `/feature-change`, `/bug-fix`, `/work`, … |
| [7. Phase by phase](#7-phase-by-phase) | the real graph, every phase explained |
| [8. Skills reference](#8-skills-reference) | all 16 skills |
| [9. How context flows](#9-how-context-flows) | artifacts between phases |
| [10. `.ai-workflow` explained](#10-ai-workflow-explained) | files, and what to commit |
| [11. Conventions](#11-conventions) | the repository knowledge cache |
| [12. `cw` CLI reference](#12-cw-cli-reference) | every command |
| [13. Run lifecycle](#13-run-lifecycle) | statuses and transitions |
| [14. Hooks](#14-hooks) | what each Claude Code hook is for |
| [15. Gate enforcement and limitations](#15-gate-enforcement-and-limitations) | what is guaranteed |
| [16. Troubleshooting](#16-troubleshooting) | problem → what to do |
| [17. Practical daily usage](#17-practical-daily-usage) | recommended patterns |
| [18. Real example](#18-real-example) | end-to-end feature |
| [19. Development guide](#19-development-guide) | for maintainers |
| [20. Extending the toolkit](#20-extending-the-toolkit) | new workflow / skill / phase |
| [21. Known limitations](#21-known-limitations) | honest list |

---

## 1. Quick Start — first 5 minutes

### Step 1 — Install

```bash
# recommended: the `cw` CLI lands in node_modules/.bin, and skills call it by name
npm install --save-dev claude-workflow-kit

npx claude-workflow-kit init
```

What this creates in your project:

```
.claude/skills/          16 workflow skills (entry points + wf-* steps)
.claude/agents/          business-analyst, root-cause-analyst, independent-reviewer
.claude/hooks/cw-hook.mjs
.claude/settings.json    kit hooks merged into your existing settings
.claude/cw-runtime       records the runtime directory name
.ai-workflow/            runtime: config.json, conventions/, runs/
CLAUDE.md                your file + one managed <!-- CW:START --> block
```

Nothing unmanaged is overwritten: `CLAUDE.md` gets a marked block, settings hooks
are merged, and any file the installer had to modify is saved as `*.cw-backup`.

> **Important — `cw` must be resolvable.** Workflow skills run bare `cw …`
> commands in a shell. If `cw` is not on `PATH` inside Claude Code, the
> engineering work still happens but nothing is recorded and the monitor stays
> empty. The simplest fix is a global install:
>
> ```bash
> npm install -g claude-workflow-kit
> ```

Useful install flags: `--preset senior-dev` (the only shipped preset),
`--runtime <dir>`, `--port <n>`, `--no-hooks`, `--no-claude-md`, `--dry-run`,
`--json`.

### Step 2 — Verify

```bash
npx claude-workflow-kit doctor    # `cw doctor` is the same command
```

A healthy fresh install looks like this:

```
✓ node                  v22.16.0
✓ runtime directory     /path/to/project/.ai-workflow
✓ config.json           port=4173 stall=120s preset=senior-dev
✓ hook script           /path/to/project/.claude/hooks/cw-hook.mjs
✓ settings.json hooks   12 events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, …
✓ runtimeUrl            file:///…/workflow-core/dist/index.js
✓ skills                16 installed
✓ agents                3 installed
✓ CLAUDE.md             managed block present
✓ workflow definitions  bug-fix, feature-change, generic
✓ runs                  0 runs
! gate policy           no PreToolUse evaluation recorded yet — enforcement is unproven in this project
✓ semantic progress     phases track runtime activity
! conventions           refresh needed: code, comments, testing, database (cw conventions status)
✓ hook errors           none
! monitor               not running at http://127.0.0.1:4173 (start it with: cw monitor)
```

The three `!` lines above are expected before you have started anything. Only
`✕` is a failure, and `doctor` exits non-zero when one appears.

### Step 3 — Start the monitor

```bash
npx cw monitor
# one-off without a local install:
# npx --package claude-workflow-kit cw monitor
```

Then open:

**http://127.0.0.1:4173**

Options: `--port <n>`, `--host <h>`, `--project <dir>`, `--runtime <dir>`.
The port defaults to `monitorPort` in `.ai-workflow/config.json` (4173).

### Step 4 — Bootstrap conventions

Inside Claude Code:

```
/refresh-conventions
```

This reads representative code and writes `code.md`, `comments.md`,
`testing.md`, `database.md` and `metadata.json` into
`.ai-workflow/conventions/`.

Do this **once per repository**. After that, every workflow reuses the cache and
refreshes only the areas that `cw conventions status` reports as stale, missing
or unverifiable.

### Step 5 — Run your first feature

Inside Claude Code:

```
/feature-change
Cho phép chỉnh sửa Liên lạc tạo độc lập.
Liên lạc gắn dòng báo cáo giữ nguyên.
```

Expected shape of the run (this is the real `feature-change` topology):

```
Prompt
  ↓
Evidence Analysis          evidence.md
  ↓
Business Decision          business-decision.md   ← GATE: BUSINESS_READY
  ↓                                                 (may park on "Waiting For User")
Impact / Risk / Scope      implementation-plan.md, impact-risk-scope.md, test-strategy.md
  ↓
Conventions
  ↓
Implementation             ← the first phase allowed to touch your code
  ↓
Validation                 validation.md
  ↓
E2E
  ↓
Independent Review         review.md   ← may loop back to Implementation (max 3)
  ↓
Product Assessment         assessment.md
  ↓
Final Report               final-report.md
  ↓
Done
```

Watch it move in the monitor. You can stop reading here and use the product.

---

## 2. Monitor — practical guide

```bash
npx cw monitor            # → http://127.0.0.1:4173
```

The monitor is **read-only**. It reports; it never changes a run. Everything it
shows is derived from `.ai-workflow/` on disk, pushed to the browser over
Server-Sent Events (≈1s polling on the server side, plus a local 1s clock so
"12s ago" keeps moving).

### What the screen shows

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Feature Change   fc-20260803-001        RUNNING  ● claude tool running    │
│ "Cho phép chỉnh sửa Liên lạc…"      Grep   3s ago   elapsed 4m 12s   live │
├────────────┬──────────────────────────────────┬───────────────────────────┤
│ Runs       │        workflow graph            │ Node detail (on click)    │
│            │                                  │                           │
│ ▸ RUNNING  │   Prompt                         │ Business Decision         │
│   current  │     ↓                            │ status  WAITING USER      │
│   fc-…-001 │   Evidence Analysis  ✓           │ gate    BUSINESS_READY =  │
│   4s ago   │     ↓                            │         WAITING           │
│            │   Business Decision  ◐  ← current│ skill   wf-business-…     │
│ ▸ COMPLETED│     ↓ blocked                    │ artifacts                 │
│   fc-…-002 │   Waiting For User               │  · business-decision.md   │
│            │     …                            │ Activity (events)         │
└────────────┴──────────────────────────────────┴───────────────────────────┘
```

**Header** — workflow label, run id, run label, derived run status, a `semantic
lag` pill when relevant, Claude runtime status, current/last tool, time since the
last hook event, elapsed run time, a `policy` badge when gate enforcement is
degraded or disabled, and the SSE connection state (`connecting` / `live` /
`offline`).

**Runs panel** — every run in the project, newest first: status pill, a `current`
chip on the active run, a `lag` chip on a lagging run, the run label and time
since last activity. Unreadable runs are listed as `CORRUPT`, deliberately
retired ones as `quarantined`.

**Graph** — the workflow topology straight from its YAML definition. Each node
shows a status badge, its gate (when it owns one), a `×N` visit counter for
re-entered phases (review loops), elapsed time, and — for the current node — the
Claude runtime line. Missing declared artifacts are called out on the node.
Edges carry their label or gate condition; the edge the run actually traversed
last is animated.

Node badges: `○` pending · `●` active · `◐` waiting for user · `✓` completed ·
`✕` failed · `–` skipped · `◌` stale.

**Node detail** (click a node) — description, status, started/finished/duration,
visit count, gate state, implementing skill or agent, error text, running
subagents, artifacts (present ones are clickable and open the file), and the
event log filtered to that phase.

### Node statuses

| Status | Meaning |
| --- | --- |
| `PENDING` | Phase has not started |
| `ACTIVE` | Phase is in progress |
| `WAITING_USER` | The run is parked on a user decision (a `waiting` node) |
| `COMPLETED` | Phase finished |
| `FAILED` | Phase failed — the run is failed too |
| `SKIPPED` | Phase was explicitly skipped, or bypassed by a passed gate |
| `STALE` | Derived in the UI only: the phase is `ACTIVE` but there has been no activity for longer than `stallThresholdSeconds` |

### Run statuses in the header

| Status | Meaning |
| --- | --- |
| `RUNNING` | Normal progress |
| `WAITING_USER` | A gate is parked; answer Claude to continue the same run |
| `COMPLETED` | Finished, and verified as finishable (see [§13](#13-run-lifecycle)) |
| `FAILED` | Explicitly failed |
| `ABANDONED` | Deliberately retired — never reads as success |
| `POSSIBLY_STALLED` | Derived: no event of any kind for longer than `stallThresholdSeconds` (default 120s). Never `FAILED` — the kit does not claim Claude is dead |
| `SEMANTIC_LAG` (pill) | Derived: Claude is demonstrably working, but no phase transition has been emitted for longer than `semanticLagThresholdSeconds` (default 300s) |

### Semantic phase ≠ Claude runtime activity

This is the central design decision, and the reason the monitor does not lie.

```
Semantic layer   (who writes it: skills, explicitly, via `cw`)
   Business Decision   gate BUSINESS_READY = WAITING

Runtime layer    (who writes it: Claude Code hooks)
   TOOL_RUNNING   tool = Grep   last event 2s ago
```

A hook never decides a business phase. A phase never guesses whether Claude is
alive. Both are shown side by side, so these situations look different:

| Semantic | Runtime | Reading |
| --- | --- | --- |
| `Business Decision` | `IDLE`, status `WAITING_USER` | Claude asked you something. Answer it. |
| `Business Decision` | `TOOL_RUNNING`, 2s ago | Claude is working inside that phase. Wait. |
| `Business Decision` | no events for 5 min | `POSSIBLY_STALLED`. Check the session. |
| `Business Decision` | busy, but no transition for 5 min | `SEMANTIC_LAG`. Work is happening ahead of the diagram. |

Why it matters: the semantic phase is emitted by the model. If the model batches
its `cw` calls or forgets one, the diagram falls behind reality. The kit
**reports** that as `SEMANTIC_LAG` instead of guessing a phase from tool calls —
a guessed phase would be a plausible lie, which is worse than a flagged gap.

### API (for scripting)

| Endpoint | Returns |
| --- | --- |
| `GET /api/health` | `{ ok, projectRoot }` |
| `GET /api/state` | full snapshot: workflows, runs (with derived statuses), policy health |
| `GET /api/runs/<runId>` | run + workflow + last 500 events + artifacts |
| `GET /api/runs/<runId>/artifacts/<name>` | raw artifact file |
| `GET /api/stream` | SSE `snapshot` events |

---

## 3. Test the monitor in 5 minutes

Use a deliberately ambiguous request, so the business gate has to stop and ask.

**1. Start the monitor** and open http://127.0.0.1:4173.

**2. In Claude Code, send:**

```
/feature-change
Cho phép edit Liên lạc.
```

**3. What you should see, in order:**

| Monitor shows | Meaning |
| --- | --- |
| A new run appears, `RUNNING`, chip `current` | `cw run start feature-change` |
| `Evidence Analysis` turns `●`, artifact `evidence.md` appears | Evidence is being reconciled |
| `Business Decision` turns `●`, gate chip `BUSINESS_READY` | The gate phase is running |
| `Waiting For User` turns `◐`, header pill `WAITING USER`, gate `BUSINESS_READY = WAITING` | Claude found an ambiguity and parked the run |
| Claude runtime goes `IDLE` | It is waiting on you, not working |

At this point Claude asks you one concise question (Problem / Impact /
Recommended resolution / Decision required). Meanwhile any attempt to edit code
would be denied by the hook — the gate is open.

**4. Answer it in the same session:**

```
Chỉ cho sửa Liên lạc không gắn dòng báo cáo.
Cho sửa nội dung và Tag.
```

**5. What you should see next:**

| Monitor shows | Meaning |
| --- | --- |
| `Waiting For User` → `✓`, back on `Business Decision` | The same run resumed — no new run appears |
| `business-decision.md` listed on the node | Resolved specification persisted |
| Gate chip flips to `BUSINESS_READY = PASSED` | `cw gate pass BUSINESS_READY` |
| `Impact / Risk / Scope` turns `●`, then three artifacts appear | Plan, impact/risk/scope, test strategy |
| `Implementation` turns `●` | Only now can files change |
| `Validation` → `E2E` → `Independent Review` | Evidence, then review (`review.md`) |
| `Product Assessment` → `Final Report` → `Done`, run `COMPLETED` | Verified completion |

> **Tip.** The run list is the fastest correctness check for the whole kit: one
> prompt must produce **one** run. If answering a question creates a second run,
> something re-entered the workflow instead of resuming it.

---

## 4. Core concepts

**Workflow** — an ordered development process, defined as data (YAML): nodes,
edges, gates, and the artifacts each phase must produce. Shipped: `feature-change`,
`bug-fix`, `generic`.

**Skill** — a reusable instruction file Claude loads (`.claude/skills/<name>/SKILL.md`).
Entry-point skills are what you type (`/feature-change`); `wf-*` skills are steps
invoked by a workflow, not by you.

**Agent** — a specialised sub-worker with its own tools and read-only discipline:
`business-analyst` (evidence reconciliation), `root-cause-analyst` (causal
tracing), `independent-reviewer` (post-implementation review).

**Gate** — a named condition that must be `PASSED` before the workflow may
continue. `BUSINESS_READY` and `ROOT_CAUSE_READY` are the two shipped gates.
While any gate is open, the `PreToolUse` hook denies repository changes.

**Artifact** — a file a phase must persist into the run directory. It is the
phase's evidence and the next phase's input: `evidence.md`, `root-cause.md`,
`business-decision.md`, `implementation-plan.md`, `impact-risk-scope.md`,
`test-strategy.md`, `validation.md`, `review.md`, `assessment.md`,
`final-report.md`.

**Run** — one instance of one workflow for one task, stored in
`.ai-workflow/runs/<run-id>/`. Run ids look like `fc-20260803-001` (workflow
initials, date, per-day counter).

**Semantic state** — which workflow phase the run is in, and what its gates say.
Written only by skills, through `cw`.

**Runtime state** — what Claude is doing right now (`ACTIVE`, `TOOL_RUNNING`,
`SUBAGENT_RUNNING`, `IDLE`, …). Written only by Claude Code hooks.

**Convention cache** — persisted knowledge of how this repository writes code,
comments, tests and database changes, in `.ai-workflow/conventions/`, so it is
discovered once rather than re-derived per task.

---

## 5. Core rules

### NO BUSINESS DECISION = NO CODING

Before implementation, the desired behaviour must be explicit enough to answer:
actor/permission, trigger/precondition, state or data transition, forbidden
behaviour, important edge cases, and backward-compatibility expectations.

**How this is enforced.** While any active run in the project has an unpassed
gate, the `PreToolUse` hook returns `deny` for:

- every file-writing tool — `Edit`, `Write`, `MultiEdit`, `NotebookEdit`,
  `apply_patch`, `str_replace_editor`, `create_file`, plus MCP tools whose names
  match `^mcp__.*(write|edit|create|patch|…)`;
- command tools (`Bash`, `PowerShell`, `Shell`, `Terminal`, `run_command`, …)
  **unless** every program in the command line is on the read-only allowlist
  (`git status/diff/log/show`, `grep`, `rg`, `ls`, `cat`, `jq`, `cw`, …) or is a
  test/build entry point (`npm`, `pytest`, `cargo`, `make`, …). Redirection,
  command substitution, and write-capable flags (`find -delete`, `fd -x`,
  `sort -o`) are refused.

The real denial message Claude receives:

```
Blocked by claude-workflow-kit: run fc-20260803-001 (feature-change) has unpassed
gate(s): BUSINESS_READY (decided at "business"). Nothing in the repository may
change until BUSINESS_READY pass. Complete the gate phase, persist its evidence
artifact, then run: cw gate pass BUSINESS_READY. If the decision is not yours to
make, run: cw gate wait BUSINESS_READY --message "<open decision>" and ask the
user. This write was refused because src/orders.js is repository content.
```

What stays writable behind a gate: exactly `<runDir>/<name>` where `<name>` is an
artifact the **current** phase declares. The phase that produces a gate's
evidence cannot be blocked by that gate. `state.json` and `events.jsonl` are
never writable by a tool.

### For bugs: NO ROOT CAUSE = NO FIX

The `bug-fix` workflow adds `ROOT_CAUSE_READY` in front of everything else.
Reproduce where feasible, trace the current/legacy flow, explain *why* the
symptom occurs, and separate symptom / contributing factor / root cause. Both
gates must pass before a defect fix can touch a file.

> **Limitation — this is a workflow guardrail, not a security sandbox.**
> Enforcement covers the tool surface listed in `config.json`. Test and build
> commands are deliberately allowed behind a gate (a package script or Makefile
> target *can* write files — set `allowTestCommandsBehindGate: false` for a
> strict gate). A command tool that is not in `commandTools`, or an MCP writer
> whose name does not match the pattern, is not covered until you add it. See
> [§15](#15-gate-enforcement-and-limitations).

### Evidence, not authority

Requirement documents, database schema, existing code and existing tests are all
**evidence**. None is truth on its own. When they conflict, the contradiction is
surfaced with a stable id (`C-001`, `C-002`, …) and the intended behaviour is
resolved explicitly — never by silently preferring documents over code or code
over documents.

Conclusions are classified `FACT` / `INFERENCE` / `ASSUMPTION` / `PROPOSAL`.

### Scope discipline

Only approved scope is implemented. Improvements discovered while coding go into
`assessment.md` as recommendations, not into the diff — unless they are required
for correctness or safety of the approved task.

---

## 6. Workflow guide

### `/feature-change`

**Use when** you want new behaviour, a business-rule change, a redesign, or a
requirement/document-driven change — including when the inputs (docs, DB, code,
tests) may contradict each other.

**Input example**

```
/feature-change
Cho phép chỉnh sửa Liên lạc tạo độc lập.
Liên lạc gắn dòng báo cáo giữ nguyên.
```

**What Claude does**

1. Opens a run (`cw run start feature-change`).
2. Reconciles evidence across intent, documents, DB, code and tests → `evidence.md`.
3. Resolves the business behaviour behind `BUSINESS_READY` → `business-decision.md`.
4. Plans impact, risk, scope and tests → three artifacts.
5. Loads cached conventions, refreshing only what is stale.
6. Implements the smallest correct change.
7. Validates against the pre-defined test strategy, then E2E.
8. Hands the diff to the `independent-reviewer` agent → `review.md`.
9. Assesses the result → `assessment.md`; reports → `final-report.md`.

**Can it stop and ask?** Yes — at the business gate, when a genuine product
decision would materially change the implementation. The run parks in
`WAITING_USER` and resumes in place when you answer.

**Main output** — `final-report.md`, plus the full evidence chain in the run
directory.

**When not to use** — a defect with a known-good expected behaviour (use
`/bug-fix`), or a trivial mechanical edit where a full run is overhead.

### `/bug-fix`

**Use when** existing behaviour is wrong and you can describe the symptom.

**Input example**

```
/bug-fix
Sửa Liên lạc gắn dòng báo cáo vẫn lưu được.
Expected: chặn, báo lỗi. Actual: lưu thành công.
```

**What Claude does**

1. Opens a run (`cw run start bug-fix`).
2. Reproduces where feasible, traces the current/legacy flow, separates symptom
   from contributing factors from root cause → `root-cause.md`, behind
   `ROOT_CAUSE_READY`.
3. Resolves the expected behaviour the fix must produce → `business-decision.md`,
   behind `BUSINESS_READY`.
4. Then the same path as a feature change: readiness → conventions →
   implementation (smallest root-cause fix) → validation → E2E (the symptom is
   gone) → review → assessment → report.

**Can it stop and ask?** Yes, twice: when the root cause cannot be established
from available evidence, and when expected behaviour is a genuine product
decision.

**Main output** — `root-cause.md` and `final-report.md`.

**When not to use** — the behaviour is not actually a defect but a requirement
change (use `/feature-change`).

### `/work`

**Use when** you have a task and do not want to pick a workflow.

**Input example**

```
/work
Người dùng không xoá được Liên lạc đã gắn báo cáo — không rõ là bug hay thiếu tính năng.
```

**What Claude does** — classifies the task from evidence (not keywords) and
invokes the `wf-bug-fix` or `wf-feature-change` body directly. If a task contains
both, it picks the workflow that owns the primary business change and treats the
defect as evidence inside it. It never invents a third ad-hoc workflow.

**Can it stop and ask?** Only if the classification itself changes what inputs
are required and cannot be resolved from the task.

**Main output** — whatever the selected workflow produces.

**When not to use** — you already know which workflow you want.

### `/refresh-conventions`

**Use when** setting up the repository, or when `cw conventions status` reports
areas as `MISSING`, `STALE`, `UNRECORDED` or `INVALID`.

**Input example**

```
/refresh-conventions            # all areas
/refresh-conventions testing    # one area
```

**What Claude does** — derives conventions from repeated codebase evidence,
marks each rule `REQUIRED` / `DOMINANT` / `LOCAL` / `UNCERTAIN`, and writes
`code.md`, `comments.md`, `testing.md`, `database.md` and `metadata.json` under
`.ai-workflow/conventions/`. `metadata.json` records, per area, the `status`,
`last_refresh` and the project-relative `evidence` files actually read.

**Can it stop and ask?** No.

**Main output** — the convention cache. It does not modify product code.

**When not to use** — on every task. That is the whole point of the cache.

### `/wf-status`

**Use when** resuming work, or when you are unsure whether a run is still open.

**Input example**

```
/wf-status
```

**What Claude does** — runs `cw status` and interprets it: the current phase,
open gates, whether mutation is currently denied, missing or unusable artifacts,
gate overrides, policy health, and the transitions the state machine will accept
next.

**Can it stop and ask?** No. It is a read-only report.

**When not to use** — nothing to check; it is always safe.

---

## 7. Phase by phase

### `feature-change` (13 nodes)

```
                  prompt  (start)
                     │
                     ▼
              evidence  ── evidence.md
                     │
                     ▼
     ┌────────  business  ── business-decision.md      gate BUSINESS_READY
     │ !BUSINESS_READY │  BUSINESS_READY
     ▼                 │
await-business  ───────┘  (answered)
   (waiting)            │
                        ▼
                  readiness  ── implementation-plan.md
                        │        impact-risk-scope.md
                        │        test-strategy.md
                        ▼
                  conventions
                        │
                        ▼
              implementation ◄──────────┐
                        │               │ findings
                        ▼               │
                  validation  ── validation.md
                        │               │
                        ▼               │
                       e2e              │
                        │               │
                        ▼               │
                    review  ── review.md┘   (agent: independent-reviewer)
                        │
                        ▼
                 assessment  ── assessment.md
                        │
                        ▼
                    report  ── final-report.md
                        │
                        ▼
                     done  (end)
```

### `bug-fix` (14 nodes)

Identical, except the run starts with a root-cause gate:

```
prompt → root-cause ── root-cause.md      gate ROOT_CAUSE_READY
             │  ↕ await-root-cause (waiting)
             ▼
         business ── business-decision.md  gate BUSINESS_READY
             │  ↕ await-business (waiting)
             ▼
         readiness → conventions → implementation → validation → e2e
             → review → assessment → report → done
```

### The phases

#### Root Cause (`root-cause`, bug-fix only)

- **Purpose** — reproduce, trace the current/legacy flow end to end, explain why
  the symptom occurs, separate symptom / contributing factors / root cause, and
  identify whether existing tests encode the buggy behaviour.
- **Reads** — the reported symptom, reproduction steps, code, data, logs.
- **Produces** — `root-cause.md`. **Gate:** `ROOT_CAUSE_READY`.
- **Can modify application code?** No.
- **Can ask the user?** Yes — when the cause cannot be established from
  available evidence (`cw gate wait ROOT_CAUSE_READY`).
- **Skill / agent** — `wf-bug-root-cause`, may delegate to `root-cause-analyst`.

#### Evidence Analysis (`evidence`, feature-change only)

- **Purpose** — reconcile intent, requirement/design documents, DB schema, code
  and tests; surface only contradictions that materially affect behaviour, data,
  permissions, compatibility or implementation direction.
- **Reads** — the user's stated outcome and all supplied sources.
- **Produces** — `evidence.md`: desired outcome, current behaviour with evidence,
  documented behaviour by source, contradictions `C-001…`, classification
  (FACT / INFERENCE / ASSUMPTION / PROPOSAL), resolution options, recommendation,
  open business decisions.
- **Can modify application code?** No.
- **Can ask the user?** Normally no — it collects the open questions for the next
  phase to decide.
- **Skill / agent** — `wf-evidence-reconciliation`, may delegate to
  `business-analyst`.

#### Business Decision (`business`)

- **Purpose** — turn evidence into an explicit resolved specification: who, when,
  what, state/data transition, forbidden behaviour, edge cases, ownership,
  compatibility, failure behaviour.
- **Reads** — `evidence.md` (or `root-cause.md`), the user's request, current code
  behaviour, contradictions, open questions.
- **Produces** — `business-decision.md`. **Gate:** `BUSINESS_READY`.
- **Can modify application code?** No — and the hook enforces it.
- **Can ask the user?** Yes. One concise decision at a time:
  Problem / Impact / Recommended resolution / Decision required.
- **Skill** — `wf-business-decision`.

#### Impact / Risk / Scope (`readiness`)

- **Purpose** — one coherent pre-code package: implementation plan, direct and
  indirect impact, risk analysis, explicit in/out of scope, and a test strategy
  derived from business rules *before* coding.
- **Reads** — `business-decision.md`, the codebase.
- **Produces** — `implementation-plan.md`, `impact-risk-scope.md`,
  `test-strategy.md`. All three are enforced: the phase cannot be left while one
  is missing or empty.
- **Can modify application code?** No.
- **Can ask the user?** Normally no.
- **Skill** — `wf-change-readiness`.

#### Conventions (`conventions`)

- **Purpose** — load the cached repository conventions relevant to the change and
  refresh only what is missing, stale or locally contradicted.
- **Reads** — `cw conventions status`, then `.ai-workflow/conventions/*`.
- **Produces** — no run artifact; may update the convention cache.
- **Can modify application code?** No.
- **Skill** — `wf-convention-manager`.

#### Implementation (`implementation`)

- **Purpose** — the smallest correct change inside approved scope, following the
  resolved decision (and, for bugs, addressing the cause, not the symptom).
- **Reads** — `business-decision.md`, `root-cause.md`, the three readiness
  artifacts, conventions.
- **Produces** — the diff; tests that belong with the change.
- **Can modify application code?** **Yes — this is the first phase that can**,
  and only because the gates have passed.
- **Skill** — `wf-implement`.

#### Validation (`validation`)

- **Purpose** — execute the pre-defined test strategy and map evidence to each
  business rule. Never PASS because the code "looks correct".
- **Produces** — `validation.md` with the actual commands and their actual output.
  The reviewer reads this file directly.
- **Can modify application code?** Only to fix failures caused by this change,
  within approved scope.
- **Skill** — `wf-validation-e2e`.

#### E2E (`e2e`)

- **Purpose** — runtime/end-to-end verification of the real flow where feasible
  (for bugs: the reported symptom is gone).
- **Produces** — no separate artifact; evidence is recorded in `validation.md`.
- **Skill** — `wf-validation-e2e`.

#### Independent Review (`review`)

- **Purpose** — an independent read-only review of the final diff against the
  resolved specification, root cause, approved scope, predicted impact, test
  strategy and validation evidence.
- **Reads** — only *pointers*, produced by `cw review-context`: the run directory,
  resolved artifact paths, and how to obtain the diff. Never the implementer's
  own summary — reviewing a summary is not review.
- **Produces** — `review.md`: `PASS`/`FAIL` plus findings with
  Severity / Evidence / Problem / Impact / Recommended correction.
- **Can modify application code?** No. Fixes go back through `implementation`
  (a legal edge), maximum 3 loops.
- **Agent** — `independent-reviewer`.

#### Product Assessment (`assessment`)

- **Purpose** — evidence-backed observations revealed by this scope: product
  consistency, UX, data, maintainability, security/permissions, auditability,
  scaling. Report-only.
- **Produces** — `assessment.md`, each item with ID / Observation / Evidence /
  Impact / Recommendation / Priority / Scope. `No material follow-up
  recommendations.` is a valid result.
- **Can modify application code?** No. Only Critical/High correctness or safety
  issues may reopen the current task.
- **Skill** — `wf-product-assessment`.

#### Final Report (`report`)

- **Purpose** — the one step that addresses you at length: Result, Implemented/
  Fixed, Key decisions, Validation evidence, Known limitations, Follow-up.
- **Produces** — `final-report.md`.
- **Skill** — `wf-final-report`.

#### Waiting nodes (`await-business`, `await-root-cause`)

Not work — a place the run *parks* while a gate is `WAITING`. A gate can only be
parked from the phase that owns it, and can only be decided from that phase or
from the waiting node the run legitimately reached. Passing the gate settles the
waiting node and returns focus to the owning phase, so the run continues instead
of restarting.

---

## 8. Skills reference

16 skills ship in the `senior-dev` preset. "User can call?" reflects the actual
frontmatter: entry points are marked `disable-model-invocation: true` (you type
them, the model cannot invoke them), `wf-*` step skills are marked
`user-invocable: false` (the reverse).

| Skill | User can call? | Purpose | Called by | Main output |
| --- | :---: | --- | --- | --- |
| `work` | ✅ | Route a task to the right workflow | you | invokes `wf-bug-fix` / `wf-feature-change` |
| `feature-change` | ✅ | Entry point for the feature workflow | you | invokes `wf-feature-change` |
| `bug-fix` | ✅ | Entry point for the defect workflow | you | invokes `wf-bug-fix` |
| `refresh-conventions` | ✅ | Bootstrap/refresh the convention cache | you | `conventions/*.md` + `metadata.json` |
| `wf-status` | ✅ | Report the current run, gates, next transitions | you | `cw status` interpretation |
| `wf-feature-change` | ❌ | The feature workflow body (10 phases) | `feature-change`, `work` | the whole run |
| `wf-bug-fix` | ❌ | The defect workflow body (10 phases) | `bug-fix`, `work` | the whole run |
| `wf-evidence-reconciliation` | ❌ | Reconcile intent/docs/DB/code/tests | `wf-feature-change` | `evidence.md` |
| `wf-bug-root-cause` | ❌ | Reproduce, trace, establish causal root cause | `wf-bug-fix` | `root-cause.md` |
| `wf-business-decision` | ❌ | Resolve business behaviour (hard gate) | both bodies | `business-decision.md` |
| `wf-change-readiness` | ❌ | Plan, impact, risk, scope, test strategy | both bodies | 3 artifacts |
| `wf-convention-manager` | ❌ | Cache-first convention reuse | both bodies | loaded conventions |
| `wf-implement` | ❌ | Smallest correct change; review handoff contract | both bodies | the diff |
| `wf-validation-e2e` | ❌ | Evidence-based validation + E2E | both bodies | `validation.md` |
| `wf-product-assessment` | ❌ | Post-implementation, evidence-backed findings | both bodies | `assessment.md` |
| `wf-final-report` | ❌ | Compact evidence-focused report | both bodies | `final-report.md` |

### Context each step receives and produces

<details>
<summary><b>wf-evidence-reconciliation</b></summary>

**Receives** — the user's stated outcome, the run directory, and the source entry
points (documents, schema, code, tests).
**Produces** — `evidence.md`: desired outcome, current behaviour with evidence,
documented behaviour per source, contradictions `C-001…`, FACT/INFERENCE/
ASSUMPTION/PROPOSAL classification, resolution options for material conflicts,
recommended resolution, open business decisions.
**Next phase consumes** — the contradictions and the open business decisions.
</details>

<details>
<summary><b>wf-bug-root-cause</b></summary>

**Receives** — symptom, reproduction steps, expected vs actual, the run directory.
**Produces** — `root-cause.md`: reproduction status (`NOT_REPRODUCED` is an
allowed, explicit outcome), the traced current/legacy flow, why the code produces
the symptom, symptom vs contributing factors vs root cause, smallest safe fix
direction, whether tests encode the bug.
**Next phase consumes** — the causal claim and the fix direction.
</details>

<details>
<summary><b>wf-business-decision</b></summary>

**Receives** — the original request, evidence findings, current code behaviour,
document/DB/test contradictions, and the open business questions.
**Produces** — `business-decision.md`: Desired behaviour, Confirmed rules,
Rejected/outdated interpretations, Assumptions, Open decisions, Status
(`BUSINESS_READY` or `BUSINESS_BLOCKED`), plus the gate decision itself
(`cw gate pass` or `cw gate wait`).
**Next phase consumes** — `business-decision.md` is **the resolved business
source** for everything downstream: planning, implementation, validation and
review all read it rather than the raw documents.
</details>

<details>
<summary><b>wf-change-readiness</b></summary>

**Receives** — `business-decision.md` (and `root-cause.md` for defects), the
codebase.
**Produces** — `implementation-plan.md` (layers, files, data/migration, API, UI,
permissions, compatibility, sequence), `impact-risk-scope.md` (direct/indirect
impact, risks, in/out of scope), `test-strategy.md` (happy path, negative,
boundary, regression, compatibility, migration, E2E).
**Next phase consumes** — the plan and the scope boundary; validation consumes
the test strategy verbatim.
</details>

<details>
<summary><b>wf-convention-manager</b></summary>

**Receives** — the scope of the change and the `cw conventions status` report.
**Produces** — the loaded conventions; refreshes only flagged areas. Precedence:
local intentional convention near the touched code → this cache → a generic
external skill or default.
</details>

<details>
<summary><b>wf-implement</b></summary>

**Receives** — the resolved decision, root cause, the three readiness artifacts,
conventions. It verifies gate state first (`cw status` must not print
`mutation DENIED`).
**Produces** — the diff, plus the *review handoff*: `cw review-context` output
passed verbatim, the diff command, and the task label — deliberately nothing else.
</details>

<details>
<summary><b>wf-validation-e2e</b></summary>

**Receives** — `business-decision.md` and `test-strategy.md`.
**Produces** — `validation.md`: actual commands, actual output, evidence mapped
per business rule, task-caused vs unrelated failures.
**Next phase consumes** — the reviewer re-reads this file and may re-run checks.
</details>

<details>
<summary><b>wf-product-assessment</b></summary>

**Receives** — the completed change and every prior artifact.
**Produces** — `assessment.md`, report-only, each item evidence-backed with
priority and scope.
</details>

<details>
<summary><b>wf-final-report</b></summary>

**Receives** — every artifact in the run directory.
**Produces** — `final-report.md`: Result, Implemented/Fixed, Key decisions,
Validation, Known limitations, Follow-up. Compresses wording, never substance.
</details>

---

## 9. How context flows

```
User Request
     │
     ▼
Evidence            evidence.md        (or root-cause.md for defects)
     │
     ▼
Resolved Business Decision            business-decision.md   ← the canonical spec
     │
     ▼
Plan / Impact / Risk / Scope / Tests  implementation-plan.md
     │                                impact-risk-scope.md
     │                                test-strategy.md
     ▼
Implementation                        the diff
     │
     ▼
Validation Evidence                   validation.md
     │
     ▼
Independent Review                    review.md
     │
     ▼
Final Report                          final-report.md
```

Two rules make this work:

**1. Context is persisted, not remembered.** Every phase writes its result to a
file in the run directory. A later phase reads the file. This survives context
compaction, a new session, and a reviewer that must not trust the implementer.
The runtime enforces it: `cw phase complete` and the next `cw phase enter` are
both refused while a declared artifact is missing or empty, and so is any
transition made after an earlier completed phase's evidence has disappeared.

**2. `business-decision.md` is the resolved business source.** Downstream phases
read it — not the original request, not the requirement documents. If it turns
out to be wrong, the run goes back to the `business` phase; it is not quietly
reinterpreted during implementation.

### `WAITING_USER` resume

Correct — one task, one run:

```
run A  →  gate WAITING  →  you answer  →  run A continues  →  run A COMPLETED
```

Wrong, and prevented:

```
run A  →  gate WAITING  →  you answer  →  run B starts     ← evidence orphaned
```

`cw run start` refuses to open a second run while one is active. A parked run is
resumed by answering the question, and `cw gate pass` returns focus to the phase
that owns the gate. Retiring a run is deliberate and audited:
`cw run abandon --message "<why>"` (a stated reason is required when a gate is
still open), or `cw run start <wf> --force --reason "<why>"`.

---

## 10. `.ai-workflow` explained

Actual layout of an installed, in-progress project:

```
.ai-workflow/
├── config.json           runtime settings (see below)
├── README.md             short explanation, written by the installer
├── installed.json        install manifest (version, preset, managed files)
├── current-run           id of the active run, e.g. "fc-20260803-001"
├── sessions.json         Claude session id → run id
├── policy-health.json    is the PreToolUse gate policy actually running
├── hook-errors.log       hook failures (only if any occurred)
├── quarantine.jsonl      audit of runs retired as unreadable
├── conventions/          code.md comments.md testing.md database.md metadata.json
├── workflows/            optional: project workflow definitions that override built-ins by id
└── runs/
    └── fc-20260803-001/
        ├── state.json            machine-owned run state — never hand-edit
        ├── events.jsonl           append-only semantic + runtime event log
        ├── evidence.md
        ├── business-decision.md
        ├── implementation-plan.md
        ├── impact-risk-scope.md
        ├── test-strategy.md
        ├── validation.md
        ├── review.md
        ├── assessment.md
        └── final-report.md
```

(`root-cause.md` appears instead of `evidence.md` in a `bug-fix` run.)

| Path | What it is | Commit? |
| --- | --- | --- |
| `conventions/` | Shared repository knowledge, reused by every task | **Commit it** |
| `workflows/` | Your workflow definitions | **Commit it** (if you add any) |
| `config.json` | Runtime settings; holds an absolute `runtimeUrl` valid only on this machine | Machine-local — gitignored by default |
| `current-run`, `sessions.json`, `hook-errors.log`, `installed.json` | Machine-local bookkeeping | Gitignored by default |
| `runs/` | Per-task evidence | Local by default (`runs/.gitignore` ignores everything). Delete that file if you want run evidence in git |
| `state.json`, `events.jsonl` | Owned by the `cw` CLI | Never hand-edit |

`config.json` keys worth knowing:

| Key | Default | Meaning |
| --- | --- | --- |
| `runtimeDir` | `.ai-workflow` | Runtime root, relative to the project |
| `runtimeUrl` | set at install | Absolute URL of the workflow-core entry the hook imports |
| `monitorPort` | `4173` | Monitor port |
| `stallThresholdSeconds` | `120` | Silence before `POSSIBLY_STALLED` |
| `semanticLagThresholdSeconds` | `300` | Runtime activity without a transition before `SEMANTIC_LAG` |
| `autoGenericRun` | `true` | Open a `generic` run for a prompt that belongs to no workflow |
| `enforceGates` | `true` | Deny mutation behind an open gate. `false` ⇒ policy reports `DISABLED` |
| `mutationTools`, `mutationToolPatterns` | see file | File-writing tools and MCP name patterns |
| `commandTools` | `Bash`, `PowerShell`, … | Tools that run commands |
| `readOnlyCommands`, `readOnlyGitSubcommands` | see file | Allowlists behind an open gate |
| `allowTestCommandsBehindGate`, `testCommands` | `true`, `npm`/`pytest`/… | The documented soft edge of the gate |
| `preset`, `version` | `senior-dev`, kit version | Recorded by the installer |

---

## 11. Conventions

**Why cache them.** Re-deriving how a repository writes code, comments, tests
and migrations on every task is slow and inconsistent. The cache makes it a
one-time cost, and makes divergence visible.

Files under `.ai-workflow/conventions/`:

| File | Content |
| --- | --- |
| `code.md` | architecture, naming, structure, patterns |
| `comments.md` | language, placement, docblocks, when comments are expected |
| `testing.md` | frameworks, layout, what is tested and how |
| `database.md` | schema, migration and data conventions |
| `metadata.json` | per area: `status`, `last_refresh`, `evidence` files, plus `repo_shape` |

**Bootstrap or refresh** (inside Claude Code):

```
/refresh-conventions                  # all areas
/refresh-conventions testing database # selected areas
```

**Inspect** (from a shell):

```bash
cw conventions status
```

Freshness is **computed**, not claimed: the CLI re-checks that every recorded
evidence file still exists and has not been modified since `last_refresh`.

| Status | Meaning | What to do |
| --- | --- | --- |
| `OK` | Present, and every evidence file still exists and is unchanged | Reuse it |
| `MISSING` | No cached file for the area | `/refresh-conventions <area>` |
| `UNRECORDED` | File exists, but `metadata.json` records no `last_refresh` — freshness cannot be verified | `/refresh-conventions <area>` |
| `STALE` | Evidence files are gone or were modified after the last refresh | `/refresh-conventions <area>` |
| `INVALID` | `metadata.json` is unusable for the area (bad status value, non-ISO timestamp, absolute or escaping evidence path, `OK` with no evidence) | Fix the metadata, then refresh |

Real output on a fresh install:

```
conventions  /path/to/project/.ai-workflow/conventions
metadata     missing — run /refresh-conventions
✕ code      MISSING    no cached convention — run /refresh-conventions
✕ comments  MISSING    no cached convention — run /refresh-conventions
✕ testing   MISSING    no cached convention — run /refresh-conventions
✕ database  MISSING    no cached convention — run /refresh-conventions

refresh needed: /refresh-conventions code comments testing database
precedence: local intentional convention near the touched code > this cache > generic external skill
```

**Precedence, highest first:**

1. a local intentional convention in the code being touched;
2. this repository's convention cache;
3. a generic default or external style skill.

An external generic skill never overrides a convention this repository
demonstrably follows.

> **Limitation.** The cache *content* is written by the model. Only its
> freshness and metadata shape are verified by code.

---

## 12. `cw` CLI reference

`cw` is installed by the `claude-workflow-kit` package. Global flags on every
command: `--project <dir>`, `--runtime <dir>`, `--session <id>`, `--json`.
`cw --help` prints the full list.

### Run

| Command | Purpose |
| --- | --- |
| `cw run start <workflow> [--label "…"] [--id <runId>] [--force] [--reason "…"]` | Open a run. Refused while another run is active, or while the current run is unreadable |
| `cw run show [--run <id>] [--json]` | One-line (or full JSON) view of a run |
| `cw run list [--json]` | Every run; `*` marks the active one; exits 1 if any run is unreadable |
| `cw run complete [--run <id>]` | Finish a run — **validated**, see [§13](#13-run-lifecycle) |
| `cw run fail [--run <id>] [--message "…"]` | Mark a run failed |
| `cw run abandon [--run <id>] [--message "…"]` | Retire a run. A reason is required if a gate is still open |
| `cw run claim [<runId>] --session <id> [--force] [--reason "…"]` | Take ownership of a run |
| `cw run transfer [<runId>] --to <sessionId> [--reason "…"]` | Hand a run to another session |
| `cw run quarantine-current [--run <id>] --reason "…"` | Retire an unreadable run without deserialising it; files are preserved |

```bash
$ cw run start feature-change --label "edit Liên lạc"
fc-20260803-001 feature-change RUNNING node=User Prompt claude=UNKNOWN

$ cw run start bug-fix
cw: cannot start "bug-fix": 1 run(s) still active: fc-20260803-001 (feature-change,
    RUNNING, "edit Liên lạc"). Continue it (cw status), finish it (cw run complete),
    retire it (cw run abandon), or override with:
    cw run start bug-fix --force --reason "<why>"
```

### Phase

| Command | Purpose |
| --- | --- |
| `cw phase enter <node> [--force]` | Move into a phase. Refused for an edge the workflow forbids, or while a declared artifact is missing |
| `cw phase complete [node]` | Complete a phase. Same artifact contract |
| `cw phase skip <node> [--message "…"]` | Mark a phase skipped |
| `cw phase fail [node] [--message "…"]` | Fail a phase (and the run) |

Both `enter` and `complete` accept `--allow-missing-artifacts --reason "<why>"`
— an audited exception, not a shortcut.

```bash
$ cw phase enter implementation
cw: cannot enter "implementation" from "business": no edge business -> implementation.
    Allowed: readiness
```

### Gate

| Command | Purpose |
| --- | --- |
| `cw gate wait <GATE> [--message "…"]` | Park the run on the user. Only from the phase that owns the gate |
| `cw gate pass <GATE>` | Open the gate. Requires the owning phase to be current and its declared artifact to exist as a non-empty file. **No `--force`** |
| `cw gate override <GATE> --reason "…"` | Deliberate, audited override. Reported as an override afterwards |
| `cw gate fail <GATE> [--message "…"]` | Fail the gate and the run |

```bash
$ cw gate pass BUSINESS_READY
cw: gate "BUSINESS_READY" requires evidence from "business": missing or unusable
    business-decision.md in the run directory
    (deliberate override: cw gate override BUSINESS_READY --reason "<why>")
```

### Reporting

| Command | Purpose |
| --- | --- |
| `cw status [--json]` | "Where am I": phase, gates, Claude state, next transitions, missing artifacts, mutation state. Exit `2` + `CORRUPT` if the active run is unreadable |
| `cw review-context [--run <id>] [--json]` | Canonical pointers for a reviewer (run dir, spec, plan, tests, validation, diff command) |
| `cw policy [--json]` | Is the `PreToolUse` policy actually running? Exit 1 if `DEGRADED` |
| `cw conventions status [--json]` | Convention cache report |
| `cw workflows [--json]` | Available workflow definitions |
| `cw note "<message>"` | Append a note event to the run |
| `cw artifact <filename>` | Record that an artifact was written |
| `cw init-runtime` | Create the runtime directory skeleton |

```bash
$ cw status
run       fc-20260803-001 (Feature Change)
status    RUNNING
phase     Business Decision [ACTIVE]
gates     BUSINESS_READY=OPEN
claude    UNKNOWN
next      await-business [!BUSINESS_READY], readiness [BUSINESS_READY]
artifacts evidence.md
missing   business-decision.md (declared by this phase)
mutation  DENIED until BUSINESS_READY pass (repository writes and arbitrary commands;
          declared artifact writes stay allowed)
```

### Monitor and installer (through `cw`)

| Command | Purpose |
| --- | --- |
| `cw monitor [--port <n>] [--host <h>] [--project <dir>] [--runtime <dir>]` | Start the live monitor |
| `cw init` / `cw update` / `cw doctor` / `cw uninstall` | Aliases for the `claude-workflow-kit` installer commands |

| Installer command | Purpose |
| --- | --- |
| `claude-workflow-kit init [--preset …] [--runtime …] [--port …] [--no-hooks] [--no-claude-md] [--dry-run]` | Install into a project |
| `claude-workflow-kit update` | Refresh managed skills/agents/hooks/rules, keeping existing config values |
| `claude-workflow-kit doctor [--monitor-url <url>] [--json]` | Verify the installation. Exit 1 on any `✕` |
| `claude-workflow-kit uninstall [--purge]` | Remove managed content. Keeps `.ai-workflow/` unless `--purge` |

### Runtime plumbing (hooks use these, you normally do not)

| Command | Purpose |
| --- | --- |
| `cw hook [--event <HookName>]` | Apply a Claude Code hook payload read from stdin |
| `cw event <EVENT_TYPE> [--tool X] [--agent Y] [--message Z]` | Record a runtime event manually |

### Environment

| Variable | Effect |
| --- | --- |
| `CW_STRICT=0` | Relaxes **graph transitions only**: an illegal `phase enter` becomes a recorded `FORCED_TRANSITION`. It never passes a gate, never skips artifact validation, never bypasses ownership, never completes a run |
| `CW_SESSION` / `CLAUDE_SESSION_ID` | Default caller identity for `--session` |

---

## 13. Run lifecycle

Stored run statuses: `RUNNING`, `WAITING_USER`, `COMPLETED`, `FAILED`,
`ABANDONED`. The last three are terminal — nothing may be recorded against them.
`POSSIBLY_STALLED` and `SEMANTIC_LAG` are **derived at read time** and never
stored.

```
                 cw run start
                      │
                      ▼
   ┌────────────►  RUNNING  ─────────────┐
   │                 │  │                │
   │  gate pass /    │  │ gate wait      │ run fail / phase fail
   │  answer         │  ▼                ▼
   │            WAITING_USER          FAILED
   │                 │
   │─────────────────┘
                      │ cw run complete (validated)
                      ▼
                  COMPLETED            ABANDONED ← cw run abandon
                                                   cw run start --force
```

What happens when…

| Event | Result |
| --- | --- |
| **Claude starts a session** | `SessionStart` is recorded. It never opens a run — a session that only starts leaves nothing behind |
| **You send a normal prompt** | `UserPromptSubmit`. With no active run and `autoGenericRun: true`, a `generic` run opens so the monitor has something to attach activity to. It has no gates and is completed on `SessionEnd` |
| **A controlled workflow begins** | The skill runs `cw run start <workflow>`; `current-run` points at it; the session that first reports activity becomes its owner |
| **The workflow needs a decision** | `cw gate wait <GATE>` → gate `WAITING`, run `WAITING_USER`, the run parks on a `waiting` node, Claude asks you one question |
| **You answer** | The **same** run continues: back to the owning phase, artifact written, `cw gate pass <GATE>`, waiting node settled |
| **The workflow completes** | `cw run complete` is **verified**: every gate passed, every phase completed or skipped, nothing waiting on the user, the run at the workflow's end, every required artifact present. There is no `--force` |
| **You abandon a run** | `cw run abandon --message "<why>"`. A reason is required while a gate is open; the unpassed gates go into the event log. `ABANDONED` never reads as success |
| **You start another workflow while one is active** | Refused, with the options printed. `--force` abandons the previous run explicitly; if it was behind an open gate, `--reason` is required too |
| **The active run's `state.json` is corrupt** | `cw status` exits `2` with `CORRUPT` (not "no active run"), and a new run is refused. Retire it with `cw run quarantine-current --reason "corrupt state"` — the corrupt files are preserved and an audit line is written |

---

## 14. Hooks

Hooks exist for one job: report what Claude Code is doing, and enforce the gate
at the moment a tool is about to run. `claude-workflow-kit init` merges 12 hook
entries into `.claude/settings.json`, all pointing at
`.claude/hooks/cw-hook.mjs`.

| Hook | Recorded as | Used for |
| --- | --- | --- |
| `SessionStart` | `SESSION_START` | Claude is active. Never opens a run |
| `SessionEnd` | `SESSION_END` | Claude is idle; closes a `generic` run |
| `UserPromptSubmit` | `PROMPT_SUBMIT` | Prompt activity; the only event that may open a `generic` run |
| `PreToolUse` | `TOOL_START` | **Mutation policy** + current tool |
| `PostToolUse` | `TOOL_END` | Tool finished OK |
| `PostToolUseFailure` | `TOOL_FAIL` | Tool failed |
| `SubagentStart` | `SUBAGENT_START` | A subagent is running (shown on the node) |
| `SubagentStop` | `SUBAGENT_STOP` | Subagent finished |
| `TaskCreated` | `TASK_CREATED` | Task activity |
| `TaskCompleted` | `TASK_COMPLETED` | Task activity |
| `Stop` | `TURN_COMPLETE` | Turn ended |
| `StopFailure` | `TURN_FAILED` | Turn failed |

Runtime statuses these produce: `UNKNOWN`, `IDLE`, `ACTIVE`, `TOOL_RUNNING`,
`SUBAGENT_RUNNING`, `STOPPED`, `FAILED`.

> **Important.** Hooks tell the kit *what Claude is doing*. Hooks do **not**
> decide the business phase. Only a skill, calling `cw phase enter` / `cw gate …`,
> moves the semantic state.

**Failure behaviour.** The hook must never break a session, so any internal
failure is logged to `.ai-workflow/hook-errors.log` and the process exits 0 with
no output — which Claude Code reads as "no opinion", i.e. as an allow. Because a
crashed policy is indistinguishable from a permitted call, the failure is also
persisted to `policy-health.json` as `DEGRADED`, which `cw policy` reports,
`doctor` reports as a failure, and the monitor shows as a header badge.

---

## 15. Gate enforcement and limitations

> **This toolkit is a workflow guardrail, not an OS-level security sandbox.**
> It constrains a cooperating agent working through Claude Code's tool surface.
> It does not contain a process that is determined to write a file.

| Surface | Guarantee |
| --- | --- |
| Structured file writes (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `apply_patch`, `str_replace_editor`, `create_file`, MCP writers matching the configured pattern) | **Enforced.** Denied behind an open gate for every path except the current phase's declared artifacts |
| Command execution (`Bash`, `PowerShell`, `Shell`, `Terminal`, `run_command`, `Monitor`) | **Enforced for the enumerated tool surface.** Behind an open gate only allowlisted read-only programs run. Redirection, command substitution, pipes into writers, interpreters (`node -e`, `python -c`, `awk`, `env VAR=x cmd`) and write-capable flags (`find -delete`, `fd -x`, `sort -o`) are refused. A command tool absent from `commandTools` is **not covered** |
| Test and build commands | **Deliberately allowed — the documented soft edge.** `npm test`, `npm run <script>`, `make`, `pytest`, `cargo build` and friends run behind an open gate. They cannot edit source directly, but a package script or Makefile target can, and runners generate coverage, caches and updated snapshots. Set `allowTestCommandsBehindGate: false` for a strict gate |
| Gate data | **Checked, not asserted.** `cw gate pass G` requires: the run is at the phase that owns `G` (or at a waiting node it legitimately reached through that phase), the phase has been entered at least once, and every artifact it declares exists as a **non-empty regular file**. A directory named `business-decision.md` and a zero-byte file are both rejected |
| Gate override | **Explicit and audited.** `cw gate pass` has no `--force`. `cw gate override G --reason "…"` writes `GATE_OVERRIDE` to the event log, prints a warning, records the reason in the run state, and is surfaced by `cw status` so the final report can disclose it |
| Workflow artifacts | **Enforced centrally.** Leaving a phase is refused while its declared artifacts are missing or unusable, and so is any transition made after an earlier *completed* phase's evidence disappeared. `--allow-missing-artifacts --reason "…"` records `ARTIFACT_CONTRACT_OVERRIDE` |
| Retiring a run behind an open gate | **Explicit and audited, not prevented.** `cw run abandon` / `cw run start --force` require a stated reason and record the unpassed gates. Withdrawing a task is legitimate; doing it silently is not |
| `COMPLETED` | **Verified.** All gates passed, all phases completed or skipped, nothing waiting on the user, at the workflow's end, all required artifacts present. No `--force` |
| Multi-session | **Repository mutation: project-wide.** Any active run with an open gate blocks *every* session. **Semantic commands: enforced through the hook**, which knows the calling session — `cw` run outside Claude Code has no identity and is only advisory. Recovery: `cw run claim` / `cw run transfer` |
| `CW_STRICT=0` | Relaxes graph transitions only. Never passes a gate, skips artifact validation, bypasses ownership, or completes a run |
| Enforcement liveness | **Reported, because it fails open.** A crashed hook = an allow, so the failure is recorded as `policyHealth: DEGRADED` (`cw policy`, `doctor`, monitor badge). `enforceGates: false` reports `DISABLED` |
| Reviewer independence | **Contract, not code.** The kit can require `review.md` and hand the reviewer only pointers (`cw review-context`); it cannot force the model to actually spawn the subagent |
| Semantic phase accuracy | **Model-emitted, monitored.** Phases advance because a skill runs `cw`. A skipped or batched call shows up as `SEMANTIC_LAG`; the kit reports it rather than inferring a phase |
| Conventions | **Advisory content, computed freshness.** Cache validity is a filesystem fact; the text inside is model-written |

---

## 16. Troubleshooting

| Problem | Meaning | What to do |
| --- | --- | --- |
| `no active run` | No run is open in this project | Normal. Start one with `/feature-change`, `/bug-fix` or `/work` |
| `cannot start "<wf>": 1 run(s) still active` | One run at a time, on purpose | `cw status` — continue it, `cw run complete` it, or `cw run abandon --message "<why>"`. Override: `cw run start <wf> --force --reason "<why>"` |
| `Blocked by claude-workflow-kit: … unpassed gate(s)` | A gate is open; repository writes and non-read-only commands are denied | Finish the gate phase, write its artifact, `cw gate pass <GATE>`. Do not look for a tool that gets through |
| Run status `WAITING_USER` | Claude asked you a decision and parked the run | Answer in the same session. The same run resumes; do not start a new one |
| `SEMANTIC_LAG` pill | Claude is working but no phase transition for > `semanticLagThresholdSeconds` | Check the node's runtime line and current tool. Ask Claude to emit the phase it is actually in; nothing is broken, the diagram is behind |
| `POSSIBLY_STALLED` | No event at all for > `stallThresholdSeconds` | Check the Claude session is alive. If it is dead: `cw run abandon --message "session died"` |
| `cannot enter "X" from "Y": no edge Y -> X` | An illegal transition | Follow `next` in `cw status`. `cw phase enter <node> --force` records a `FORCED_TRANSITION` if you really must |
| `gate "G" requires evidence from "<phase>": missing or unusable <file>` | The artifact is absent, empty, or a directory | Write a non-empty file at `<runDir>/<file>`, then pass the gate |
| `required artifact(s) missing or unusable` on `phase complete` | The phase's declared evidence is not on disk | Write it. `--allow-missing-artifacts --reason "…"` is audited, not a shortcut |
| `conventions: refresh needed: …` | Cached areas are missing, stale or unverifiable | `/refresh-conventions <areas>` inside Claude Code |
| `policy DEGRADED` | The `PreToolUse` hook crashed and is failing **open** — gates are not being enforced | `cw policy` for details, `.ai-workflow/hook-errors.log` for the stack, then `claude-workflow-kit doctor`. Common cause: `runtimeUrl` no longer importable ⇒ `claude-workflow-kit update` |
| `policy DISABLED` | `enforceGates: false` in `config.json` | Set it back to `true` if you want gates enforced |
| `active run "<id>" is CORRUPT` (exit 2) | `state.json` cannot be read as a run — **not** "no active run"; new runs are refused | Inspect the file and restore it, or `cw run quarantine-current --reason "corrupt state"` (preserves the files, clears the pointer, writes an audit line) |
| Monitor shows `CORRUPT: <run>` | Same, from the UI | Same recovery |
| Monitor page does not open | Server not running, or wrong port | `cw monitor`, then open the URL it prints (default http://127.0.0.1:4173). Check with `curl http://127.0.0.1:4173/api/health` |
| `monitor UI is not built. Run: npm run build` | Serving from a source checkout without a built UI | `npm run build`, or use the API endpoints |
| Port 4173 busy | Another monitor or unrelated service | `cw monitor --port 4174`, or change `monitorPort` in `config.json` |
| Monitor stays empty while Claude works | `cw` is not resolvable in Claude Code's shell, or hooks are not wired | `claude-workflow-kit doctor` (checks hooks, skills, `runtimeUrl`); install `cw` globally so skills can call it |
| `doctor`: `runtimeUrl … cannot import` | The kit moved or was reinstalled elsewhere | `claude-workflow-kit update` |
| `doctor`: `runtime pointer` mismatch | A `--runtime <dir>` install and `.claude/cw-runtime` disagree, so hooks look in the wrong place | `claude-workflow-kit update --runtime <dir>` |

---

## 17. Practical daily usage

**A feature or business-rule change**

```
/feature-change
<short business requirement>
```

**A defect**

```
/bug-fix
<symptom + expected behaviour>
```

**Not sure which**

```
/work
<task>
```

**Check state after a break**

```
/wf-status
```

You do **not** need to ask for any of this — the workflow already carries it:

- analyse the code and the requirements first;
- reconcile contradictions between docs, DB, code and tests;
- get the business decision explicit before coding;
- for bugs, establish the root cause before fixing;
- plan impact, risk, scope and tests before implementation;
- reuse this repository's conventions instead of generic style;
- validate with evidence, then verify E2E;
- review the diff independently;
- report compactly, without an execution diary.

Adding "please analyse first, then plan, then test, then review" only makes the
prompt longer. Describe the *business outcome* instead — that is the input the
workflow actually needs.

---

## 18. Real example

**Request**

```
/feature-change
Cho phép chỉnh sửa Liên lạc không gắn dòng báo cáo.
```

**Evidence Analysis** looks for: where a Liên lạc is created and updated; whether
"gắn dòng báo cáo" is a nullable link, a status, or a separate table; which
screens list and edit it; which permissions guard editing; whether requirement
documents describe editing at all; whether existing tests assert that editing is
blocked. It writes what it found, with file references, and marks each conclusion
FACT / INFERENCE / ASSUMPTION / PROPOSAL.

It surfaces two contradictions:

- `C-001` — the requirement document says a Liên lạc is immutable after creation,
  while the code already allows updating the Tag field.
- `C-002` — a test asserts "no edit after report link", but only for the linked
  case; the unlinked case is untested.

**Business ambiguity.** "Chỉnh sửa" is not yet a decision: which fields, and what
happens to an unlinked record that later gets linked? The gate parks and asks one
question — Problem / Impact / Recommended resolution / Decision required — and
the run shows `WAITING_USER`. No code changes while it waits; the hook denies
them.

**Your answer**

```
Chỉ cho sửa Liên lạc không gắn dòng báo cáo.
Cho sửa nội dung và Tag.
```

**Resolved decision** (`business-decision.md`) — editing is permitted only while
the Liên lạc has no report-line link; editable fields are content and Tag;
attempting to edit a linked record is rejected with the existing permission
error; once linked, the record becomes immutable again; existing linked-record
behaviour is unchanged; the requirement document's blanket immutability rule is
recorded as outdated for the unlinked case.

**Planning** (`implementation-plan.md`, `impact-risk-scope.md`,
`test-strategy.md`) — the layers to touch (validation rule, service, API
contract, edit form), the indirect impact (list and detail screens, filters,
export, audit history), the risks (a record linked concurrently between load and
save; legacy rows with inconsistent link state), the explicit out-of-scope items
(bulk edit, editing linked records), and the tests to write: unlinked edit
succeeds, linked edit rejected, link-after-load race rejected, audit entry
written, legacy rows unaffected.

**Implementation** — the smallest change inside that scope. No refactoring of
neighbouring code, no "while I'm here" improvements.

**Validation** (`validation.md`) — the actual commands and their actual output,
mapped to each confirmed rule, plus an E2E pass through the real edit flow.

**Independent review** (`review.md`) — a separate agent reads the resolved
specification, the plan, the test strategy, the validation evidence and the diff
itself (never the implementer's summary), and returns `PASS` or `FAIL` with
findings. Correctness findings go back to implementation; maximum three loops.

**Outcome** (`final-report.md`) — what changed, the key decision (unlinked-only
editing, content and Tag), the validation evidence including E2E, remaining risks
(the concurrency window is guarded but legacy rows with inconsistent link state
still exist), and follow-ups recorded in `assessment.md` as separate tasks rather
than smuggled into this diff.

---

## 19. Development guide

For maintainers of the kit itself.

```bash
npm install            # workspaces: 5 packages
npm run build          # typecheck + emit all packages, and build the monitor UI bundle
npm test               # unit tests: workflow-core, installer, monitor-ui graph model
npm run e2e            # install into a temp copy of examples/demo-project and drive a full run
npm run dev:monitor    # UI on :5173 with hot reload, proxying /api to a `cw monitor` on :4173
npm run clean          # drop dist/ from every package
```

What each validates:

| Command | Validates |
| --- | --- |
| `npm run build` | Types compile; the monitor UI bundle exists (the server needs it to serve HTML) |
| `npm test` | State machine transitions, gate and artifact rules, installer merge behaviour, graph model derivation |
| `npm run e2e` | The real thing: a fresh install into a temp project, the installed hook script invoked exactly as Claude Code invokes it (payload on stdin, `CLAUDE_PROJECT_DIR` only, working directory deliberately elsewhere), a full `feature-change` run driven through `cw`, and the monitor server's reported state |
| `npm run dev:monitor` | UI work without rebuilding the bundle |

### Packages

| Package | Purpose |
| --- | --- |
| `@claude-workflow-kit/workflow-core` | Workflow YAML definitions, state machine, run store, mutation policy, convention inspection, event schema, the `cw` CLI |
| `@claude-workflow-kit/claude-adapter` | The `senior-dev` preset: skills, agents, hook script, `CLAUDE.md` block, settings template |
| `@claude-workflow-kit/monitor-server` | Run discovery, JSON API, SSE stream, derived statuses (no runtime dependencies) |
| `@claude-workflow-kit/monitor-ui` | React + React Flow live diagram |
| `claude-workflow-kit` | The published package: `init` / `update` / `doctor` / `uninstall`, plus the `cw` binary |

Further reading: [architecture and design decisions](docs/architecture.md) ·
[preset mapping](docs/preset-senior-dev.md) ·
[migrating an existing project](docs/migration.md)

---

## 20. Extending the toolkit

### A new workflow

Workflow topology is data. The state machine and the diagram read the same file,
so a new phase is a YAML edit — no UI work.

Drop a definition in `.ai-workflow/workflows/<id>.yaml` (a project definition
overrides a built-in with the same `id`):

```yaml
id: spike
label: Spike
description: Time-boxed investigation with a decision gate.

nodes:
  - id: prompt
    label: User Prompt
    kind: start

  - id: investigate
    label: Investigate
    skill: wf-evidence-reconciliation
    artifact: evidence.md
    description: Read-only investigation.

  - id: decide
    label: Decision
    skill: wf-business-decision
    gate: SPIKE_DECIDED
    artifacts:
      - business-decision.md
    description: Resolve what to do with the finding.

  - id: await-decide
    label: Waiting For User
    kind: waiting
    gate: SPIKE_DECIDED

  - id: done
    label: Done
    kind: end

edges:
  - { from: prompt, to: investigate }
  - { from: investigate, to: decide }
  - { from: decide, to: await-decide, when: "!SPIKE_DECIDED", label: blocked }
  - { from: await-decide, to: decide, label: answered }
  - { from: decide, to: done, when: SPIKE_DECIDED }
```

Rules the loader enforces at load time:

- `kind` ∈ `start` | `phase` (default) | `waiting` | `end`;
- a `waiting` node **must** declare a gate;
- node ids are unique, and every edge endpoint must exist;
- an edge condition (`GATE` or `!GATE`) must reference a gate some node declares;
- `artifact: x.md` and `artifacts: [x.md, y.md]` are both accepted.

Then `cw workflows` lists it, `cw run start spike` opens it, and the monitor draws
it. Gates, artifact contracts and completion validation all apply automatically —
they are derived from the definition, not written per workflow.

### A new skill

A skill is `.claude/skills/<name>/SKILL.md` with YAML frontmatter. Minimal
template for a workflow step:

```markdown
---
name: wf-my-step
description: One sentence on what this step does and when the workflow uses it.
user-invocable: false      # a wf-* step: the model invokes it, you do not
effort: high               # reasoning effort for this step
---

What the step must do, in imperative form.

Persist the result to `.ai-workflow/runs/<runId>/my-step.md` and record it with
`cw artifact my-step.md`.

Return the result to the calling workflow. Do not write a long report to the user.
```

For a **user entry point** instead use `disable-model-invocation: true` (you type
it; the model cannot invoke it) and add `argument-hint: "[what to pass]"`.

Skills you create by hand in `.claude/skills/` are yours: the installer only
manages the files listed in `.ai-workflow/installed.json`, and `uninstall`
removes only those. To ship a skill **with** the kit, add its directory under
`packages/claude-adapter/presets/senior-dev/skills/` and list its name in
`preset.json`.

### A new phase in an existing workflow

```
workflow YAML  →  declared artifact  →  skill that writes it  →  monitor topology
   (edit)            (enforced)             (new or existing)      (automatic)
```

1. Add the node (with `skill:` and, if it owns evidence, `artifact:`) and rewire
   the edges.
2. Point it at a skill that persists that artifact.
3. If it owns a gate, add the matching `waiting` node and the two conditional
   edges.
4. Update the workflow body skill (`wf-feature-change` / `wf-bug-fix`) so the
   phase is actually entered — the body is the script that emits transitions.

The monitor needs no changes: it renders whatever the definition contains.

### Configuration

Everything policy-related lives in `.ai-workflow/config.json` — mutation tools,
MCP name patterns, command allowlists, test commands, thresholds, port. Adding
a tool your setup uses (a new MCP writer, a different shell tool) is a config
edit, not a code change.

---

## 21. Known limitations

- **Semantic phase progress depends on the model.** Phases advance because a
  skill runs `cw phase enter` / `cw gate …`. A skipped or batched call leaves the
  diagram behind reality; the kit flags `SEMANTIC_LAG` and never guesses a phase
  from tool calls.
- **The monitor reports; it does not correct.** There is no endpoint that changes
  a run. Semantic lag, stalls and corrupt runs are surfaced for a human to act on.
- **Indirect mutation protection is best-effort.** Command-line analysis covers
  redirection, substitution, interpreters, dangerous flags and multiplexer
  subcommands — but it is static analysis of a string, not containment.
- **Test and build commands run behind an open gate** by default, and they can
  generate files. `allowTestCommandsBehindGate: false` closes that edge.
- **Arbitrary MCP mutation is not a security boundary.** MCP writers are matched
  by a name pattern (`^mcp__.*(write|edit|create|…)`); a writer whose name does
  not match is not recognised until you add it to `config.json`.
- **One controlled run per project (per runtime directory).** Deliberate — it is
  what stops evidence from being orphaned — but it means no parallel workflows in
  one worktree. Use separate worktrees.
- **Session ownership is only enforced through the hook.** `cw` invoked outside
  Claude Code has no session identity, so the ownership check there is advisory.
- **Independent reviewer independence is contract- and prompt-enforced.** The kit
  requires `review.md` and supplies pointers instead of a summary; it cannot force
  the model to spawn the subagent.
- **Convention content is model-written.** Only cache freshness and metadata shape
  are verified by code.
- **The hook fails open.** A broken kit must never block work, so a crashed
  `PreToolUse` hook allows the call — and records `DEGRADED` so you find out.
- **`cw` must be on `PATH`** for skills to record anything; `doctor` does not
  check that, it only checks the hook wiring and the importable `runtimeUrl`.
- **One preset ships** (`senior-dev`), and its skills are copied at install time.
  `claude-workflow-kit update` refreshes them; local edits to managed skill files
  are overwritten.

---

## License

MIT
