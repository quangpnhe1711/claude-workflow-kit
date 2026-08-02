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

**D10 — Caveman is optional.**
Preset rule: use `caveman:caveman-compress` if present, otherwise the built-in compact-output policy. Workflow correctness never depends on it.

**D11 — Installer merges, never overwrites.**
`CLAUDE.md` gets a `<!-- CW:START -->…<!-- CW:END -->` managed block. `.claude/settings.json` hooks are merged by matcher; unrelated user settings are untouched. Modified files are backed up as `*.cw-backup`.

**D12 — Strict transition validation, escapable.**
`cw phase enter X` rejects a transition with no matching edge, or with an unpassed gate. `CW_STRICT=0` downgrades to a warning so a broken workflow definition can never hard-block real engineering work.

## 4. Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | Claude forgets to emit `cw phase …`, so the diagram lags reality. | Every phase skill starts and ends with its own `cw` command; `cw doctor` reports runs whose semantic state is older than their runtime activity. |
| R2 | Hooks break the user's Claude Code session. | Hook script catches everything and always exits 0; failures go to `.ai-workflow/hook-errors.log`. |
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
