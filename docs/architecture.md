# claude-workflow-kit — extracted workflow, target architecture, decisions

Phase 1 deliverable. Written before implementation.

## 1. Extracted current workflow (source: `D:\lvn-erp`)

### 1.1 What exists today

| Kind | Item | Role |
| --- | --- | --- |
| Entry skill | `work` | Classifies task, routes to `bug-fix` or `feature-change`. No third ad-hoc workflow. |
| Entry skill | `feature-change` | 10-phase controlled change workflow. |
| Entry skill | `bug-fix` | 10-phase controlled defect workflow. |
| Entry skill | `refresh-conventions` | Bootstrap/refresh persisted conventions. |
| Step skill | `wf-evidence-reconciliation` | Reconcile intent / TKCB / TKCT / BR / DB / code / tests. |
| Step skill | `wf-bug-root-cause` | Reproduce, trace, causal root cause. |
| Step skill | `wf-business-decision` | Hard gate → `BUSINESS_READY` / `BUSINESS_BLOCKED`. |
| Step skill | `wf-change-readiness` | Plan + impact + risk + scope + test strategy. |
| Step skill | `wf-convention-manager` | Cache-first convention reuse. |
| Step skill | `wf-implement` | Smallest correct change, no scope creep. |
| Step skill | `wf-validation-e2e` | Evidence-based validation + E2E. |
| Step skill | `wf-product-assessment` | Post-implementation, evidence-backed only. |
| Step skill | `wf-final-report` | Compact report, no execution diary. |
| Agent | `business-analyst` | Read-only reconciliation. |
| Agent | `root-cause-analyst` | Read-only causal tracing. |
| Agent | `independent-reviewer` | Read-only post-implementation review, PASS/FAIL. |
| Rules | `CLAUDE.md` | Execution mode, evidence policy, hard gates, scope/test/convention discipline, assessment, final response shape. |
| Runtime | `.ai-workflow/conventions/` | `code.md`, `comments.md`, `testing.md`, `database.md`, `metadata.json`. |
| Runtime | `.ai-workflow/runs/` | Per-task evidence artifacts (declared, not yet structured). |

### 1.2 Behavioral invariants that must survive extraction

1. `NO BUSINESS DECISION = NO CODING`.
2. Bugs: `NO ROOT CAUSE = NO FIX`.
3. Documents, BR, TKCB, TKCT, code, DB and tests are **evidence, not authority**.
4. Conclusions classified `FACT` / `INFERENCE` / `ASSUMPTION` / `PROPOSAL`.
5. Contradictions surfaced (`C-001`, …), never silently resolved.
6. Impact + risk + scope + test strategy precede implementation.
7. Conventions are discovered once, persisted, reused; refreshed only on defined triggers; local convention beats generic cache.
8. Implementation avoids unrelated scope creep; optional improvements go to assessment, not to the diff.
9. Validation/E2E require evidence; never PASS on "looks correct".
10. Independent review after implementation/E2E, max 3 loops.
11. Post-implementation product/technical assessment; recommendations are report-only unless Critical/High correctness.
12. Quiet execution; compact final report; no execution diary.

### 1.3 What is LVN-specific and must NOT be extracted

- Terminology `TKCB` / `TKCT` / `BR` is kept as *example evidence sources* only; the preset phrases it as "requirement/design documents (e.g. TKCB, TKCT, BR/BRD)".
- Everything in `.ai-workflow/conventions/metadata.json` (FastAPI/Next.js/Go service map) is project runtime data, never shipped.
- No paths, module names, languages or frameworks from LVN ERP appear in the toolkit.

## 2. Target architecture

```
claude-workflow-kit/            (monorepo, npm workspaces, ESM, TS)
├── packages/
│   ├── workflow-core/          @claude-workflow-kit/workflow-core
│   │   ├── workflows/*.yaml    feature-change, bug-fix, generic
│   │   └── src/                types, loader, state machine, store, runtime, cw CLI
│   ├── claude-adapter/         @claude-workflow-kit/claude-adapter  (assets only, no build)
│   │   ├── presets/senior-dev/ skills, agents, claude-md block  ← extracted LVN workflow
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
├── .ai-workflow/{config.json,conventions/,runs/,current-run}
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
Data-driven, so the branch is visible in the diagram without hardcoding it in the UI. `cw gate wait G` marks waiting-nodes bound to `G`; `cw gate pass G` skips them.

**D8 — `STALE` / `POSSIBLY_STALLED` is derived, never stored.**
Computed from `lastActivityAt` vs threshold at read time. A stalled run is never rewritten as `FAILED`.

**D9 — One run per workflow command, not per message.**
`.ai-workflow/current-run` holds the active run id. A follow-up prompt during `WAITING_USER` continues the same run. An unrelated prompt with no active run may open a `generic` run (configurable, default on).

**D10 — The output policy is built in, and brevity is a property of the wording only.**
The managed `CLAUDE.md` block carries the compact-output rule; it depends on no external compression plugin. Depth is budgeted per step, not globally: execution narration is suppressed, while the steps that decide something — evidence reconciliation, business decision, readiness, implementation, review, and the final report — run at high reasoning effort. `wf-final-report` in particular is short *and* high-effort: choosing which risks and limitations are load-bearing is the hardest judgement in the run, and a report made brief by thinking less is how a known limitation goes unmentioned.

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
