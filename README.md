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
| [5. Core rules](#5-core-rules) | how depth is chosen, and what is enforced |
| [6. Working guide](#6-working-guide) | the ordinary path, capabilities, the gated path |
| [7. The gated path, phase by phase](#7-the-gated-path-phase-by-phase) | `deep-change`, every phase explained |
| [8. Capabilities reference](#8-capabilities-reference) | the ten skills, the contracts, the one agent |
| [9. How context flows](#9-how-context-flows) | why almost nothing is written to disk |
| [10. `.ai-workflow` explained](#10-ai-workflow-explained) | files, and what to commit |
| [11. Repository instructions](#11-repository-instructions) | `.claude/instructions/`, the scoped knowledge layer |
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
| [23. The app](#23-the-app) | many projects, GUI install, launching tasks |

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
.claude/skills/          10 specialist capabilities, loaded only when needed
.claude/prompts/         11 output contracts, read only when you ask for a document
.claude/instructions/    the contract for scoped repository knowledge (content: /map-repo)
.claude/agents/          adversarial-reviewer
.claude/hooks/cw-hook.mjs
.claude/settings.json    kit hooks merged into your existing settings
.claude/cw-runtime       records the runtime directory name
.ai-workflow/            runtime: config.json, runs/
CLAUDE.md                your file + one managed <!-- CW:START --> block
```

Nothing unmanaged is overwritten: `CLAUDE.md` gets a marked block, settings hooks
are merged, and any file the installer had to modify is saved as `*.cw-backup`.

> **Important — `cw` must be resolvable.** The gated path runs bare `cw …`
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

### Step 4 — Record repository knowledge (optional, when it earns its place)

Inside Claude Code:

```
/map-repo database
```

This reads representative code and writes
`.claude/instructions/database.instructions.md` with the paths, conventions and
gotchas of that area, plus a freshness record `cw instructions status` can
verify.

Do this for an area whose answer is repeated, invisible from a single file, and
costly to get wrong. It is not a prerequisite for anything: a task that can
learn the pattern from the neighboring file should do that instead.

### Step 5 — Run your first task

Just ask, in Claude Code. There is no entry command:

```
Cho phép chỉnh sửa Liên lạc tạo độc lập.
Liên lạc gắn dòng báo cáo giữ nguyên.
```

This bounded multi-layer change runs natively — inspect, change, targeted
verification, report:

```
Prompt
  ↓
Inspect                    the entry point, the rule, the nearest test
  ↓                         (a shared consumer here loads impact-analysis)
Change
  ↓
Targeted verification      the nearest test; integration only at a real boundary
  ↓
Changed / Why / Verified / Not verified / Risk
```

Nothing is classified, nothing is written to disk, and no phase is announced.
Watch the runtime activity in the monitor. You can stop reading here and use the
product.

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
│            │   Decision           ◐  ← current│ skill   deep-change       │
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

Use a deliberately irreversible request with a genuine open decision
(authorization + existing production data), so the gate has to stop and ask.

**1. Start the monitor** and open http://127.0.0.1:4173.

**2. In Claude Code, send:**

```
/deep-change
Thay đổi authorization chỉnh sửa Liên lạc cho MNG/owner và áp dụng cho dữ liệu
legacy. Chưa quyết định MNG được sửa loại Liên lạc nào.
```

**3. What you should see, in order:**

| Monitor shows | Meaning |
| --- | --- |
| A new run appears, `RUNNING`, chip `current` | `cw run start deep-change` |
| `Investigate` turns `●` | The blast radius is being established; no file may change |
| `Decision` turns `●`, gate chip `DECISION_READY` | The gate phase is running |
| `Waiting For User` turns `◐`, header pill `WAITING USER`, gate `DECISION_READY = WAITING` | A real product choice remains and the run parked |
| Claude runtime goes `IDLE` | It is waiting on you, not working |

At this point Claude asks you one question in one screen — what it found, what
must be decided, what it recommends, the alternatives, and what is at risk
either way. Meanwhile any attempt to edit code is denied by the hook.

**4. Answer it in the same session:**

```
Chỉ cho sửa Liên lạc không gắn dòng báo cáo.
Cho sửa nội dung và Tag.
```

**5. What you should see next:**

| Monitor shows | Meaning |
| --- | --- |
| `Waiting For User` → `✓`, back on `Decision` | The same run resumed — no new run appears |
| `decision.md` listed on the node | The recorded decision, including your answer |
| Gate chip flips to `DECISION_READY = PASSED` | `cw gate pass DECISION_READY` |
| `Implement` turns `●` | Only now can files change |
| `Verify` → `Adversarial Review` | Evidence, then a review that reads the diff (`review.md`) |
| `Done`, run `COMPLETED` | Verified completion |

> **Tip.** The run list is the fastest correctness check for the whole kit: one
> task must produce **one** run. If answering a question creates a second run,
> something re-entered the workflow instead of resuming it.

> **Note.** This is the exceptional path. An ordinary task opens no gate, asks
> nothing, and shows up in the monitor as a `generic` run with live tool
> activity — which is exactly the point of the redesign.

---

## 4. Core concepts

**Capability (skill)** — an instruction file holding a method the model would
otherwise be missing (`.claude/skills/<name>/SKILL.md`). It loads when the task
turns out to need it, and can also be typed as a slash command. It is never a
workflow phase, and never a task category.

**Scoped instructions** — how *this* repository does one area, in
`.claude/instructions/<area>.instructions.md`, with `appliesTo` globs and the
evidence files it was derived from. Only the file covering the area being
touched is read. Written by `/map-repo`. See [§11](#11-repository-instructions).

**Output contract (prompt)** — how to present a document, in
`.claude/prompts/<name>.prompt.md`. Read only when the user asked for one, which
is why reporting structure costs nothing on an ordinary task.

**Agent** — a sub-worker with its own tools and an independent source of truth.
One ships: `adversarial-reviewer`, used inside `deep-change`. A subagent that
re-reads the code the main agent just read is latency, not review.

**Workflow** — an ordered process, defined as data (YAML): nodes, edges, gates,
and the artifacts each phase must produce. The preset uses `deep-change` and
`generic`; `solution-analysis`, `feature-change`, `bug-fix`, `standard-change`
and `quick-fix` remain shipped for projects that opt into them.

**Gate** — a named condition that must be `PASSED` before a workflow may
continue. `DECISION_READY` is the preset's only gate; `BUSINESS_READY` and
`ROOT_CAUSE_READY` belong to the legacy topologies. While any gate is open, the
`PreToolUse` hook denies repository changes.

**Artifact** — a file a phase must persist into the run directory. `deep-change`
declares two: `decision.md` and `review.md`. Ordinary work declares none,
because nothing later reads them.

**Run** — one instance of one workflow for one task, stored in
`.ai-workflow/runs/<run-id>/`. Run ids look like `dc-20260831-001` (workflow
initials, date, per-day counter). A prompt that belongs to no workflow gets a
`generic` run so the monitor still shows live activity.

**Semantic state** — which workflow phase the run is in, and what its gates say.
Written only through `cw`.

**Runtime state** — what Claude is doing right now (`ACTIVE`, `TOOL_RUNNING`,
`SUBAGENT_RUNNING`, `IDLE`, …). Written only by Claude Code hooks, automatically.

**Mission** — the classification layer over a run (task type, complexity, risk,
plan, confidence, checkpoints), written through `cw mission …`. It is runtime
functionality the preset no longer drives on every task; see
[§22](#22-mission-control).

**Mission Board** — the organised view of a run's state (`cw board`, or the
right panel in the monitor), including the buttons that approve, reject, pause,
resume or cancel.

---

## 5. Core rules

### Depth follows evidence, not the task's name

There is no classification step. Every task starts the same way — inspect,
change, verify what the change touched — and depth is added only when reading
the code justifies it. Three facts decide, and none of them is the word the
request used:

| Dimension | Low | High |
| --- | --- | --- |
| Change surface | one file or one call path | several modules, layers, or consumers |
| Uncertainty | expected behavior and location are clear | cause or required behavior genuinely unclear |
| Blast radius | local and reversible | data, contracts, auth, money, migrations, production |

All three low: change it. One high: investigate that dimension only. Blast
radius high *and* hard to reverse: `deep-change`.

Wide is not the same as risky. A rename across forty files is wide and
reversible, so it stays an ordinary task.

### Capabilities load on evidence

While inspecting, when one of the escalation triggers in `CLAUDE.md` turns out
to be true — an invisible cause, a shared consumer, a schema change, a contract
change, an unmeasured slowdown — the matching skill loads and the work
continues. Loading one is not a mode switch and does not restart the task. For
most tasks nothing fires, which is the expected outcome.

### Stop rules

Investigation stops when the target is identified, the expected behavior is
decided, the impact actually found is understood, and the check that will prove
the change is known. "More confidence" is not a reason to keep reading.

### Artifacts are the exception

Default: none. The code, the tests, and the final response are the deliverable.
A persistent file is written when it has value after the task — an architecture
decision, a migration plan, a formal audit, a handover — or because the user
asked for a document. `deep-change` writes exactly one decision file.

### One gate: NO DECISION = NO CODING, for irreversible work

`deep-change` opens a run whose single gate, `DECISION_READY`, is enforced by
the `PreToolUse` hook. While it is open the hook returns `deny` for:

- every file-writing tool — `Edit`, `Write`, `MultiEdit`, `NotebookEdit`,
  `apply_patch`, `str_replace_editor`, `create_file`, plus MCP tools whose names
  match `^mcp__.*(write|edit|create|patch|…)`;
- command tools (`Bash`, `PowerShell`, `Shell`, `Terminal`, `run_command`, …)
  **unless** every program in the command line is on the read-only allowlist
  (`git status/diff/log/show`, `grep`, `rg`, `ls`, `cat`, `jq`, `cw`, …) or is a
  test/build entry point (`npm`, `pytest`, `cargo`, `make`, …). Redirection,
  command substitution, and write-capable flags (`find -delete`, `fd -x`,
  `sort -o`) are refused.

The denial message Claude receives:

```
Blocked by claude-workflow-kit: run dc-20260831-001 (deep-change) has unpassed
gate(s): DECISION_READY (decided at "decide"). Nothing in the repository may
change until DECISION_READY pass. Complete the gate phase, persist its evidence
artifact, then run: cw gate pass DECISION_READY. If the decision is not yours to
make, run: cw gate wait DECISION_READY --message "<open decision>" and ask the
user. This write was refused because src/orders.js is repository content.
```

What stays writable behind a gate: exactly `<runDir>/<name>` where `<name>` is an
artifact the **current** phase declares. The phase that produces a gate's
evidence cannot be blocked by that gate. `state.json` and `events.jsonl` are
never writable by a tool.

The legacy topologies (`feature-change`, `bug-fix`) still define
`BUSINESS_READY` and `ROOT_CAUSE_READY` and are enforced identically for
projects that start those runs; the preset no longer routes to them.

> **Limitation — this is a workflow guardrail, not a security sandbox.**
> Enforcement covers the tool surface listed in `config.json`. Test and build
> commands are deliberately allowed behind a gate (a package script or Makefile
> target *can* write files — set `allowTestCommandsBehindGate: false` for a
> strict gate). A command tool that is not in `commandTools`, or an MCP writer
> whose name does not match the pattern, is not covered until you add it. See
> [§15](#15-gate-enforcement-and-limitations).

### Ask only for a real decision

A question reaches the user when at least two materially different behaviors are
plausible, evidence cannot select between them, and the choice changes business
data, permissions, money, state, or a public contract. Otherwise the assumption
is stated in one line and the work continues. Alternatives are never invented to
justify a checkpoint, and silence is never approval.

### Evidence, not authority

Requirement documents, database schema, existing code and existing tests are all
**evidence**. None is truth on its own. When they conflict, the contradiction is
surfaced and the intended behavior is resolved explicitly — never by silently
preferring documents over code or code over documents.

### Verification is proportional

Cheapest sufficient evidence, in order: nearest unit test → affected service or
API test → typecheck/lint/build of the affected package → integration test for a
real boundary → E2E only when it closes a risk nothing cheaper can. The full
suite is not run to make a report look complete, and claims stay distinct:
implemented is not verified, build passed is not functionally tested.

### Scope discipline

Only what was asked is implemented. Unrelated technical debt is one line in the
report, never a change in the diff.

---

## 6. Working guide

### The ordinary path

Most work needs nothing typed and nothing loaded:

```text
inspect -> understand -> change -> targeted verification -> report
```

The final response is `Changed / Why / Verified / Not verified / Risk`. No run is
opened by hand; the hook records a `generic` run for the monitor on its own.

### When a capability loads

| What you hit | What loads | What it buys |
| --- | --- | --- |
| a defect whose cause is not in the code you read | `root-cause-analysis` | a causal chain instead of a symptom patch |
| a shared function, a contract, more than two consumers | `impact-analysis` | the consumers you would otherwise meet in production |
| a feature across layers, or new business state | `feature-analysis` | flow, transactions, idempotency, AC-to-verification |
| two queries must agree | `sql-compare` | NULL, join, grouping and pagination semantics, proven |
| new code must match legacy behavior | `legacy-parity` | a corpus and a tolerance, agreed before comparing |
| DDL, backfill, data reshaping | `schema-migration` | expand/contract, locking, an honest rollback |
| a published shape or status code changes | `api-contract-review` | the breaking-change taxonomy and a compatible way to ship |
| something is slow, nothing is measured | `performance-investigation` | a baseline, the dominant cost, a proven improvement |

Any of these can also be typed as a slash command when you already know which
one the task needs.

### When the gated path is right

`/deep-change` is for a change that cannot be undone by reverting code:
production data, a destructive migration, authentication or authorization,
money, or a contract with consumers outside the repository.

```text
investigate -> decide (gate + decision.md) -> implement -> verify -> review -> done
```

It holds every edit until the decision is recorded, asks the user only when a
genuine product or risk choice remains, and ends with an adversarial review that
reads the diff rather than the implementer's summary.

### Reports

Ask for one and the matching contract in `.claude/prompts/` is read and
followed — change, bug, impact, test, review, analysis, parity, migration plan,
business summary, decision record, or release note. Ask for nothing and no
contract is loaded at all. Audience beats document type: a bug fix explained to
a PO uses `business-summary.prompt.md`; a mixed audience gets a business summary
followed by technical detail.

Requests in Vietnamese (`báo cáo`, `tổng hợp`) are report requests, and the
report is written in the reader's language.

### Repository knowledge

`/map-repo <area>` writes `.claude/instructions/<area>.instructions.md` from
repeated evidence in the codebase, with `appliesTo` globs and the list of files
it was derived from. Later tasks read only the file covering what they touch.
See [§11](#11-repository-instructions).

### Runtime topologies

The `cw` runtime still defines `quick-fix`, `standard-change`, `feature-change`,
`bug-fix` and `solution-analysis`. They are available to projects that want a
recorded multi-phase run — `cw run start <id>` — and they are what
`cw mission route` still classifies into. The `senior-dev` preset routes to none
of them: it uses `deep-change` for irreversible work and native execution for
everything else.

---

## 7. The gated path, phase by phase

### `deep-change` (8 nodes, one gate)

```
        prompt  (start)
           │
           ▼
      investigate
           │
           ▼
 ┌───── decide  ── decision.md            gate DECISION_READY
 │  !DECISION_READY │  DECISION_READY
 ▼                  │
await-decision ─────┘  (answered)
   (waiting)         │
                     ▼
                 implement
                     │
                     ▼
                  verify ──────┐ failure
                     │   ◄─────┘
                     ▼
                  review  ── review.md ──┐ findings
                     │            ◄──────┘
                     ▼
                   done  (end)
```

#### Investigate

- **Purpose** — establish only what the decision needs: what cannot be undone
  and what recovery costs, who depends on the current behavior, which part is a
  product choice, the deploy order, how it will be verified.
- **Uses** — whichever capability fits: `root-cause-analysis`,
  `impact-analysis`, `schema-migration`, `api-contract-review`, `legacy-parity`.
- **Writes nothing.** Every edit is denied here — that is the gate working.

#### Decide (`DECISION_READY`)

- **Produces** — `decision.md`: what is changing and why, what is irreversible
  and what recovery costs, impact, options actually considered, the chosen
  approach, the deploy order, the verification plan, and the open question if
  one remains.
- **Passes the gate** when evidence settles the decision. Manufacturing a
  question to open a checkpoint is explicitly forbidden.
- **Waits** (`cw gate wait DECISION_READY`) when a real product or risk choice
  needs the user, who is asked in one screen and notified with
  `PushNotification`.

#### Implement

- **Purpose** — the smallest change that carries out the recorded decision,
  inside the approved scope. A finding that widens scope returns to `decide`.
- For a migration, the destructive step is usually a later release; the
  implementation stops at the boundary the decision named.

#### Verify

- **Purpose** — evidence biased toward the failure mode this change creates: the
  migration verification queries, the old-shape contract test, the permission
  negative case, the parity corpus.
- Records what ran, what passed, and what is still unverified.

#### Review

- **Agent** — `adversarial-reviewer`, given pointers only (`cw review-context`
  output plus the diff command), never a summary of the work. Produces
  `review.md` with `PASS`/`FAIL`, a readiness verdict, and P0–P3 findings.
  Maximum three fix loops.

#### Waiting node (`await-decision`)

Not work — a place the run *parks* while the gate is `WAITING`. A gate can only
be parked from the phase that owns it, and can only be decided from that phase or
from the waiting node the run legitimately reached. Passing the gate settles the
waiting node and returns focus to the owning phase, so the run continues instead
of restarting.

### Legacy topologies

`feature-change` (14 nodes, `BUSINESS_READY`) and `bug-fix` (adding
`ROOT_CAUSE_READY`) are still shipped and still enforced. They exist for
projects that deliberately want that shape; run `cw workflows` to see every
definition and `cw run show --json` for the exact node list of a live run.

---

## 8. Capabilities reference

Ten skills ship in the `senior-dev` preset. They are capabilities, not workflow
phases: each exists because it supplies a method the model would otherwise be
missing, and each loads only when a task needs it. None is model-blocked, so the
escalation table in `CLAUDE.md` can reach every one of them, and each can also be
typed as a slash command.

| Skill | What it adds that native reasoning lacks |
| --- | --- |
| `root-cause-analysis` | value bisection back from the observation, time/data/environment bisection, symptom vs contributing factor vs cause, finding tests that encode the bug |
| `impact-analysis` | consumer discovery for same-signature semantic changes, serialized payloads and jobs as consumers, and mapping each indirect impact to the check that would catch it |
| `feature-analysis` | flow tracing with real paths, data model and state transitions, transaction boundaries, idempotency, and an acceptance-criteria-to-verification map |
| `sql-compare` | normalization, join and NULL semantics, aggregation fan-out, pagination stability, parameter binding, dialect differences, and proof by `EXCEPT ALL` in both directions |
| `legacy-parity` | reference and tolerance agreed up front, characterization tests, dual-run corpora, and triage of every difference against the legacy's accidents |
| `schema-migration` | expand/migrate/switch/contract, the two-version deploy invariant, locking behavior, resumable backfills, and an honest rollback path |
| `api-contract-review` | the breaking-change taxonomy including silent semantic breaks, consumer enumeration, and compatible shipping strategies |
| `performance-investigation` | measure first, locate the dominant cost, change one thing, prove it with a before/after under the same workload |
| `map-repo` | derive `.claude/instructions/<area>.instructions.md` from repeated evidence, with a freshness record `cw instructions status` can verify |
| `deep-change` | the one gated path for a change that cannot be reverted |

### Output contracts

Report structure is not part of a reasoning skill. Eleven contracts live in
`.claude/prompts/` and are read only when the user asked for a document:
`change-report`, `bug-report`, `impact-report`, `test-report`, `review-report`,
`analysis-report`, `parity-report`, `migration-plan`, `business-summary`,
`decision-record`, `release-note`. `.claude/prompts/README.md` is the index that
selects one; audience beats document type, so a bug fix explained to a PO uses
`business-summary.prompt.md`.

### The gated path in detail

`deep-change` is the only skill that drives the runtime. It opens a
`deep-change` run whose single gate, `DECISION_READY`, is enforced by the
PreToolUse hook:

```text
investigate -> decide (gate + decision.md) -> implement -> verify -> review -> done
```

While the gate is open every edit and every non-read-only command is denied; the
run directory stays writable so `decision.md` — the evidence the gate depends on
— can be written. The gate is passed when evidence settles the decision, or
waited on when a genuine product or risk choice needs the user. `review` hands
the `adversarial-reviewer` agent pointers only (`cw review-context` output plus
the diff command), never the implementer's summary of their own work.

### The agent

One agent ships: `adversarial-reviewer`. It exists because it has an independent
source of truth — it reads the diff and the recorded decision itself — and an
adversarial mission: find what would have to be true for the change to be wrong.
A subagent that re-reads the same code the main agent just read and agrees with
it adds latency, not review, so no such agent is shipped.

## 9. How context flows

On the ordinary path, context flows the way it does in any good session: the
code you read, the change you make, the check you run, and the response. Nothing
is written to disk, because nothing needs to outlive the task.

The gated path is the exception, and it persists exactly two files:

```
User Request
     │
     ▼
Investigate         (capabilities load here; nothing is written)
     │
     ▼
Decision                              decision.md   ← the canonical spec
     │
     ▼
Implementation                        the diff
     │
     ▼
Verification                          recorded in the response
     │
     ▼
Adversarial Review                    review.md
```

Three rules make this work:

**1. A file exists because something later needs it.** `decision.md` is read by
the implementation and by the reviewer; `review.md` is read by the next loop and
by the user. Nothing else is written, because nothing else has a reader. Where a
phase does declare an artifact, the runtime enforces it: `cw phase complete` and
the next `cw phase enter` are both refused while it is missing or empty, and so
is any transition made after an earlier phase's evidence has disappeared.

**2. `decision.md` is the resolved source.** The implementation follows it — not
the original request, not the requirement documents. If it turns out to be
wrong, the run returns to `decide`; it is not quietly reinterpreted while coding.

**3. The reviewer never reads the implementer's account.** It is handed
`cw review-context` output and a diff command, and reads the primary sources
itself. A review of someone's summary of their own work is not a review.

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
opened by the prompt hook is promoted in place when a workflow is selected.
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
├── workflows/            optional: project workflow definitions that override built-ins by id
└── runs/
    └── dc-20260831-001/
        ├── state.json            machine-owned run state — never hand-edit
        ├── events.jsonl           append-only semantic + runtime event log
        ├── decision.md
        └── review.md
```

Shared repository knowledge does **not** live here. It lives beside the skills
that read it, because it is committed documentation rather than machine-local
run state:

```
.claude/
├── instructions/   <area>.instructions.md + metadata.json   — written by /map-repo
├── prompts/        output contracts, read only on request
├── skills/         the ten capabilities
├── agents/         adversarial-reviewer.md
└── hooks/          cw-hook.mjs
```

An ordinary task writes nothing under `runs/` at all; only `deep-change` does.
A legacy `feature-change` or `bug-fix` run still writes its own artifact set.

| Path | What it is | Commit? |
| --- | --- | --- |
| `.claude/instructions/` | Shared repository knowledge, read when relevant | **Commit it** |
| `.claude/prompts/` | Output contracts; project edits are preserved on update | **Commit it** |
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

## 11. Repository instructions

**Why persist them.** Re-deriving how a repository organises an area on every
task is slow and inconsistent. Writing it down once makes it cheap to reuse and
makes divergence visible — and scoping it per area means a frontend task never
pays for the database knowledge.

Files under `.claude/instructions/`:

| File | Content |
| --- | --- |
| `README.md` | the contract: frontmatter, sections, what belongs and what does not |
| `<area>.instructions.md` | how this repository does one area, with real paths |
| `metadata.json` | per area: `status`, `last_refresh`, `evidence` files, plus `repo_shape` |

Areas are open. A repository has the areas it has — `architecture`, `database`,
`api`, `testing`, `frontend`, `logging`, `security`, `legacy`, or `billing` and
`reporting` if that is what the system is made of. Nothing is shipped
pre-written: knowledge that was not derived from this repository would be a
stale instruction on day one.

Each file declares what it governs and what it was derived from:

```markdown
---
area: database
appliesTo: ["src/repositories/**", "migrations/**"]
updated: 2026-08-31
evidence: ["src/repositories/OrderRepository.ts", "migrations/2026_03_add_status.sql"]
---
```

**Write or refresh one** (inside Claude Code):

```
/map-repo                    # the areas this repository actually has
/map-repo database api       # selected areas
```

**Inspect** (from a shell):

```bash
cw instructions status
```

Freshness is **computed**, not claimed: the CLI re-checks that every recorded
evidence file still exists and has not been modified since `last_refresh`.
`STALE` is a review signal — re-read the changed file and correct the affected
rule. It is not a reason to rediscover the whole repository.

| Status | Meaning | What to do |
| --- | --- | --- |
| `OK` | Present, and every evidence file still exists and is unchanged | Read it when touching the area |
| `MISSING` | Recorded in `metadata.json` but the file is gone | Rewrite it, or drop the metadata entry |
| `UNRECORDED` | File exists, but `metadata.json` records no `last_refresh` — freshness cannot be verified | Re-run `/map-repo <area>` so it becomes checkable |
| `STALE` | Evidence files are gone or were modified after the last refresh | Check whether the change is material; correct the affected rule |
| `INVALID` | `metadata.json` is unusable for the area (bad status value, non-ISO timestamp, absolute or escaping evidence path, `OK` with no evidence) | Fix it before relying on the area |

Real output on a fresh install:

```
instructions  /path/to/project/.claude/instructions
no areas mapped yet — run /map-repo <area> when knowledge is worth persisting

every mapped area is verified — read the one that covers what you are touching
precedence: local intentional convention near the touched code > these files > generic default
```

An unmapped repository reports **no areas**, not a list of failures. A project
that never needs a persisted instruction file is a healthy project, not an
un-bootstrapped one.

**Precedence, highest first:**

1. a local intentional convention in the code being touched;
2. this repository's instruction file for the area;
3. a generic default or external style skill.

An external generic skill never overrides a convention this repository
demonstrably follows.

> **Limitation.** The *content* is written by the model. Only its freshness and
> metadata shape are verified by code.
>
> `cw conventions status` remains as an alias of `cw instructions status`, so a
> project installed before 0.2 still gets an answer rather than an error.

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
| `no active run` | No run is open in this project | Normal — ordinary work opens none. `/deep-change` opens a gated run |
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

**Anything ordinary** — the common case, and the cheap one

```
<the change, and what it should do>
```

No command, no classification, no run to open. Inspect, change, verify what the
change touched, report. If reading the code turns up a shared consumer, an
invisible cause, or a schema change, the matching capability loads by itself and
the work continues.

**When you already know which method the task needs**

```
/sql-compare          the two queries must return the same rows
/root-cause-analysis  the fix keeps not holding
/impact-analysis      this helper has consumers I cannot enumerate
/schema-migration     this touches DDL and existing rows
/legacy-parity        the rewrite must behave exactly like the old one
```

Typing one is a shortcut, not a mode: it loads a method, not a process.

**When the change cannot be undone**

```
/deep-change
<the change, and why it is irreversible>
```

Production data, a destructive migration, auth, money, or a contract with
consumers outside the repository. It holds every edit until the decision is
recorded, and asks you only if a real choice remains.

**When you want a document**

```
Viết báo cáo cho BA về thay đổi này.
```

The matching contract in `.claude/prompts/` is read and followed. Ask for
nothing and none is loaded.

**Record repository knowledge that keeps getting rediscovered**

```
/map-repo api
```

**Check state after a break**

```bash
cw status         # the active run, its phase, its gates
cw board          # classification, monitors, the open checkpoint, blockers
```

**Answer the question it is blocked on**

Answer in chat, or click Approve / Modify / Reject / More evidence on the Mission
Board in the monitor. A pending checkpoint denies repository writes until you do
— that is the point ([§22.14](#2214-answering-a-checkpoint)).

> **Tip — depth is not something you request, it is something the code
> justifies.** "Make this button visible for MNG; the API already allows it" is
> two files and a targeted test. The same sentence about a permission the API
> does *not* yet allow is a different task, and the difference is found by
> reading the code, not by choosing a command.

---

## 18. Real example

**Request** — no command, because most work needs none:

```
Cho phép chỉnh sửa Liên lạc không gắn dòng báo cáo, đồng thời migrate dữ liệu
legacy và giữ tương thích cho API client cũ.
```

**Inspect.** Where a Liên lạc is created and updated; whether "gắn dòng báo cáo"
is a nullable link, a status, or a separate table; which screens list and edit
it; which permissions guard editing; whether existing tests assert that editing
is blocked. Two findings change the shape of the task:

- the code already allows updating the Tag field, while the requirement document
  says a Liên lạc is immutable after creation;
- a test asserts "no edit after report link", but only for the linked case.

**Escalation, from evidence not from the wording.** Reading turns up three
triggers at once: legacy rows must be migrated (`schema-migration`), an existing
API client must keep working (`api-contract-review`), and the change is to a
permission rule over production data that cannot simply be reverted
(`deep-change`). Without the migration and compatibility requirements, the same
sentence would have been an ordinary multi-file change with a targeted test.

**The open decision.** "Chỉnh sửa" is not yet a decision: which fields, and what
happens to an unlinked record that later gets linked? This is a genuine product
choice over production data, so `deep-change` parks on `DECISION_READY` and asks
once — what was found, what must be decided, the recommendation, the
alternatives, what is at risk. No code changes while it waits; the hook denies
every edit.

**Your answer**

```
Chỉ cho sửa Liên lạc không gắn dòng báo cáo.
Cho sửa nội dung và Tag.
```

**`decision.md`** — editing is permitted only while the Liên lạc has no
report-line link; editable fields are content and Tag; attempting to edit a
linked record is rejected with the existing permission error; once linked, the
record becomes immutable again. What is irreversible: the legacy backfill, whose
recovery path is a restore. Deploy order: add the nullable state column and
dual-write, backfill in batches, switch reads, and drop the old flag in a later
release. Verification: the backfill count query must reach zero, the old API
shape must still deserialize, and the linked-edit rejection must be tested from
both the API and the UI path. The document's blanket immutability rule is
recorded as outdated for the unlinked case.

**Implement.** The smallest change that carries out that decision, stopping at
the release boundary the decision named — the destructive drop is not in this
diff. No refactoring of neighbouring code, no "while I'm here" improvements.

**Verify.** Evidence aimed at what this change can break: the migration
verification queries against a production-shaped snapshot, an old-shape request
test, the linked-edit negative case, and the concurrency window between load and
save. Anything not covered — the bulk-edit path has no fixture — is reported as
not verified rather than implied.

**Adversarial review** (`review.md`) — a separate agent reads `decision.md` and
the diff itself, never the implementer's account, and asks what would have to be
true for this to be wrong: is the recovery path still available given what the
diff does, does the deploy order in the code match the approved one, does any
consumer outside the diff read the changed shape. `PASS` or `FAIL` with P0–P3
findings; correctness findings go back to implementation, maximum three loops.

**Outcome** — Changed / Why / Verified / Not verified / Risk, plus the decision,
who made it, and the recovery path if it turns out to be wrong. Legacy rows with
inconsistent link state still exist and are named as remaining risk. Follow-ups
are one line in the report, not extra changes in the diff.

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
    skill: deep-change
    artifact: findings.md
    description: Read-only investigation.

  - id: decide
    label: Decision
    skill: deep-change
    gate: SPIKE_DECIDED
    artifacts:
      - decision.md
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

A skill is `.claude/skills/<name>/SKILL.md` with YAML frontmatter. Before
writing one, answer the question that decides whether it should exist:

> **If I delete this skill, what capability is lost?**

"The model is no longer forced through a step" is not a capability. A skill
earns its place when it supplies domain rules, a matching or comparison method,
a specialized verification technique, or a procedure that is genuinely
non-trivial — something a competent engineer would have to be taught.

```markdown
---
name: cache-invalidation
description: One sentence on the problem it solves and the evidence that should
  trigger it — this is what makes it load at the right moment.
effort: medium
---

The method, in imperative form: what to establish, in what order, what to check
explicitly, when to stop, and how to report the result.
```

Leave the frontmatter free of `disable-model-invocation` and
`user-invocable: false` so the skill can both load on evidence and be typed as a
slash command. Add `argument-hint: "[what to pass]"` when it takes an argument.

Keep report structure out of it. If the skill produces a document, put the
structure in `.claude/prompts/<name>.prompt.md` and let the skill stay about
method.

Skills you create by hand in `.claude/skills/` are yours: the installer only
manages the files listed in `.ai-workflow/installed.json`, and `uninstall`
removes only those. To ship a skill **with** the kit, add its directory under
`packages/claude-adapter/presets/senior-dev/skills/` and list its name in
`preset.json` — and add an escalation trigger for it in the preset's
`claude-md.md`, or nothing will ever load it.

### A new scoped instruction area

Areas are open: `/map-repo <area>` writes
`.claude/instructions/<area>.instructions.md` for whatever this system is made
of. Nothing needs to be registered — `cw instructions status` discovers areas
from the files and metadata that exist.

### A new output contract

Add `.claude/prompts/<name>.prompt.md` with the document's section order and its
truth-telling rules, then add a row to `.claude/prompts/README.md` so it can be
selected. To ship one with the kit, put it under the preset's `prompts/`
directory and list it in `preset.json`.

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
4. Update the skill that drives the workflow (`deep-change` for the shipped
   gated path) so the phase is actually entered — the skill is the script that
   emits transitions.

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

> **Since 0.2, this is opt-in runtime functionality, not the default path.** The
> `senior-dev` preset no longer classifies every task: ordinary work runs
> natively, and depth comes from what reading the code turns up (see
> [§5](#5-core-rules)). The router, the confidence floors, the checkpoint
> machinery and the board all still work exactly as documented below, and are
> what you get when you drive a multi-phase topology deliberately —
> `cw run start standard-change`, `cw mission classify …` — or build a preset of
> your own on top of them. The examples below therefore start a run explicitly
> instead of typing an entry command.

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
| `cw mission template [--type <taskType>]` | Output contract for the task type |
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
| 1 | you | describe the task (this table assumes a project that opted into classification) |
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
Đổi label "Submit" thành "Gửi yêu cầu" ở màn hình Contact Request.
```

Under the shipped preset this is simply done: locate the string, change it,
build. What follows is what the *runtime* records when a project drives the
`quick-fix` topology deliberately, in order:

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
template    change-report.prompt.md
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
So sánh 2 cách làm audit log: bảng riêng vs event stream. Chưa cần code.
```

Under the shipped preset this loads `feature-analysis` and answers in the
conversation, writing a document only if one was asked for
(`analysis-report.prompt.md`). Driven as a recorded run instead:

```bash
cw run start solution-analysis --label "audit log approach"
cw mission classify --type research --complexity medium --flags analysis-only
# -> RESEARCH (solution-analysis); validation: none — nothing is built
```

The run produces the seven analysis artifacts, records confidence per dimension,
and stops at `ANALYSIS_READY`. Nothing in the repository changes. Implementation
starts only after `cw analysis approve` + `cw analysis handoff`, which creates a
trace-linked `feature-change` run — see [§6](#6-working-guide).

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

- the `deep-change` workflow and its skill — one gate instead of five;
- ten specialist capabilities in place of the workflow-phase skills;
- eleven output contracts in `.claude/prompts/` (project edits always win);
- `.claude/instructions/` and `/map-repo`, replacing `.ai-workflow/conventions/`;
- a `CLAUDE.md` managed block roughly a third of its former size;
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

## 23. The app

`cw monitor` watches one repository. `cw app` is the same thing grown up: one
process, every project you work in, and the two jobs that used to need a
terminal — installing the kit, and starting a session.

```bash
npx claude-workflow-kit app --open          # http://127.0.0.1:4600
npx claude-workflow-kit app --add .         # register this repo on the way in
```

Nothing about the workflow changes. The app reads the same `.ai-workflow`
directories, runs the same skills, and enforces the same gates; it does not have
a private copy of anything.

### 23.1 What it adds

| | |
| --- | --- |
| **Projects** | register any directory; the switcher carries each project's waiting-checkpoint count |
| **Install / Doctor** | run `init`, `update` and `doctor` from the Projects screen instead of the CLI |
| **Settings** | edit the safe half of `config.json` in a form (see [§23.4](#234-what-settings-will-not-let-you-change)) |
| **Launch** | start a Claude Code session in a project and watch its output |
| **Across every project** | run totals, active work and success rate rolled up over the workspace |

Everything the single-project monitor already did — the phase diagram, the live
rail, the Mission Board, run history — is unchanged, just scoped to the project
in the URL.

### 23.2 Where the project list lives

`~/.claude-workflow-kit/workspace.json` (override with `CW_HOME`). It holds a
name, a path and a runtime directory per project — nothing else, and nothing
from inside your repositories.

A project's id is derived from its path, so adding the same directory twice
updates the entry rather than creating a second one. **Removing a project only
unregisters it**: the skills, hooks, `CLAUDE.md` block and `.ai-workflow`
directory stay exactly where they are. Use `claude-workflow-kit uninstall` if you
actually want them gone.

### 23.3 Launching a task

The app spawns `claude` in the project directory with your prompt on **stdin**,
and captures its `stream-json` output to `.ai-workflow/app/tasks/`. The session
is an ordinary one: it runs your installed skills, its hooks feed the same run
state, and the run shows up in the monitor like any other.

Modes, in order of how much they can do:

| Mode | The session can | Confirmation |
| --- | --- | --- |
| **Plan** (default) | read and propose | none needed |
| **Ask** | nothing unattended — it stops at the first prompt, because no one is at the terminal to answer | none needed |
| **Edit files** (`acceptEdits`) | write files without asking | explicit |
| **Full access** (`bypassPermissions`) | write files *and* run commands without asking | explicit |

The two edit-capable modes are refused by the server unless the request carries
`confirmUnsafe`, and the UI makes you tick a box naming the repository first.
Use them only where you can restore the working tree.

If the app says **no claude**, Claude Code is not runnable from the app's
environment. Install it, or point `CW_CLAUDE_BIN` at the binary, and restart.

A session the app started is stopped with **Stop**. A session left running when
the app restarted is reported as `UNKNOWN` rather than adopted — the app cannot
honestly claim to be watching a process it did not spawn.

### 23.4 What Settings will not let you change

Editable: `monitorPort`, `stallThresholdSeconds`, `semanticLagThresholdSeconds`,
`autoGenericRun`, `enforceGates`, `analysisReportDir`.

Read-only from the app: `mutationTools`, `mutationToolPatterns`, `commandTools`,
`readOnlyCommands`, `runtimeUrl`, `stateSchemaVersion`. These decide what the
PreToolUse policy treats as a write, and a form that can empty one of those lists
is a form that can switch off gate enforcement by accident. Edit the file, or
re-run the installer. (`enforceGates` stays editable because turning it off is a
deliberate act, and the monitor then says `policy disabled` out loud.)

### 23.5 Security

The app binds `127.0.0.1` and has no authentication — like the monitor, it
assumes anyone who can reach it could already run `cw` in a shell. Every write
(board actions, config, install, launching a task) is refused when it arrives
with a foreign `Origin` header, so a web page you have open in another tab cannot
approve a checkpoint or start a session on your behalf.

Serve it to anything other than localhost at your own risk: `--host` exists, and
there is nothing behind it.

### 23.6 `cw monitor` still works

The monitor serves the same UI and answers both dialects — its original
`/api/state`, `/api/runs/...` URLs, and the app's `/api/projects/local/...` ones.
It presents itself as a workspace of exactly one project with installing and
launching switched off, so the screens that need them are simply not offered.

### 23.7 What the app does not do

- It is not a Claude Code client. It starts a session and shows its output; it
  cannot answer a prompt the session asks mid-run. That is what the two
  confirmation-free modes are for, and why `Ask` mode stalls.
- It does not sync anything. The registry is one machine's list of directories.
- It does not run remotely. There is no auth, no multi-user state, and run state
  is still files on disk (D4).
- Registering a project does not install anything; installing is a separate,
  explicit step.

---

## License

MIT
