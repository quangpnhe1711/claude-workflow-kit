# claude-workflow-kit — extracted workflow, target architecture, decisions

Phase 1 deliverable. Written before implementation.

> **Current adaptive policy (2026-08-04).** The original extraction below
> documents where the kit came from. Runtime behavior now classifies L0-L3:
> `quick-fix` owns L0-L1, gate-free `standard-change` owns L2, and the original
> hard-gated bug/feature topologies are reserved for L3. Verification is
> risk-based, E2E is conditional even in L3, and reporting independently selects
> quick output or one of nine installed templates.
>
> **Mission Control (2026-08-05).** A mission layer now sits on top of the same
> five topologies: task-type/complexity/risk routing to Lightning, Fast, Standard,
> Deep or Research; derived mandatory checkpoints that deny repository writes while
> unanswered; evidence and confidence thresholds enforced at the implementation
> phase; risk, off-track, context and health monitors; and an interactive Mission
> Board in the monitor. Decisions D26-D31 record why each part is shaped the way it
> is. The L0-L3 vocabulary below still holds — it is the same ladder under the
> Lightning/Fast/Standard/Deep names.

## 1. Extracted current workflow (source: `D:\lvn-erp`)

### 1.1 What exists today

| Kind | Item | Role |
| --- | --- | --- |
| Entry skill | `work` | Classifies L0-L3 and routes exactly one body; report-only requests bypass engineering runs. |
| Entry skill | `solution-analysis` | Free-form analysis-only entry; stops before code and requires explicit approval. |
| Entry skill | `feature-change` | Risk-adaptive change entry; full 10-phase body only for L3. |
| Entry skill | `bug-fix` | Risk-adaptive defect entry; full 10-phase body only for L3. |
| Step skill | `wf-quick-fix` | Gate-free L0-L1 fast path. |
| Step skill | `wf-standard-change` | Gate-free L2 targeted-impact path. |
| Step skill | `wf-solution-analysis` | Business/source/impact/solution analysis with a six-file contract. |
| Step skill | `wf-feature-from-analysis` | Trace-linked freshness check and feature continuation without repeated analysis. |
| Entry skill | `refresh-conventions` | Bootstrap/refresh persisted conventions. |
| Step skill | `wf-evidence-reconciliation` | Reconcile intent / TKCB / TKCT / BR / DB / code / tests. |
| Step skill | `wf-bug-root-cause` | Reproduce, trace, causal root cause. |
| Step skill | `wf-business-decision` | Hard gate → `BUSINESS_READY` / `BUSINESS_BLOCKED`. |
| Step skill | `wf-change-readiness` | Plan + impact + risk + scope + test strategy. |
| Step skill | `wf-convention-manager` | Cache-first convention reuse. |
| Step skill | `wf-implement` | Smallest correct change, no scope creep. |
| Step skill | `wf-validation-e2e` | Risk-based validation with explicit E2E decision. |
| Step skill | `wf-product-assessment` | Post-implementation, evidence-backed only. |
| Step skill | `wf-final-report` | Quick/detailed report router with audience-aware templates. |
| Agent | `business-analyst` | Read-only reconciliation. |
| Agent | `root-cause-analyst` | Read-only causal tracing. |
| Agent | `independent-reviewer` | Read-only post-implementation review, PASS/FAIL. |
| Rules | `CLAUDE.md` | Execution mode, evidence policy, hard gates, scope/test/convention discipline, assessment, final response shape. |
| Runtime | `.ai-workflow/conventions/` | `code.md`, `comments.md`, `testing.md`, `database.md`, `metadata.json`. |
| Runtime | `.ai-workflow/runs/` | Per-task evidence artifacts (declared, not yet structured). |

### 1.2 Behavioral invariants that must survive extraction

1. Classify L0-L3 before execution; full workflow is L3-only.
2. In L3, `NO BUSINESS DECISION = NO CODING`; L3 bugs also require causal root cause.
3. Documents, BR, TKCB, TKCT, code, DB and tests are **evidence, not authority**.
4. Conclusions classified `FACT` / `INFERENCE` / `ASSUMPTION` / `PROPOSAL`.
5. Contradictions surfaced (`C-001`, …), never silently resolved.
6. Impact, scope, and test depth are proportional; the full readiness package is L3-only.
7. Conventions are discovered once, persisted, reused; refreshed only on defined triggers; local convention beats generic cache.
8. Implementation avoids unrelated scope creep; optional improvements go to assessment, not to the diff.
9. Validation requires evidence; E2E runs only when it closes a stated risk gap.
10. Independent review and product assessment are L3/on-demand; review loops max at 3.
11. Manual verification is a valid completion state when proportional.
12. Quiet execution; standardized quick/detailed reporting; no execution diary.

### 1.3 What is LVN-specific and must NOT be extracted

- Terminology `TKCB` / `TKCT` / `BR` is kept as *example evidence sources* only; the preset phrases it as "requirement/design documents (e.g. TKCB, TKCT, BR/BRD)".
- Everything in `.ai-workflow/conventions/metadata.json` (FastAPI/Next.js/Go service map) is project runtime data, never shipped.
- No paths, module names, languages or frameworks from LVN ERP appear in the toolkit.

## 2. Target architecture

```
claude-workflow-kit/            (monorepo, npm workspaces, ESM, TS)
├── packages/
│   ├── workflow-core/          @claude-workflow-kit/workflow-core
│   │   ├── workflows/*.yaml    solution-analysis, quick-fix, standard-change, feature-change, bug-fix, generic
│   │   └── src/                types, loader, state machine, store, runtime, cw CLI
│   ├── claude-adapter/         @claude-workflow-kit/claude-adapter  (assets only, no build)
│   │   ├── presets/senior-dev/ skills, agents, templates, claude-md block
│   │   ├── hooks/cw-hook.mjs
│   │   └── settings.template.json
│   ├── monitor-server/         @claude-workflow-kit/monitor-server (node:http + SSE, zero deps)
│   ├── monitor-ui/             @claude-workflow-kit/monitor-ui (React + TS + Vite + React Flow + Zustand)
│   └── installer/              claude-workflow-kit  ← the published package, bins: claude-workflow-kit, cw
├── examples/demo-project/      fixture for E2E
└── docs/
```

Target project after `init` (no toolkit source copied in):

```
my-project/
├── .claude/{skills,agents,hooks,settings.json}
├── .ai-workflow/{config.json,conventions/,templates/,runs/,current-run}
└── CLAUDE.md   (managed block only)
```

## 3. Major design decisions

**D1 — Two independent state layers.**
*Semantic* workflow state (phase, gate, run) is emitted **explicitly** by skills through the `cw` CLI.
*Runtime* state (Claude active / tool running / subagent / stopped) comes **only** from Claude Code hooks.
Hooks never infer a business phase. This is the core correctness rule of the design.

**D2 — CLI owns state, Claude never edits JSON.**
Every mutation goes through `cw`. Claude is told to run commands, not to write `state.json`. Removes an entire class of drift/corruption.

**D3 — Workflow topology is data, not React.**
YAML in `workflow-core/workflows/`, overridable per project in `.ai-workflow/workflows/`. Both the state machine and the diagram read the same file. Adding a phase = editing YAML.

**D4 — File-based runtime state, no database.**
`state.json` (current truth, atomic write) + `events.jsonl` (append-only history). Sufficient for single-machine, single-repo runs. Revisit only with evidence.

**D5 — Monitor server polls, does not watch.**
1s mtime scan of `.ai-workflow/runs`. `fs.watch` recursive is unreliable on Windows and the server needs a periodic tick anyway for stall detection. One mechanism instead of two.

**D6 — SSE, not WebSocket.**
Traffic is server→client only. SSE is built into `node:http` and `EventSource`; a WebSocket dependency buys nothing here.

**D7 — `WAITING_USER` is modelled as a node with `kind: waiting`.**
Data-driven, so the branch is visible without UI hardcoding. A waiting node may
be explicitly `advisory: true` (the gate-free L2 clarification) or bind to a hard
L3 gate. The loader rejects an unmarked gate-free wait so a missing L3 gate
cannot silently weaken policy. `cw gate wait G` / `cw gate pass G` operate only
on gate-bound waiting nodes; an advisory node resumes through its declared edge.
Waiting nodes cannot be completed or skipped directly; only a legal resume edge
or the bound gate decision settles them.

**D8 — `STALE` / `POSSIBLY_STALLED` is derived, never stored.**
Computed from `lastActivityAt` vs threshold at read time. A stalled run is never rewritten as `FAILED`.

**D9 — One task run, even when its workflow level changes.**
`.ai-workflow/current-run` holds the active run id. A follow-up prompt during `WAITING_USER` continues the same run. An unrelated prompt with no active run may open a `generic` run (configurable, default on).
When routing classifies that prompt, the generic topology is promoted in place.
Likewise, `cw run escalate` replaces L1/L2 topology with the necessary higher
level while preserving the run id, evidence directory, owner, timestamps, and
append-only event history. Escalation opens the target L3 gates; it never
abandons prior work or starts analysis from zero.

**D10 — Execution depth and report depth are independent.**
The managed rules suppress routine narration and classify execution by risk.
`wf-final-report` returns a stable quick report by default or reuses a detailed
template when the user asks for a deliverable. A small task can therefore have a
detailed handover without paying for full execution phases, and an L3 task can
answer a status question briefly.

**D11 — Installer merges, never overwrites.**
`CLAUDE.md` gets a `<!-- CW:START -->…<!-- CW:END -->` managed block. `.claude/settings.json` hooks are merged by matcher; unrelated user settings are untouched. Modified files are backed up as `*.cw-backup`.

**D12 — `CW_STRICT` governs graph transitions and nothing else.**
`cw phase enter X` rejects a transition with no matching edge, or with an unpassed gate. `CW_STRICT=0` (or an explicit `--force`) downgrades *that* to a forced transition, recorded as `FORCED_TRANSITION`, so a broken workflow definition can never hard-block real engineering work. It deliberately does not reach anything else: it never passes a gate, never skips artifact validation, never bypasses ownership and never completes a run. An earlier version derived `force` for *every* command from `CW_STRICT`, which meant one environment variable silently switched gate validation off.

**D13 — Mutation authorisation has two categories, and command execution is one of them.**
Refusing `cw phase enter implementation` is bookkeeping; it does not stop an `Edit`. The `PreToolUse` hook therefore answers a different question: may this call change anything right now?

- *Repository mutation* — file-writing tools (`mutationTools`, plus `mutationToolPatterns` for MCP writers whose names are server-defined) and command tools (`commandTools`). Denied while any gate is unpassed.
- *Workflow artifact writes* — a write that resolves to exactly `<activeRunDir>/<name>` where `<name>` is declared by the *current* phase and is not machine-owned. Allowed behind the gate: the phase that produces a gate's evidence cannot be blocked by that gate.

Command execution is the part that decides whether "hard gate" is true at all: a shell writes any file in one line. Behind an open gate a command must pass `evaluateCommand` — every segment's program on a read-only allowlist, no redirection, no command substitution, no pipes into writers, no interpreters, and no write-capable flags on otherwise-read-only tools (`find -delete`, `fd -x`, `sort -o`). `awk` and `env` are off the allowlist because both launch arbitrary programs while reading as text utilities. The one deliberate soft edge is `allowTestCommandsBehindGate` (default on): package scripts and build targets run, and they *can* write generated files. `false` makes the gate strictly read-only.

Any failure inside the hook still degrades to *allow* — a broken kit must not stop the user working — which is exactly why D19 records that it happened.

**D14 — A gate needs evidence that is actually evidence.**
`cw gate pass G` requires the run to have *entered* the phase that owns `G`, and that phase's declared artifact to be a regular, non-empty file inside the run directory. A directory named `business-decision.md` and a zero-byte file both used to satisfy "is the name in the listing". There is no `--force`; `cw gate override G --reason "…"` is a separate command that demands a reason and writes a `GATE_OVERRIDE` event plus permanent provenance on the gate.

Waiting is walked into, not teleported to: `cw gate wait G` is refused unless the run is standing on `G`'s owning phase, that phase has been entered, and an open edge to the waiting node exists. `gateProvenance` records `decidedAtNode`, `ownerVisit`, timestamps and the waiting node, so `gate pass` from a waiting node can check the run legitimately waited there.

**D15 — Authorisation is repository-scoped; ownership is session-scoped.**
These are different questions and were once answered by the same lookup. Mutation policy inspects *every* active run in the worktree: while any of them has an open gate, no session may change the repository. Session ownership (`sessions.json` + `ownerSessionId`) governs telemetry — a hook from session B must not overwrite session A's runtime state — and semantic commands: the policy denies `cw phase/gate/run …` issued by a session that does not own the target run, and recovery is explicit (`cw run claim`, `cw run transfer`). Because `cw` runs over a shell and usually carries no session identity, that check is enforceable at the hook (which knows the session) and advisory in the CLI (which only checks when `--session`/`CW_SESSION`/`CLAUDE_SESSION_ID` is present).

Retiring a run whose gate is still open is the one legitimate way past that gate, so it cannot be a bare command: `cw run abandon` and `cw run start --force` both require a stated reason and record the unpassed gates in the event log.

**D16 — Terminal states are verified, and a failed run has no live node.**
`cw run complete` checks that every gate passed, every phase completed or was skipped, nothing is still waiting on the user, the run is at the workflow's end, and every required artifact is present. There is no `--force`: a run that cannot finish is retired with `cw run abandon`, and `ABANDONED` never reads as success. Conversely, `run fail` / `gate fail` / `phase fail` settle *every* live node, because a node left `ACTIVE` or `WAITING_USER` under a `FAILED` header is a diagram contradicting its own header.

**D17 — Semantic lag is reported, not inferred away — and only when it means something.**
`lastSemanticAt` and `lastRuntimeAt` are tracked separately. Runtime fresh + semantic stale = `SEMANTIC_LAG` in the monitor, `cw status` and `doctor`. It is only reported while the runtime is genuinely working (`ACTIVE`, `TOOL_RUNNING`, `SUBAGENT_RUNNING`): an `IDLE`, `STOPPED`, `FAILED` or `UNKNOWN` session is not "working without reporting", and calling that lag was noise that trained the user to ignore the badge.

**D18 — Corrupt is not empty, and validation lives at the storage boundary.**
`RunStateCorruptError` is distinct from `RunNotFoundError`, and *structural* validation runs in `readRun`, so parseable JSON with an invented status or a missing `nodes` map is corrupt too — every consumer downstream would otherwise read it as a working run. `cw status` exits 2, `run list` exits 1, `doctor` fails, the monitor lists it under `unreadableRuns`, and `cw run start` refuses while the current run is unreadable. Retirement is explicit and never deserialises the broken state: `cw run quarantine-current --reason "…"` preserves the corrupt files, drops a `QUARANTINED` marker, clears the pointer and appends to `quarantine.jsonl`.

**D19 — A policy that failed open must not look like a policy that allowed.**
The hook fails open by design, and Claude Code reads "no output" as "no opinion" — indistinguishable from an allow. So every `PreToolUse` evaluation writes `policy-health.json`: `OK`, `DISABLED` (`enforceGates: false`) or `DEGRADED` (the hook threw). `doctor` reports `DEGRADED` as a failure, `cw status` and `cw policy` print it, and the monitor shows a badge.

**D20 — The monitor's live path is a fact, not an inference.**
`transitions` records the edges actually traversed. The diagram animates only the last one, and nothing at all once the run is terminal. Deriving "active path" from "predecessor completed and target is current" lit every edge of a review loop simultaneously and kept animating after the run ended. Time-derived values (`derivedStatus`, `derivedSemantic`) are part of the change signature, because they flip with no new event and the browser has to hear about it.

**D21 — A non-default runtime directory is discoverable without flags.**
`--runtime <dir>` is chosen at install time, but the hook, `cw` from a skill, `doctor` and the monitor all start with no flags. The installer records the name in `.claude/cw-runtime`; everything resolves through `resolveRuntimeDirName()`. Previously a custom runtime directory left the hook looking in `.ai-workflow/`, finding no config, and silently enforcing nothing.

**D22 — Risk level selects topology; it is not a flag on one giant graph.**
L0-L1 use `quick-fix`, L2 uses `standard-change`, and L3 uses the original full
bug/feature graphs. This keeps L2 free of hard-gate artifacts while preserving
strong enforcement once an L3 run starts. A gate-free waiting node lets L2 ask
one material clarification without turning the entire run into a hard gate; the
definition must mark that node `advisory: true` explicitly.

**D23 — Templates are shared project assets and updates are non-destructive.**
The preset ships report, intake, and analysis artifact templates. The installer copies only missing files
to `.ai-workflow/templates/`; existing project versions win and deleted defaults
are restored. Templates are committable like convention knowledge. Runtime
artifact validation still verifies presence/non-emptiness; semantic structure is
owned by `wf-final-report` and focused installer tests.

**D24 — Solution analysis is a separate approved, traceable run.**
`solution-analysis` writes six mandatory artifacts and records relevant-source
SHA-256 hashes, then waits at `ANALYSIS_READY`. Explicit approval persists the
chosen solution and scope. Handoff creates a `feature-change` with
`sourceAnalysisRunId`; valid artifacts skip evidence/business/readiness, while a
stale source snapshot leaves `BUSINESS_READY` open and blocks implementation.

**D26 — The mission is a layer on the run, not a second store.**
Classification, plan, evidence status, confidence, risks, decisions, task
breakdown, checkpoints and deliverables live in `RunState.mission`, so they
inherit the atomic write, the append-only event log, the session ownership rules
and the corrupt-state boundary that already exist. A second file would have needed
all four again, and could disagree with the run it describes. `mission` is
optional: every run written before V2 stays readable, and `validateRunState`
rejects an invented mission state or a non-array collection as corrupt, because a
mission whose `risks` is a string would render as a clean board.

**D27 — Routing is derived, and depth can only go up.**
`routeMission` maps (task type, subtypes, complexity, declared risk, structural
flags) to a workflow class and a topology. Complexity sets the floor; risk,
high-risk task types and structural facts raise it; nothing lowers it, and an
explicit user request for a deeper path always wins. The mandatory checkpoint
list, the validation steps and the confidence floors are computed from the same
input rather than remembered by a skill — a prose rule that every workflow body
has to re-implement is a rule that erodes. Five classes reuse the existing five
topologies (Lightning/Fast → `quick-fix`, Standard → `standard-change`, Deep →
`bug-fix`/`feature-change`, Research → `solution-analysis`) instead of adding new
graphs that would duplicate them.

**D28 — Checkpoints are enforced by the mutation policy, not by prose.**
A pending blocking checkpoint, a mandatory pre-implementation checkpoint that was
never opened, a paused mission, or evidence the mission itself marked
`MISSING`/`CONFLICTING`/`OUTDATED` all deny repository writes and non-read-only
commands, exactly like an unpassed gate. This is what makes V2 real on the
gate-free topologies: without it, `standard-change` could print "checkpoint
required" and keep editing. `RELEASE` is deliberately non-blocking (it gates the
release step, and blocking it would stop the run writing its own release
evidence), and `CODE` is excluded from the never-opened check because it is
answered *after* code exists — requiring it earlier would deadlock.

**D29 — Confidence gates the phase, not every keystroke.**
Numbers below a floor, and unassessed dimensions, are checked when the
implementation phase is entered; they are not part of the mutation policy. A
confidence score is a judgment the model keeps revising, and denying every write
on an unassessed dimension would fire before the mission had any chance to assess
it. Floors scale with workflow class so a Lightning label change owes two numbers,
not six — ceremony proportional to a trivial task is how a workflow gets skipped
wholesale. `cw mission accept-risk --reason "…"` waives exactly the blockers
listed at that moment and keeps them visible as accepted risk; it can never open a
hard gate, which still needs its evidence artifact or an audited override.

**D30 — Board writes are same-origin; board reads are not.**
`/api/state` keeps `access-control-allow-origin: *` because it is local telemetry,
but `POST /api/runs/:id/actions` refuses a request carrying a foreign `Origin`:
any page the user has open could otherwise approve a checkpoint on their behalf,
with no credentials involved. A request with no `Origin` at all (curl, a script) is
allowed — it already has the shell access to run `cw` directly. Every action maps
to exactly one runtime call with the same requirements as the CLI (a rejection
needs a note, a cancellation needs a reason), and the response is the refreshed
run detail so the board shows the result of the click rather than waiting a poll.

**D31 — Mission state follows the phase, except while the user is being asked.**
`syncMissionState` advances the mission when a phase is entered, so the board does
not depend on a skill remembering a second command — but never while a checkpoint
is pending, because the board must keep saying it is waiting on the user until the
user answers. Illegal jumps are refused, `--force` records the jump as forced, and
a forced state that the topology contradicts is reported as drift instead of being
resolved in either direction. A paused mission leaves only through `resume`, which
restores the state it stood in rather than guessing a forward one.

**D25 — Installer ownership is hash-based and legacy-safe.**
New manifests record hashes for framework-owned skills, agents, and hooks.
Unmodified managed files update normally; modified, project-owned, or legacy
files without provable ownership are preserved and reported as conflicts.

## 4. Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | Claude forgets to emit `cw phase …`, so the diagram lags reality. | Every phase skill starts and ends with its own `cw` command; `lastSemanticAt` vs `lastRuntimeAt` yields `SEMANTIC_LAG`, surfaced by `cw status`, `claude-workflow-kit doctor` and the monitor (D16). |
| R2 | Hooks break the user's Claude Code session. | Hook script catches everything and always exits 0; failures go to `.ai-workflow/hook-errors.log` **and** to `policy-health.json` as `DEGRADED`, so failing open is visible rather than indistinguishable from allowing (D19). |
| R8 | A test or build command allowed behind an open gate writes files anyway (package script, Makefile target, updated snapshot). | Accepted and documented: `allowTestCommandsBehindGate` (default on) is the one soft edge of the gate; set it to `false` for a strictly read-only gate. |
| R9 | A command tool that is not in `commandTools` (a new MCP shell, a future built-in) executes commands unchecked. | The list is config, and `doctor` reports policy health; a tool outside both `commandTools` and `mutationTools`/`mutationToolPatterns` is not covered, and the README says so instead of implying total coverage. |
| R10 | `cw` invoked outside Claude Code carries no session identity, so semantic ownership is unenforced there. | Enforced at the hook, which knows the session; the CLI checks when an identity is available. Documented as such rather than claimed as a hard boundary. |
| R3 | `cw` not on PATH in the target project. | `init` records an absolute `runtimeUrl` in `.ai-workflow/config.json`; the hook imports that directly and never relies on PATH. |
| R4 | Installer damages an existing `CLAUDE.md` / `settings.json`. | Marker block + structural merge + backup + `uninstall` that removes only managed content. |
| R5 | Concurrent writers corrupt `state.json`. | Write temp file + `rename` (atomic on same volume). Events are append-only. |
| R6 | Preset drifts from the LVN original. | Preset text is a direct port; `docs/preset-senior-dev.md` records the mapping. |
| R7 | Polling cost on large repos. | Scan is limited to `.ai-workflow/runs/*/state.json` mtimes, not the repo. |

## 5. Implementation plan

| Phase | Content | Done when |
| --- | --- | --- |
| 1 | Audit + this document | ✅ |
| 2 | `workflow-core`: types, YAML loader, state machine, store, `cw` CLI, unit tests | `node --test` green |
| 3 | `claude-adapter`: `senior-dev` preset skills/agents/rules, hook script, settings template | Skills emit correct `cw` transitions |
| 4 | `monitor-server`: run discovery, SSE, stall detection, static hosting | `curl /api/state` returns runs |
| 5 | `monitor-ui`: React Flow diagram, node states, detail panel, run selector | Live diagram follows a run |
| 6 | `installer`: `init` / `update` / `doctor` / `uninstall` | Idempotent on rerun |
| 7 | `examples/demo-project` + E2E script | Full run drives the UI |

`D:\lvn-erp` is read-only during development. Migration for LVN ERP is proposed only after the toolkit passes its own E2E.
