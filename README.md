# Claude Workflow Kit

**A risk-adaptive development workflow for Claude Code — fast for small tasks,
controlled for high-risk changes, with standardized reports and a live diagram.**

Claude Workflow Kit installs into any repository and adds:

- **Mission Control routing** — a task is classified by type, complexity and risk, then routed to the shortest safe workflow (Lightning, Fast, Standard, Deep, Research); see [§22](#22-mission-control);
- **evidence and confidence gates** — the implementation phase is refused while evidence is missing or contradictory, a threshold is unmet, or a CRITICAL risk is open;
- **human checkpoints with teeth** — a pending or unopened mandatory checkpoint denies repository writes, on every topology, not just the gated ones;
- **an interactive Mission Board** — approve, reject, ask for more evidence, pause, resume or cancel from the monitor, without typing a command;
- **L0-L3 task routing** — trivial and small work stay small; full gates are L3-only;
- **analysis-first handoff** — free-form business/source analysis stops for approval, then feeds feature implementation without repeating discovery;
- **proportional verification** — targeted tests first, E2E only when risk justifies it;
- **business/root-cause gates** — enforced for full high-risk workflows;
- **reusable skills** — analysis, planning, implementation, validation, review;
- **persisted run context** — full workflows write evidence; fast paths do not owe documents;
- **a repository convention cache** — discovered once, reused across tasks;
- **standard report templates** — quick by default, detailed and audience-aware on request;
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
| [6. Workflow guide](#6-workflow-guide) | `/quick-fix`, `/feature-change`, `/bug-fix`, `/work`, … |
| [7. Phase by phase](#7-phase-by-phase) | the real graph, every phase explained |
| [8. Skills reference](#8-skills-reference) | all 24 skills |
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
| [22. Mission Control](#22-mission-control) | routing, checkpoints, monitors, the board |

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
.claude/skills/          19 workflow skills (entry points + wf-* steps)
.claude/agents/          business-analyst, root-cause-analyst, independent-reviewer
.claude/hooks/cw-hook.mjs
.claude/settings.json    kit hooks merged into your existing settings
.claude/cw-runtime       records the runtime directory name
.ai-workflow/            runtime: config.json, conventions/, templates/, runs/
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
✓ skills                22 installed
✓ report templates      15 installed
✓ analysis artifact templates  seven-file solution-analysis contract available
✓ agents                3 installed
✓ CLAUDE.md             managed block present
✓ workflow definitions  bug-fix, feature-change, generic, quick-fix, solution-analysis, standard-change
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

### Step 4 — Bootstrap conventions (optional once per repository)

Inside Claude Code:

```
/refresh-conventions
```

This reads representative code and writes `code.md`, `comments.md`,
`testing.md`, `database.md` and `metadata.json` into
`.ai-workflow/conventions/`.

Do this **once per repository when a shared cache is useful**. It is not a
prerequisite for L0-L1 work. Later tasks reuse valid areas and refresh only the
relevant guidance that is absent, invalid, or materially stale.

### Step 5 — Run your first task

Inside Claude Code:

```
/work
Cho phép chỉnh sửa Liên lạc tạo độc lập.
Liên lạc gắn dòng báo cáo giữ nguyên.
```

This bounded multi-layer change normally classifies as L2:

```
Prompt
  ↓
Targeted Impact            direct and necessary downstream boundaries only
  ↓                         (may briefly wait on one material decision)
Implementation
  ↓
Risk-based Validation      targeted → integration/manual only when justified
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
| `WAITING_USER` | A user decision is pending. It may be an L2 advisory wait or an L3 parked gate; inspect `gates` / `mutation` |
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
| `GET /api/state` | live snapshot: workflows, unfinished runs in full plus the most recent finished ones, policy health |
| `GET /api/runs?status=&workflow=&skill=&q=&sort=&offset=&limit=` | paged history from the derived index |
| `GET /api/runs/<runId>` | run + workflow + newest events + artifacts + rollup |
| `GET /api/runs/<runId>/events?after=<cursor>&limit=` | one page of the event log; `after: 0` starts at the beginning |
| `GET /api/runs/<runId>/rollup` | folded counts for one run |
| `GET /api/analytics` | totals, success rate, durations, per-workflow and per-skill statistics |
| `GET /api/runs/<runId>/artifacts/<name>` | raw artifact file |
| `GET /api/stream` | SSE `snapshot` events |

The live snapshot deliberately does not carry history: it is rebuilt every
second, so it holds work in progress, and everything older is answered from
`/api/runs`, which reads a derived index instead of every `state.json`.

---

## 3. Test the monitor in 5 minutes

Use a deliberately ambiguous L3 request (authorization + existing-data impact),
so the full business gate has to stop and ask.

**1. Start the monitor** and open http://127.0.0.1:4173.

**2. In Claude Code, send:**

```
/feature-change
Thay đổi authorization chỉnh sửa Liên lạc cho MNG/owner và áp dụng cho dữ liệu
legacy. Chưa quyết định MNG được sửa loại Liên lạc nào.
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
| `Validation` → optional `E2E` → `Independent Review` | Risk-based evidence, then review (`review.md`) |
| `Product Assessment` → `Final Report` → `Done`, run `COMPLETED` | Verified completion |

> **Tip.** The run list is the fastest correctness check for the whole kit: one
> prompt must produce **one** run. If answering a question creates a second run,
> something re-entered the workflow instead of resuming it.

---

## 4. Core concepts

**Workflow** — an ordered development process, defined as data (YAML): nodes,
edges, gates, and the artifacts each phase must produce. Shipped:
`solution-analysis`, `feature-change`, `bug-fix`, `standard-change`, `quick-fix`,
`generic`.

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

**Mission** — the Tech Lead layer over a run: its classification (task type,
complexity, risk, workflow class), plan, evidence status, confidence per
dimension, risks, decisions, task breakdown, deliverables and checkpoints. Stored
inside the run's `state.json`, written only through `cw mission …`. See
[§22](#22-mission-control).

**Checkpoint** — a state the mission stops in because only the user may decide.
Unlike a gate, it is not tied to the topology, so it works on `quick-fix` and
`standard-change` too; while one is pending, repository writes are denied.

**Mission Board** — the organised view of all of that (`cw board`, or the right
panel in the monitor), including the buttons that approve, reject, pause, resume
or cancel.

---

## 5. Core rules

### Classify first; pay only for the risk

Every engineering task is classified before execution:

| Level | Meaning | Path |
| --- | --- | --- |
| L0 | trivial/mechanical local change | understand → change → minimal verify |
| L1 | bounded small fix | root cause when needed → fix → targeted verify |
| L2 | bounded multi-file or multi-layer change | targeted impact → implement → proportional verify |
| L3 | migration/data/auth/security/payment/concurrency/cross-service/critical compatibility or broad flow | full controlled workflow |

The level can rise when investigation finds concrete hidden risk. Evidence is
carried forward and completed analysis is not repeated. Report depth is
independent: an L1 task may need a detailed report, while an L3 status answer may
stay short.

### L3 only: NO BUSINESS DECISION = NO CODING

In a full L3 run, the desired behaviour must be explicit enough to answer:
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

### L3 bugs: NO ROOT CAUSE = NO FIX

The full L3 `bug-fix` workflow adds `ROOT_CAUSE_READY` in front of everything else.
Reproduce where feasible, trace the current/legacy flow, explain *why* the
symptom occurs, and separate symptom / contributing factor / root cause. Both
gates must pass before an L3 defect fix can touch a file. L1 and L2 defects still
need a causal explanation, without full gate artifacts unless risk escalates.

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

Classify the task before choosing depth. A one-line UI fix does not need a full
workflow; a bounded FE+BE change still does not automatically need L3 gates.

Mission Control does this classification for you and prints what it decided —
`cw mission route --type … --complexity …` shows the same answer without touching
a run. The class names below map onto these topologies: Lightning and Fast →
`quick-fix`, Standard → `standard-change`, Deep → `bug-fix`/`feature-change`,
Research → `solution-analysis`. See [§22](#22-mission-control).

| Workflow | Phases | Gates | Typical cost |
| --- | --- | --- | --- |
| `/quick-fix` / L0-L1 | triage → fix → validate | none | minutes |
| `/solution-analysis` | intake → business/source/impact/options/plan → approval stop | `ANALYSIS_APPROVED` | analysis session; no code |
| `standard-change` / L2 | targeted impact → implementation → validation | none | bounded session |
| full `bug-fix` / L3 | 10 phases, E2E conditional | `ROOT_CAUSE_READY`, `BUSINESS_READY` | full session |
| full `feature-change` / L3 | 10 phases, E2E conditional | `BUSINESS_READY` | full session |

### `/solution-analysis`

Use this when the deliverable is business analysis, source-aligned impact,
solution comparison, and a plan—not implementation yet. Paste free-form text;
the skill parses goal, behavior, scope, constraints, acceptance criteria, open
questions, and assumptions. It reads the current source and convention cache,
creates seven required artifacts, then stops at `ANALYSIS_READY`.

After explicit approval, `cw analysis handoff` creates a trace-linked
`feature-change`. A hash check of relevant source files must be `VALID` before
`BUSINESS_READY` opens. Material changes produce `STALE`, block implementation,
and require only the affected analysis sections to be refreshed.

#### A delivered design document as source of truth

When the input is a detailed design document (TKCT, BRD, spec) rather than a
chat message, put the file in the repository first — a path outside the project
cannot be fingerprinted — and run `/solution-analysis` on it. Alongside the usual
artifacts the run produces `spec-map.md`, one row per verifiable requirement:

```text
| ID       | Requirement                  | Design Ref            | Code Paths         |
| -------- | ---------------------------- | --------------------- | ------------------ |
| SPEC-001 | Orders above 10M get 5% off  | docs/design/x.md#4.2  | src/order/price.ts |
| SPEC-002 | Round the total down to 1000 | docs/design/x.md#4.3  | src/order/price.ts |
```

Every design document the map cites is hashed by `cw analysis ready`, whether or
not `--source` listed it. From then on the design document is treated exactly
like source: edit it and the linked feature run reports `STALE`, `BUSINESS_READY`
reopens, and the affected rows must be re-checked before implementation resumes.

Later work asks the map what it is bound by:

```bash
cw spec check --files "src/order/price.ts"
# 2 requirement(s) from docs/design/x.md
#   src/order/price.ts  SPEC-001 SPEC-002
```

`UNCOVERED` means no approved requirement claims that file — either the change
is outside the approved scope, or the map is missing a row. Entering the
implementation phase prints the same drift as `cw: spec drift — …` warnings:
unclaimed requirements, changed design documents, unreadable rows. These warn and
never block. The map is written by the same model whose work it describes, so the
hard gate stays on the source fingerprint, where the evidence is independent.

### `/quick-fix`

**Use when** the requested outcome is already clear and the scope is L0 or L1:
an explicit small bug fix, a visibility condition, a duplicate import, a
z-index/layout fix, a flag that does not behave as documented.

**Input example**

```
/quick-fix
Cho MNG hiển thị nút Tạo Action. BE hiện tại đã cho phép tạo.
```

```
/quick-fix
Chip Liên lạc đang import Communication 2 lần, sửa lại.
```

**What Claude does**

1. Opens a run (`cw run start quick-fix`).
2. **Triage** — inspects the direct code path only: the relevant component, its
   nearest condition/helper, the backend authorisation *only if the request
   depends on it*, the nearest existing test. No repository scan, no requirement
   documents, no git history, no convention discovery. Root cause is one concise
   conclusion, not a document.
3. **Fix** — the smallest causal change. No unrelated refactor, no adjacent
   fixes, no new abstraction, no new tests or docs unless directly required or
   requested.
4. **Validate** — focused: nearest test, cheap typecheck/build, or one runtime
   probe. Then a lightweight diff check (intended change present, nothing
   unrelated, validation passed). No full E2E, no reviewer agent.

**Can it stop and ask?** Normally **no questions at all**. Your stated outcome is
authoritative when it is explicit — "cho MNG được tạo Action" is a decision
already made, not a question to re-ask. Several implementation options are not a
reason to stop; materially multi-layer scope is a reason to escalate to L2, not
to invent a business blocker.

**Can it escalate?** Yes, but only on concrete evidence. Bounded multi-file/
multi-layer impact or a cause outside the narrow path goes L1 → L2 and continues
through `standard-change`. Migration/data/auth/security/payment/concurrency/
cross-service/critical compatibility or broad flow risk goes to an L3 bug or
feature workflow. `cw run escalate` changes topology in place: the same `runId`,
evidence directory, owner, and event log continue, while any stricter L3 gates
open. It carries the files, trace, and conclusions already gathered; analysis
does not restart from zero and the prior work is not mislabeled `ABANDONED`.

**Main output** — the diff plus a quick report with only applicable sections:

```
Level:      L0 or L1
Cause / Reason: <one sentence for an L1 defect; omitted for mechanical L0>
Changed:    <what changed>
Verification: <what was actually run>
Manual verify: <actions and expected results, only when needed>
Remaining risk: <evidence-backed risk, only when present>
```

No artifacts are written by default. If you explicitly ask for a detailed
report, the same small task uses the matching standardized template.

**When not to use** — the behaviour itself is being decided, a migration is
involved, or you cannot state the expected result in one sentence. Because
`quick-fix` carries no gates, never use it to get past one: `cw run start` refuses
to open it while a gated run is active, and forcing a gated run aside still
requires a stated reason.

### `standard-change` (L2 internal body)

**Use when** impact is meaningful but bounded: several files, FE+BE, a local API
contract, query, permission/state behavior, or integration within a clear
boundary. `/work`, `/feature-change`, and `/bug-fix` route here automatically;
there is no separate user command.

**What Claude does**

1. **Targeted impact** — traces only affected and necessary downstream layers;
   establishes a causal root cause for defects and stops when evidence is enough.
2. Waits for one concise business decision only if two material behaviors are
   plausible and context cannot select safely. This is not a hard gate.
3. **Implementation** — smallest maintainable change within the understood
   boundary.
4. **Risk-based validation** — targeted checks first, affected-package checks or
   integration when useful, E2E only for a real remaining critical-path gap.

No readiness documents, convention skill, reviewer, assessment, mandatory E2E,
or report artifact. Manual UI verification is a valid completed outcome with
actions and expected results.

### `/feature-change`

**Use when** you know the request is a feature/change. The entry skill still
classifies it: L0-L1 → quick, L2 → standard, L3 → full controlled feature flow.

**Input example**

```
/feature-change
Cho phép chỉnh sửa Liên lạc tạo độc lập.
Liên lạc gắn dòng báo cáo giữ nguyên.
```

**For an L3 change, Claude**

1. Opens a run (`cw run start feature-change`).
2. Reconciles evidence across intent, documents, DB, code and tests → `evidence.md`.
3. Resolves the business behaviour behind `BUSINESS_READY` → `business-decision.md`.
4. Plans impact, risk, scope and tests → three artifacts.
5. Loads relevant cached conventions; refreshes only guidance that is absent,
   invalid, or materially stale for this change.
6. Implements the smallest correct change.
7. Validates against the risk-based strategy; runs E2E only when it closes a
   stated critical-path or cross-layer gap.
8. Hands the diff to the `independent-reviewer` agent → `review.md`.
9. Assesses the result → `assessment.md`; reports → `final-report.md`.

**Can it stop and ask?** Yes — at the business gate, when a genuine product
decision would materially change the implementation. The run parks in
`WAITING_USER` and resumes in place when you answer.

**Main output** — quick report by default or the requested detailed template,
plus the L3 evidence chain in the run directory.

The command selects change semantics, not automatic full-workflow depth.

### `/bug-fix`

**Use when** existing behavior is wrong. The entry skill classifies it: L0-L1 →
quick, L2 → standard, L3 → the full controlled defect flow.

**Input example**

```
/bug-fix
Sửa Liên lạc gắn dòng báo cáo vẫn lưu được.
Expected: chặn, báo lỗi. Actual: lưu thành công.
```

**For an L3 defect, Claude**

1. Opens a run (`cw run start bug-fix`).
2. Reproduces where feasible, traces the current/legacy flow, separates symptom
   from contributing factors from root cause → `root-cause.md`, behind
   `ROOT_CAUSE_READY`.
3. Resolves the expected behaviour the fix must produce → `business-decision.md`,
   behind `BUSINESS_READY`.
4. Then the L3 path: readiness → conventions → implementation → validation →
   conditional E2E → review → assessment → report.

**Can it stop and ask?** Yes, twice: when the root cause cannot be established
from available evidence, and when expected behaviour is a genuine product
decision.

**Main output** — `root-cause.md` plus a quick or requested detailed report.

**When not to use** — the behaviour is not actually a defect but a requirement
change (use `/feature-change`).

### `/work`

**Use when** you have a task and do not want to pick a workflow.

**Input example**

```
/work
Người dùng không xoá được Liên lạc đã gắn báo cáo — không rõ là bug hay thiếu tính năng.
```

**What Claude does** — routes analysis-only requests to `wf-solution-analysis`;
otherwise classifies L0-L3 from evidence, not keywords, then invokes
exactly one body: `wf-quick-fix`, `wf-standard-change`, or the appropriate L3
`wf-bug-fix`/`wf-feature-change`. It does not broadly audit before choosing a
cheap path. A report-only request goes straight to `wf-final-report` and opens no
engineering run.

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

### Quick and detailed reporting

Execution level and report depth are independent. Completion uses a quick report
unless you explicitly ask for a report, document, handover, release note,
review/impact/test report, BRD/TKCB comparison, or an audience-specific
deliverable. Detailed mode reuses one of the nine files in
`.ai-workflow/templates/` and preserves its heading order, terminology, status
vocabulary, and tables.

Existing project templates are never overwritten by `update`; deleted defaults
are restored. Reports distinguish Automated / Manual / Not Verified and use
`Not applicable` or `Unknown from current scope` rather than inventing content.

---

## 7. Phase by phase

### `feature-change` (14 nodes, L3 only; freshness is handoff-only)

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
                    │     │             │
       E2E justified│     └────────────►│ E2E not justified
                    ▼                   │
                   e2e                  │
                    │                   │
                    ▼                   │
                  review  ── review.md──┘   (agent: independent-reviewer)
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

### `quick-fix` (5 nodes)

No gates, no waiting nodes, no declared artifacts — which is exactly why it is
cheap, and why escalation rather than gate-bypass is the safety mechanism.

```
prompt  (start)
   │
   ▼
triage      ← direct code path only; escalates out if the narrow path breaks
   │
   ▼
 fix  ◄──────────┐  focused failure
   │             │
   ▼             │
validate ────────┘
   │
   ▼
 done  (end)
```

### `standard-change` (6 nodes, L2)

No gates or required artifacts. It can park briefly on an advisory clarification
without turning every medium change into a hard-gated run.

```text
prompt → impact ─────────────→ implementation → validation → done
           │                        ▲              │
           ▼                        └──────────────┘ task-caused failure
     await-decision
           │ answered
           └────────→ impact
```

### `bug-fix` (14 nodes, L3 only)

Identical, except the run starts with a root-cause gate:

```
prompt → root-cause ── root-cause.md      gate ROOT_CAUSE_READY
             │  ↕ await-root-cause (waiting)
             ▼
         business ── business-decision.md  gate BUSINESS_READY
             │  ↕ await-business (waiting)
             ▼
         readiness → conventions → implementation → validation
             → [e2e when justified] → review → assessment → report → done
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

- **Purpose** — runtime/end-to-end verification only when a stated critical
  journey or remaining cross-layer coverage gap justifies it. Otherwise the
  phase is explicitly skipped with the reason.
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

- **Purpose** — a quick report by default; when the user requested a detailed
  document, reuse the matching template and audience without changing execution
  depth.
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

24 skills ship in the `senior-dev` preset. "User can call?" reflects the actual
frontmatter: entry points are marked `disable-model-invocation: true` (you type
them, the model cannot invoke them), `wf-*` step skills are marked
`user-invocable: false` (the reverse).

| Skill | User can call? | Purpose | Called by | Main output |
| --- | :---: | --- | --- | --- |
| `work` | ✅ | Mission Control router: classify type/complexity/risk, publish the Mission Header, route one body | you | invokes one matching body |
| `solution-analysis` | ✅ | Free-form analysis, or a delivered detailed design document | you | seven artifacts + `ANALYSIS_READY` |
| `quick-fix` | ✅ | Entry point for the short workflow | you | invokes `wf-quick-fix` |
| `feature-change` | ✅ | Risk-adaptive feature/change entry | you | quick / standard / full feature body |
| `bug-fix` | ✅ | Risk-adaptive defect entry | you | quick / standard / full bug body |
| `refresh-conventions` | ✅ | Bootstrap/refresh the convention cache | you | `conventions/*.md` + `metadata.json` |
| `wf-status` | ✅ | Report the current run, gates, next transitions | you | `cw status` interpretation |
| `wf-feature-change` | ❌ | Full L3 feature body | `feature-change`, `work` | full evidence chain |
| `wf-solution-analysis` | ❌ | Analysis-only workflow body | `solution-analysis`, `work` | seven-file handoff contract |
| `wf-feature-from-analysis` | ❌ | Freshness + approved feature continuation | approved analysis handoff | implementation without re-analysis |
| `wf-bug-fix` | ❌ | Full L3 defect body | `bug-fix`, `work` | full evidence chain |
| `wf-standard-change` | ❌ | Gate-free L2 body | routed entry skills | impact → implementation → proportional validation |
| `wf-quick-fix` | ❌ | L0-L1 body | routed entry skills | diff + quick or requested detailed report |
| `wf-evidence-reconciliation` | ❌ | Reconcile intent/docs/DB/code/tests | `wf-feature-change` | `evidence.md` |
| `wf-bug-root-cause` | ❌ | Reproduce, trace, establish causal root cause | `wf-bug-fix` | `root-cause.md` |
| `wf-business-decision` | ❌ | Resolve business behaviour (hard gate) | both bodies | `business-decision.md` |
| `wf-change-readiness` | ❌ | Plan, impact, risk, scope, test strategy | both bodies | 3 artifacts |
| `wf-convention-manager` | ❌ | Cache-first convention reuse | both bodies | loaded conventions |
| `wf-implement` | ❌ | Smallest correct change; review handoff contract | both bodies | the diff |
| `wf-validation-e2e` | ❌ | Risk-based validation; optional E2E | L3 bodies | `validation.md` |
| `wf-product-assessment` | ❌ | Post-implementation, evidence-backed findings | both bodies | `assessment.md` |
| `wf-final-report` | ❌ | Quick/detailed report router | workflows or report-only request | template-backed report when requested |
| `wf-mission-board` | ❌ | Keep the board honest: state, action, confidence, evidence, risk, tasks, off-track, context | every body | an accurate `cw board` |
| `wf-checkpoint` | ❌ | Open/resolve human checkpoints; record decisions with evidence and alternatives | every body | `CHECKPOINT_*` + `DECISION_RECORDED` |

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
**Produces** — `validation.md`: Automated / Integration / Manual / Not Verified /
Unrelated Failures / E2E Decision, with actual evidence. E2E is `REQUIRED` or
`NOT JUSTIFIED` with a concrete risk reason.
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
**Produces** — a stable quick report, or `final-report.md` rendered from the
matching reusable template for bug, implementation, feature, impact, test,
review, change, release, or business audiences. Never hides unverified areas.
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

**1. Context is persisted, not remembered.** Every evidence-producing phase
persists its declared artifacts in the run directory; lightweight phases may
declare none. A later phase reads those artifacts. This survives context
compaction, a new session, and a reviewer that must not trust the implementer.
The runtime enforces declared artifacts: `cw phase complete` and the next
`cw phase enter` are both refused while one is missing or empty, and so is any
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
that owns the gate. Risk escalation also preserves the task run:
`cw run escalate <higher-workflow> --reason "<concrete finding>"`. A generic run
opened by the prompt hook is promoted in place when routing selects its workflow.
Retiring a run is reserved for a task that is actually withdrawn and is audited:
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
├── templates/            15 report, intake, and analysis artifact templates
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
| `conventions/` | Shared repository knowledge, reused when relevant | **Commit it** |
| `templates/` | Shared report structures; existing project versions are reused on update | **Commit it** |
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
`STALE` is a review signal; refresh only when the relevant guidance may have
materially changed. One or two intentional local files can be sufficient for a
bounded task.

| Status | Meaning | What to do |
| --- | --- | --- |
| `OK` | Present, and every evidence file still exists and is unchanged | Reuse it |
| `MISSING` | No cached file for the area | Refresh when the relevant task cannot establish the local pattern cheaply |
| `UNRECORDED` | File exists, but `metadata.json` records no `last_refresh` — freshness cannot be verified | Review the relevant area; refresh if shared guidance is needed |
| `STALE` | Evidence files are gone or were modified after the last refresh | Check whether the change is material to this task; refresh only then |
| `INVALID` | `metadata.json` is unusable for the area (bad status value, non-ISO timestamp, absolute or escaping evidence path, `OK` with no evidence) | Fix/refresh the relevant area before relying on it |

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

Mission Control commands (`cw mission …`, `cw checkpoint …`, `cw board`) are
listed in [§22.8](#228-command-summary).

### Run

| Command | Purpose |
| --- | --- |
| `cw run start <workflow> [--label "…"] [--id <runId>] [--force] [--reason "…"]` | Open a run. A prompt-hook `generic` run is routed in place; a non-generic active or unreadable run is refused by default |
| `cw run escalate <workflow> --reason "…" [--run <id>]` | Raise L1→L2/L3 or L2→L3 in the same task/run; preserves evidence and opens the target topology's gates |
| `cw run show [--run <id>] [--json]` | One-line (or full JSON) view of a run |
| `cw run list [--json]` | Every run; `*` marks the active one; exits 1 if any run is unreadable |
| `cw run complete [--run <id>]` | Finish a run — **validated**, see [§13](#13-run-lifecycle) |
| `cw run fail [--run <id>] [--message "…"]` | Mark a run failed |
| `cw run abandon [--run <id>] [--message "…"]` | Retire a run. A reason is required if a gate is still open |
| `cw run claim [<runId>] --session <id> [--force] [--reason "…"]` | Take ownership of a run |
| `cw run transfer [<runId>] --to <sessionId> [--reason "…"]` | Hand a run to another session |
| `cw run quarantine-current [--run <id>] --reason "…"` | Retire an unreadable run without deserialising it; files are preserved |
| `cw rollup [--run <id>] [--json]` | Folded counts for a run: tools, files, commands, tests, governance, usage |
| `cw index rebuild` / `cw index show` | Rebuild (or list) the derived history index used by the Run Explorer |
| `cw usage sync [--run <id>] [--json]` | Read this run's token usage from Claude Code's session transcript; runs sync automatically when they end |

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
| `cw analysis ready [--source "path[,path...]"]` | Validate seven artifacts, snapshot relevant source plus every design document `spec-map.md` cites, and stop for approval |
| `cw analysis approve --solution "…" --scope "…"` | Persist explicit solution/scope approval |
| `cw analysis handoff` | Create a trace-linked feature-change run; never automatic |
| `cw analysis freshness` | Mark the linked analysis `VALID` or `STALE` from source hashes |
| `cw analysis refresh --source "…" --reason "…"` | Record a targeted stale-analysis refresh, then recheck |
| `cw spec check [--files "a,b"] [--json]` | Which design requirements govern those files, plus unclaimed rows and changed design documents |
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
| `claude-workflow-kit update` | Add missing components and refresh hash-proven framework files; preserve customized/legacy conflicts and existing config |
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
   │  answer /       │  │ decision wait  │ run fail / phase fail
   │  gate pass      │  ▼                ▼
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
| **A controlled workflow begins** | The skill runs `cw run start <workflow>`. If the prompt hook already opened `generic`, it becomes the selected workflow with the same run id (`RUN_ROUTED`); otherwise a run opens. The session that first reports activity becomes its owner |
| **L2 needs an advisory decision** | The run enters an explicit advisory `waiting` node and becomes `WAITING_USER`; no gate opens and repository mutation is not denied |
| **L3 needs a gated decision** | `cw gate wait <GATE>` → gate `WAITING`, run `WAITING_USER`, the run parks on its gate-bound `waiting` node |
| **You answer** | The **same** run continues through the declared return edge. A hard-gated wait also writes its evidence and runs `cw gate pass <GATE>` |
| **The workflow completes** | `cw run complete` is **verified**: every gate passed, every phase completed or skipped, nothing waiting on the user, the run at the workflow's end, every required artifact present. There is no `--force` |
| **You abandon a run** | `cw run abandon --message "<why>"`. A reason is required while a gate is open; the unpassed gates go into the event log. `ABANDONED` never reads as success |
| **You start another workflow while one is active** | A `generic` prompt run is routed in place. Any other active run is refused, with options printed; `--force` abandons it explicitly, and an open gate also requires `--reason` |
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
| Run status `WAITING_USER` | Claude asked you a decision and parked the run; `gates` / `mutation` distinguish advisory L2 from hard-gated L3 | Answer in the same session. The same run resumes; do not start a new one |
| `SEMANTIC_LAG` pill | Claude is working but no phase transition for > `semanticLagThresholdSeconds` | Check the node's runtime line and current tool. Ask Claude to emit the phase it is actually in; nothing is broken, the diagram is behind |
| `POSSIBLY_STALLED` | No event at all for > `stallThresholdSeconds` | Check the Claude session is alive. If it is dead: `cw run abandon --message "session died"` |
| `cannot enter "X" from "Y": no edge Y -> X` | An illegal transition | Follow `next` in `cw status`. `cw phase enter <node> --force` records a `FORCED_TRANSITION` if you really must |
| `gate "G" requires evidence from "<phase>": missing or unusable <file>` | The artifact is absent, empty, or a directory | Write a non-empty file at `<runDir>/<file>`, then pass the gate |
| `required artifact(s) missing or unusable` on `phase complete` | The phase's declared evidence is not on disk | Write it. `--allow-missing-artifacts --reason "…"` is audited, not a shortcut |
| `conventions: refresh needed: …` | Cached areas are missing, stale or unverifiable | Review only areas relevant to the task; refresh when local evidence is insufficient or guidance materially changed |
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

**A small, explicit fix** — the common case, and the cheap one

```
/quick-fix
<the change + its expected result>
```

**A feature or business-rule change** — still classified L0-L3

```
/feature-change
<short business requirement>
```

**A defect** — still classified L0-L3

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

**See where the mission stands, and what it is waiting for**

```bash
cw board          # classification, monitors, the open checkpoint, blockers
```

**Answer the question it is blocked on**

Answer in chat, or click Approve / Modify / Reject / More evidence on the Mission
Board in the monitor. A pending checkpoint denies repository writes until you do
— that is the point ([§22.14](#2214-answering-a-checkpoint)).

You do **not** need to prescribe phases. The router classifies risk, stops
investigation when evidence is enough, reuses local/cached conventions, and
chooses targeted, integration, manual, or E2E verification proportionally.
Describe the outcome and any real constraints.

> **Tip — do not pay for phases you do not need.** For "make this button visible
> for MNG; the API already allows it", the L1 path gives triage → fix → targeted
> validation. A bounded FE+BE change uses L2. Only concrete high-risk evidence
> activates the full gated path.

---

## 18. Real example

**Request**

```
/feature-change
Cho phép chỉnh sửa Liên lạc không gắn dòng báo cáo, đồng thời migrate dữ liệu
legacy và giữ tương thích cho API client cũ.
```

The migration and compatibility requirements make this L3. Without them, the
bounded UI/API behavior would normally take the L2 path.

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

**Validation** (`validation.md`) — actual targeted migration, service/API,
compatibility, and integration checks mapped to each rule. It records whether a
real-flow E2E still closes a meaningful gap; if not, E2E is skipped with the
reason and any quick manual check is listed with its expected result.

**Independent review** (`review.md`) — a separate agent reads the resolved
specification, the plan, the test strategy, the validation evidence and the diff
itself (never the implementer's summary), and returns `PASS` or `FAIL` with
findings. Correctness findings go back to implementation; maximum three loops.

**Outcome** (`final-report.md`) — what changed, the key decision (unlinked-only
editing, content and Tag), the actual validation evidence and E2E decision, remaining risks
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
- a `waiting` node must either set `advisory: true` explicitly or bind to a
  declared hard gate; it cannot do both;
- a waiting node settles only through its declared resume edge or gate decision,
  never by `cw phase complete/skip`;
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
  `claude-workflow-kit update` refreshes only hash-proven unmodified framework
  files; customized or ambiguous legacy files are preserved and reported.

---

## 22. Mission Control

Mission Control is the layer that decides *how much workflow* a task deserves and
then holds the work to it. The topology answers "which phase is this run in"; the
mission answers what a Tech Lead actually asks: what kind of task is this, how
deep a process does it need, what evidence exists, how confident is the
conclusion, which risks are live, and what still needs a human decision.

Everything here lives inside the same run (`state.json`) and is written only
through `cw mission …` / `cw checkpoint …`.

**Reference:** [22.1 router](#221-the-router) ·
[22.2 checkpoints](#222-checkpoints-have-teeth) ·
[22.3 evidence & confidence](#223-evidence-confidence-and-the-implementation-gate) ·
[22.4 monitors](#224-monitors) · [22.5 the board](#225-the-board) ·
[22.6 mission state](#226-mission-state) ·
[22.7 deliverables](#227-deliverables-and-completion) ·
[22.8 commands](#228-command-summary)

**Guide:** [22.9 day-to-day](#229-day-to-day-who-does-what) ·
[22.10 Lightning](#2210-worked-example-a--lightning-a-label) ·
[22.11 Standard](#2211-worked-example-b--standard-with-a-checkpoint) ·
[22.12 Deep](#2212-worked-example-c--deep-with-a-gate-and-checkpoints) ·
[22.13 Research](#2213-worked-example-d--research-no-code) ·
[22.14 answering](#2214-answering-a-checkpoint) ·
[22.15 reading the board](#2215-reading-the-board) ·
[22.16 when it blocks you](#2216-when-it-blocks-you) ·
[22.17 upgrading](#2217-upgrading-an-existing-install) ·
[22.18 tuning](#2218-tuning) ·
[22.19 limits](#2219-what-mission-control-does-not-do)

### 22.1 The router

```bash
# dry run: what would this task cost?
cw mission route --type permission --complexity high --flags permission-or-security,cache-invalidation
```

```text
workflow    DEEP (feature-change)
risk        HIGH
effort      VERY_LARGE
checkpoints PLAN, INVESTIGATION, ARCHITECTURE, DESIGN, HIGH_RISK, CODE, RELEASE
validation  build, compile, unit-test, integration-test, scoped-regression, permission-test, security-review
skipped     type-check, targeted-static-check, …, migration-check, rollback-check
thresholds  requirement>=70% scope>=70% businessRule>=80% architecture>=80% design>=70% implementation>=75%
template    permission-report.md
reason      complexity HIGH -> DEEP
```

`cw mission classify` records the same decision on the run, and escalates the run
in place when the routed topology is deeper than the current one — same run id,
same evidence directory, same event history.

| Class | Topology | For |
| --- | --- | --- |
| `LIGHTNING` | `quick-fix` | label, copy, CSS, spacing, icon, static content |
| `FAST` | `quick-fix` | small validation, small CRUD/API, bounded defect |
| `STANDARD` | `standard-change` | multi-file or multi-layer bounded change |
| `DEEP` | `bug-fix` / `feature-change` | permission, security, migration, architecture, wide refactor |
| `RESEARCH` | `solution-analysis` | analyse, compare, recommend; no code is written |

**Complexity sets the floor; nothing lowers it.** Declared risk, high-risk task
types (`security`, `permission`, `authentication`, `authorization`, `migration`,
`architecture`) and the structural flags can only raise the class. A user asking
for a deeper path always wins. The single exception is `--flags analysis-only`,
which routes to `RESEARCH` because nothing is built.

Structural flags: `database-change`, `api-contract-change`,
`permission-or-security`, `migration`, `backward-compatibility`,
`data-loss-risk`, `production-impact`, `multi-module`, `architecture-change`,
`analysis-only`, `review-before-apply`, `deployment`, `cache-invalidation`,
`breaking-change`, `multiple-solutions`.

### 22.2 Checkpoints have teeth

The mandatory checkpoint list is *derived* from the classification, so it cannot
be argued away. Kinds: `PLAN`, `INVESTIGATION`, `ROOT_CAUSE`, `ARCHITECTURE`,
`DESIGN`, `HIGH_RISK`, `CODE`, `RELEASE`.

```bash
cw checkpoint open DESIGN --summary "two export contracts are plausible" \
  --decision "rename the field or keep the legacy one" \
  --recommend "keep the legacy field, add the new one" --risk medium --confidence 80

cw checkpoint resolve CP-001 --action approve --note "keep the legacy field"
```

While any of these is true, the `PreToolUse` hook denies repository writes and
non-read-only commands — on `quick-fix` and `standard-change` as much as on the
gated L3 topologies:

- a blocking checkpoint is `PENDING` (every kind except `RELEASE`);
- a *mandatory* pre-implementation checkpoint was never opened;
- the mission is `PAUSED`;
- an evidence area the mission itself marked `MISSING`, `CONFLICTING` or `OUTDATED`.

Read-only investigation, test/build commands and `cw` itself keep working — the
mission is expected to keep gathering evidence while it waits.

`reject` and `modify` require a note. Only the user's answer closes a checkpoint,
from chat or from the board. Silence is never approval.

### 22.3 Evidence, confidence and the implementation gate

Evidence status per area: `NOT_REQUIRED`, `MISSING`, `PARTIAL`, `SUFFICIENT`,
`CONFLICTING`, `OUTDATED`. `PARTIAL` warns; `MISSING`/`CONFLICTING`/`OUTDATED`
block.

Confidence dimensions: `requirement`, `scope`, `businessRule`, `architecture`,
`rootCause`, `design`, `implementation`, `testing`, `release`. Floors scale with
depth, so a label change never owes six numbers:

| Class | Floors |
| --- | --- |
| `LIGHTNING` / `RESEARCH` | `requirement` 70, `scope` 70 |
| `FAST` | + `implementation` 75 |
| `STANDARD` | + `businessRule` 70, `design` 70 |
| `DEEP` | + `architecture` 60 |
| any defect | + `rootCause` 75 |
| permission / security | `businessRule` and `architecture` raised to 80 |

`cw phase enter implementation` (or `fix`) is refused while any floor is unmet, a
dimension is unassessed, evidence is blocking, a checkpoint is unanswered, or a
`CRITICAL` risk is open:

```text
cw: entering "implementation" is refused; the mission is not ready:
  - required DESIGN checkpoint was never opened
  - confidence design is 60% (needs >= 70%)
Resolve them, or take them on deliberately: cw mission accept-risk --reason "<why>"
```

`cw mission accept-risk --reason "…"` is the "Proceed Anyway" of the spec: it
waives exactly the blockers that are listed at that moment, records them as the
user's decision, and keeps showing them as accepted risk on the board. It is not
a way to pass a *gate* — `BUSINESS_READY` and `ROOT_CAUSE_READY` still need
`cw gate pass` with their evidence, or an audited `cw gate override`.

Which node counts as "implementation" is data: a workflow YAML phase may declare
`implementation: true`, and the conventional ids `implementation` and `fix` are
recognised by default.

### 22.4 Monitors

| Monitor | What it reports | How |
| --- | --- | --- |
| Risk | live risks with category, level, trigger, mitigation, and the highest level ever reached | `cw mission risk …` |
| Off-track | investigation has left the mission scope | `cw mission offtrack OFF_TRACK …` |
| Context | the mission can no longer explain its own decisions; a recovery summary | `cw mission context --summary "…" --degraded` |
| Health | `HEALTHY` → `NEEDS_ATTENTION` → `AT_RISK` → `BLOCKED` → `CRITICAL`, derived from the others | `cw board` |
| Progress | weighted by task weight, not task count | `cw mission task add --weight n` |

Risk escalation follows the spec: LOW → MEDIUM warns, MEDIUM → HIGH should open a
checkpoint, HIGH → CRITICAL blocks implementation until it is mitigated or
explicitly accepted. Lowering a risk later never erases `peakLevel`.

### 22.5 The board

```bash
cw board            # organised state: classification, monitors, checkpoints, blockers
cw board --json     # the same view for tooling
cw status           # run + phase + a mission summary
```

In the monitor UI the right-hand panel *is* the board: mission state, progress,
health with its reasons, the pending checkpoint with Approve / Modify / Reject /
More-evidence, blockers with "Proceed anyway", confidence against thresholds,
evidence, risks, task breakdown with per-task skip, decisions, plan, deliverables,
and Pause / Resume / Cancel. Selecting a phase in the diagram swaps the panel for
the phase detail.

Board actions POST to `/api/runs/<id>/actions`:

```
checkpoint.approve | checkpoint.reject | checkpoint.modify | checkpoint.cancel
checkpoint.request-evidence
mission.pause | mission.resume | mission.cancel | mission.accept-risk
mission.return-to-scope | mission.add-to-scope | mission.state
task.skip
```

Reads stay open (`access-control-allow-origin: *`) because this is local
telemetry, but **writes are same-origin only**: any page the user has open could
otherwise POST to localhost and approve a checkpoint on their behalf. A request
carrying a foreign `Origin` gets `403`; a tool with no `Origin` (curl, a script)
is allowed, because it already has the shell access to run `cw` directly.

### 22.6 Mission state

```
RECEIVED → CLASSIFYING → PLANNING → WAITING_PLAN_APPROVAL → INVESTIGATING →
WAITING_INVESTIGATION_APPROVAL → DESIGNING → WAITING_DESIGN_APPROVAL →
READY_TO_IMPLEMENT → IMPLEMENTING → WAITING_CODE_APPROVAL → VALIDATING →
WAITING_RELEASE_APPROVAL → DELIVERING → COMPLETED
                              PAUSED | BLOCKED | CANCELLED | FAILED
```

Illegal jumps are refused (`PLANNING → IMPLEMENTING`), and `--force` records the
jump as forced rather than hiding it. `INVESTIGATING → IMPLEMENTING` *is* legal,
because Lightning and Fast have no design stage. Waiting states, pause, block,
cancel and fail are reachable from any live state — the user's control does not
depend on the phase. A paused mission leaves only through `cw mission resume`,
which restores the state it stood in.

The mission state follows the phase automatically, except while a checkpoint is
pending: the board must keep saying it is waiting on the user until the user
answers. When a forced state and the topology disagree, `cw board` prints the
drift instead of picking a winner.

### 22.7 Deliverables and completion

```bash
cw mission deliverable "Manual test checklist" --reason "UI verification is manual"
cw mission deliverable "Manual test checklist" --status DONE --location "final response"
cw mission deliverable "Changelog" --not-required --reason "internal change"
```

`cw run complete` already verifies gates, phases, artifacts and end reachability;
with a mission it also refuses while a checkpoint is unanswered, a required
deliverable is not `DONE`, a `CRITICAL` risk is open, or the mission is paused or
cancelled. `cw mission cancel --reason "…"` retires the run as `ABANDONED` —
cancelled never reads as success.

### 22.8 Command summary

| Command | Purpose |
| --- | --- |
| `cw mission route --type … --complexity …` | Dry-run the router |
| `cw mission classify --type … --complexity … [--flags …] [--risk …] [--class …] [--no-route]` | Record the classification; escalate the run if the route is deeper |
| `cw mission plan --objective "…" --scope "a,b" [--out-of-scope …] [--assumptions …] [--dependencies …] [--stop-conditions …] [--success …]` | Persist the Execution Plan |
| `cw mission state <STATE> [--force] [--message "…"]` | Move the mission state |
| `cw mission pause [--reason "…"]` / `resume` / `cancel --reason "…"` | Human control |
| `cw mission confidence <dimension> <0-100> [--note "…"]` | Record confidence |
| `cw mission evidence <category> <STATUS> [--note "…"]` | Record evidence status |
| `cw mission risk --category … --level … --trigger "…" [--mitigation …] [--status …]` | Record or update a risk |
| `cw mission decision --decision "…" --reason "…" [--evidence …] [--alternatives …] [--rejected …] [--reversibility …]` | Record a decision |
| `cw mission task add --epic "…" --title "…" [--weight n] [--reason "…"]` | Add a task (a reason is required after the plan) |
| `cw mission task <id> <STATUS>` | Move a task |
| `cw mission offtrack ON_TRACK\|OFF_TRACK [--expected …] [--actual …] [--reason …]` | Off-track monitor |
| `cw mission context [--summary "…"] [--coverage n] [--questions "a;b"] [--degraded]` | Context recovery |
| `cw mission scope --previous "…" --new "…" --reason "…"` | Record a scope change |
| `cw mission deliverable <name> [--not-required] [--status …] [--location …]` | Deliverables contract |
| `cw mission action "<what is happening now>"` | Current Action on the board |
| `cw mission accept-risk --reason "…" [--blockers "a;b"]` | "Proceed Anyway", audited |
| `cw mission template [--type <taskType>]` | Report template for the task type |
| `cw mission show [--json]` | The mission record |
| `cw checkpoint open <KIND> --summary "…" --decision "…" [--recommend …] [--alternatives …] [--evidence …] [--risk …] [--impact …] [--confidence n]` | Open a checkpoint |
| `cw checkpoint resolve <id> --action approve\|reject\|modify\|cancel [--note "…"]` | Record the user's answer |
| `cw checkpoint list [--json]` | Every checkpoint and its status |
| `cw board [--json]` | The Mission Board |

### 22.9 Day-to-day: who does what

You type a task. Claude classifies, plans, and works. You answer checkpoints.
Nobody has to remember the command list — this is what actually happens:

| Step | Who | What |
| --- | --- | --- |
| 1 | you | `/work <task>` (or `/quick-fix`, `/feature-change`, `/bug-fix`, `/solution-analysis`) |
| 2 | Claude | classifies type + complexity + structural flags, asks `cw mission route` |
| 3 | Claude | prints the **Mission Header** and starts the run |
| 4 | you | glance at the header: wrong depth is cheapest to fix here |
| 5 | Claude | investigates, records evidence, confidence, risks, decisions |
| 6 | Claude | opens a checkpoint when a decision is yours; the editor is now blocked |
| 7 | you | answer in chat, or click on the Mission Board |
| 8 | Claude | implements only after the readiness check passes |
| 9 | Claude | validates by the strategy the router picked, then reports |

The Mission Header you should see before any work starts:

```text
Mission: Add tenant filtering to the order export.
Task type: api-change   Subtypes: export
Complexity: MEDIUM   Risk: MEDIUM
Workflow: STANDARD (standard-change)
Reason: API contract changes; impact stays inside the export module.
Required steps: targeted impact -> implement -> unit + integration + scoped regression
Skipped steps: security review, performance check, migration check, E2E
Checkpoints: PLAN, DESIGN
Deliverables: code, targeted tests, manual test checklist
Effort: MEDIUM (engineering effort, not a completion promise)
Next action: read the export service and its API contract
```

If that header says `LIGHTNING` for a permission change, or `DEEP` for a label
change, correct it in one sentence — "this touches the permission cache" — and
Claude re-classifies. The router escalates the same run in place; nothing is lost.

### 22.10 Worked example A — Lightning (a label)

```text
/work
Đổi label "Submit" thành "Gửi yêu cầu" ở màn hình Contact Request.
```

What Claude runs, in order:

```bash
cw run start quick-fix --label "rename Submit on Contact Request"
cw mission classify --type text-label --complexity trivial
# -> LIGHTNING (quick-fix), 0 checkpoints, validation: build, compile, type-check
cw mission plan --objective "rename the submit label" --scope "contact-request screen" \
  --out-of-scope "no API or validation change"
cw phase enter triage
cw mission confidence requirement 95
cw mission confidence scope 90
cw phase enter fix          # allowed: both floors are met
cw phase enter validate
cw run complete
```

What you get: the change, a build result, and a two-line manual check. No
investigation document, no checkpoint, no regression suite. Total mission
overhead: two confidence numbers.

If the same string turns out to be shared by four screens, Claude records it and
raises the class instead of quietly editing all four:

```bash
cw mission offtrack OFF_TRACK --expected "contact request screen" \
  --actual "shared i18n bundle used by 4 screens" --reason "the label is a shared key"
cw run escalate standard-change --reason "shared i18n key affects 4 screens"
```

### 22.11 Worked example B — Standard, with a checkpoint

```text
/work
Export đơn hàng phải lọc theo tenant. Field cũ trong API đang là customer_id.
```

```bash
cw run start standard-change --label "tenant filter on order export"
cw mission classify --type api-change --complexity medium --flags api-contract-change
```

```text
workflow    STANDARD (standard-change)
risk        MEDIUM
checkpoints PLAN, DESIGN
validation  build, compile, unit-test, integration-test, scoped-regression, api-contract-check
thresholds  requirement>=70% scope>=70% businessRule>=70% design>=70% implementation>=75%
template    implementation-report.md
```

Two checkpoints are now **mandatory**, so the editor is already blocked:

```text
Blocked by claude-workflow-kit: run sc-20260805-001 (standard-change): required PLAN
checkpoint was never opened; required DESIGN checkpoint was never opened. Nothing in the
repository may change until those clear. Inspect it with: cw board.
```

That is the design: Claude investigates read-only, then asks.

```bash
cw checkpoint open PLAN --summary "export filter touches the API contract and 2 callers" \
  --decision "approve this scope, or limit it to the internal report only"
```

You answer — in chat ("approved, both callers") or by clicking **Approve** on the
board. Then the design question, which is the one that actually matters:

```bash
cw checkpoint open DESIGN \
  --summary "customer_id is consumed by the partner integration" \
  --decision "rename customer_id to tenant_id, or add tenant_id and keep the old field" \
  --recommend "add tenant_id, keep customer_id for one release" \
  --alternatives "rename now (breaking);add and deprecate (compatible)" \
  --evidence "partner-api/client.ts:41 reads customer_id" \
  --risk medium --confidence 82
```

After both are approved, confidence is recorded and the phase opens:

```bash
cw mission evidence api SUFFICIENT
cw mission evidence backend SUFFICIENT
cw mission confidence requirement 90
cw mission confidence scope 85
cw mission confidence businessRule 85
cw mission confidence design 85
cw mission confidence implementation 80
cw phase enter implementation      # now allowed
```

### 22.12 Worked example C — Deep, with a gate *and* checkpoints

Permission work routes to `DEEP`, which means the V1 hard gates **and** the V2
checkpoints apply. They are different mechanisms and both must clear:

```bash
cw run start feature-change --label "UI visibility per data group"
cw mission classify --type permission --complexity high \
  --flags permission-or-security,cache-invalidation,multi-module
# -> DEEP (feature-change): PLAN, INVESTIGATION, ARCHITECTURE, DESIGN, HIGH_RISK, CODE, RELEASE
```

| Mechanism | Cleared by | Needs |
| --- | --- | --- |
| `BUSINESS_READY` (gate) | `cw gate pass BUSINESS_READY` | `business-decision.md` on disk, from the `business` phase |
| `PLAN` / `INVESTIGATION` / … (checkpoints) | `cw checkpoint resolve … --action approve` | the user's answer |
| confidence floors | `cw mission confidence …` | `businessRule` and `architecture` at **80%** here |

A risk found mid-investigation escalates on the record, and CRITICAL stops the
work outright:

```bash
cw mission risk --id R-001 --category cache --level MEDIUM \
  --trigger "permissions are cached per session"
cw mission risk --id R-001 --category cache --level CRITICAL \
  --trigger "the cache is shared across tenants" --evidence "PermissionCache.ts:88"
# -> implementation is refused until it is mitigated or explicitly accepted
cw mission risk --id R-001 --category cache --level CRITICAL --status MITIGATED \
  --mitigation "invalidate per tenant on role change"
```

Lowering the level later never erases `peakLevel`: the board still shows the risk
reached CRITICAL.

### 22.13 Worked example D — Research (no code)

```text
/solution-analysis
So sánh 2 cách làm audit log: bảng riêng vs event stream. Chưa cần code.
```

```bash
cw run start solution-analysis --label "audit log approach"
cw mission classify --type research --complexity medium --flags analysis-only
# -> RESEARCH (solution-analysis); validation: none — nothing is built
```

The run produces the seven analysis artifacts, records confidence per dimension,
and stops at `ANALYSIS_READY`. Nothing in the repository changes. Implementation
starts only after `cw analysis approve` + `cw analysis handoff`, which creates a
trace-linked `feature-change` run — see [§6](#6-workflow-guide).

### 22.14 Answering a checkpoint

**In chat** — just answer. Claude records it:

```bash
cw checkpoint resolve CP-002 --action approve --note "add tenant_id, keep customer_id"
```

**On the board** — open the monitor (`cw monitor`, default
`http://127.0.0.1:4173`), select the run, and use the checkpoint card:

| Button | Effect |
| --- | --- |
| **Approve** | mission continues to the next state |
| **Modify** | goes back to the phase that produced it; the note says what to change (note required) |
| **Reject** | same, with the decision refused (note required) |
| **More evidence** | recorded as a rejection whose note is the gap to close (note required) |
| **Proceed anyway** | waives the listed blockers as your decision, permanently visible as accepted risk |
| **Pause / Resume** | freezes the repository, then restores the exact state |
| **Cancel mission** | retires the run as `ABANDONED` — never as success (reason required) |

Whatever you type in the note box is sent with the click, so the reason lands in
the event log instead of only in your memory.

### 22.15 Reading the board

```bash
cw board
```

```text
mission     sc-20260805-001 — tenant filter on order export
state       WAITING_DESIGN_APPROVAL (run RUNNING)
workflow    STANDARD via standard-change — api-change
sizing      complexity MEDIUM risk MEDIUM effort MEDIUM
phase       Targeted Impact
action      Reading partner-api/client.ts
progress    45% (5/11 tasks, weighted)
health      BLOCKED — checkpoint CP-002 (DESIGN) is awaiting the user
confidence  requirement=90% scope=85% design=60%<70!
evidence    api=SUFFICIENT backend=SUFFICIENT test=PARTIAL

CHECKPOINT CP-002 [DESIGN] — decision required
  summary     customer_id is consumed by the partner integration
  decision    rename customer_id to tenant_id, or add tenant_id and keep the old field
  recommended add tenant_id, keep customer_id for one release
  …
```

| Field | Read it as |
| --- | --- |
| `state` | mission lifecycle; `WAITING_*` means it is your turn |
| `drift` | the phase and the recorded state disagree — usually a forced state |
| `progress` | `(x/y tasks, weighted)` is real work; `(from mission state)` means no breakdown exists yet |
| `health` | `BLOCKED` = a human decision is open; `AT_RISK` = an open HIGH risk or contradictory evidence; `CRITICAL` = an open CRITICAL risk |
| `confidence` | `design=60%<70!` means below its floor — implementation is refused |
| `evidence` | `MISSING`/`CONFLICTING`/`OUTDATED` deny writes; `PARTIAL` only warns |
| `IMPLEMENTATION BLOCKED` | the exact list the readiness check refuses on |
| `actions` | what the board will accept right now |

`cw status` gives the same summary in three lines; `cw board --json` is the full
structure for tooling.

### 22.16 When it blocks you

Mission Control is *supposed* to block. These are the messages and what each one
actually needs:

| Message | Meaning | Do |
| --- | --- | --- |
| `required PLAN checkpoint was never opened` | the classification made it mandatory | `cw checkpoint open PLAN …`, then answer it |
| `checkpoint CP-001 (DESIGN) is awaiting the user` | your turn | answer in chat or on the board |
| `mission is PAUSED: <reason>` | someone paused it | `cw mission resume` |
| `evidence backend is CONFLICTING` | the mission itself flagged contradictory evidence | resolve it, then `cw mission evidence backend SUFFICIENT` |
| `confidence design has not been assessed` | no number recorded | `cw mission confidence design <n>` — or accept the risk |
| `confidence design is 60% (needs >= 70%)` | genuinely not understood yet | investigate, or `cw mission accept-risk --reason "…"` |
| `CRITICAL risk R-001 … is unresolved` | a stop condition | mitigate (`--status MITIGATED`) or accept explicitly |
| `required deliverable "…" is PENDING` | `cw run complete` refuses | produce it, then `cw mission deliverable "…" --status DONE` |
| `mission state PAUSED -> VALIDATING is not a legal transition` | a paused mission only leaves via resume | `cw mission resume` |
| `a task added after the plan needs --reason` | scope movement without a stated cause | add the reason, or leave it out of scope |
| `Blocked by claude-workflow-kit: … unpassed gate BUSINESS_READY` | a V1 **gate**, not a checkpoint | `cw gate pass BUSINESS_READY` with its artifact, or `cw gate override … --reason` |

Nothing here is worked around by retrying the edit or by finding another shell:
the policy covers file writers, MCP write tools and command tools alike
([§15](#15-gate-enforcement-and-limitations)).

### 22.17 Upgrading an existing install

```bash
npm i -D claude-workflow-kit@latest
npx claude-workflow-kit update
npx claude-workflow-kit doctor
```

`update` refreshes only framework files it can prove are unmodified; anything you
customised is preserved and reported as a conflict to merge by hand. What V2 adds
to an existing project:

- two skills — `wf-mission-board`, `wf-checkpoint`;
- a rewritten `work` skill (the router);
- ten report templates (existing project templates always win);
- new `CLAUDE.md` sections inside the managed block;
- `implementation: true` on the implementation phase of the shipped workflows.

Runs created before V2 keep working: `mission` is optional, and a run without one
behaves exactly as it did in V1 — no checkpoints, no thresholds, gates unchanged.

If you maintain a **project-specific workflow** in `.ai-workflow/workflows/`, mark
its implementing phase so the readiness check knows where the repository starts
changing:

```yaml
- id: build-it
  label: Implementation
  implementation: true
```

Without it, the fallback recognises only the conventional ids `implementation`
and `fix`.

### 22.18 Tuning

| Want | How |
| --- | --- |
| a deeper workflow than the router picked | say so, or `cw mission classify … --class deep` |
| a shallower one | not possible by design — reduce the *facts*: if it truly has no permission impact, do not declare the flag |
| skip a checkpoint | there is no skip; `cw checkpoint resolve <id> --action approve` is the honest version, and it is recorded |
| proceed with a known gap | `cw mission accept-risk --reason "…"` |
| different confidence floors | not configurable: they are derived per workflow class in `mission.ts` (see [§22.3](#223-evidence-confidence-and-the-implementation-gate)) |
| gate enforcement off entirely | `enforceGates: false` in `.ai-workflow/config.json` — the whole policy, including checkpoints; `cw policy` then reports `DISABLED` |
| a different report template | `cw mission template --type <taskType>`, or ask for the deliverable you want |

### 22.19 What Mission Control does not do

- It does not read minds: classification comes from the request, and a wrong flag
  produces a wrong depth. `cw mission route` is cheap — check it.
- It does not verify a confidence number. A model that invents 90% gets past the
  floor; the floor exists to make the *unassessed* case block, and to make the
  accepted-risk case visible.
- It does not enforce checkpoint *quality*. Opening a checkpoint with no real
  decision behind it satisfies the runtime and wastes the user's attention.
- It does not replace the L3 hard gates. `BUSINESS_READY` and `ROOT_CAUSE_READY`
  still need their evidence artifact on disk; `accept-risk` cannot open them.
- Board actions are not authenticated beyond same-origin: anyone who can reach
  `127.0.0.1` with a shell can already run `cw`.

---

## License

MIT
