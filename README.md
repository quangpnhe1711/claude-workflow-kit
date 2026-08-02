# claude-workflow-kit

A portable Claude Code development workflow, plus a live diagram that shows
exactly where Claude is in it and whether Claude is actually working.

Install it into any repository. The toolkit stays in `node_modules`; the target
project only gets `.claude/` and a small `.ai-workflow/` runtime directory.

```
npx claude-workflow-kit init      # install skills, agents, hooks, rules
npx cw monitor                    # live workflow diagram on :4173
npx claude-workflow-kit doctor    # verify the installation
```

## What it enforces

The default `senior-dev` preset carries hard rules, not suggestions:

- **NO BUSINESS DECISION = NO CODING** — the state machine physically refuses
  `implementation` until the `BUSINESS_READY` gate passes.
- **NO ROOT CAUSE = NO FIX** — the bug workflow gates on `ROOT_CAUSE_READY`.
- Documents, requirements, DB, code and tests are *evidence*, not authority.
  Contradictions are surfaced (`C-001`, …), not silently resolved.
- Impact, risk, scope and test strategy precede implementation.
- Conventions are discovered once, cached in `.ai-workflow/conventions/`, reused.
- No unrelated scope creep; optional improvements go to the assessment report.
- Independent review after implementation and E2E, max 3 loops.
- Compact, quiet output. No execution diary.

## Two state layers, kept apart

This is the core design decision. Confusing these two is what makes most
"agent dashboards" lie.

| | Source | Example |
| --- | --- | --- |
| **Semantic workflow state** | Skills, explicitly, through the `cw` CLI | `BUSINESS_DECISION`, gate `BUSINESS_READY = WAITING` |
| **Claude runtime state** | Claude Code lifecycle hooks | `TOOL_RUNNING`, tool `Grep`, 3s since last event |

A hook never decides a business phase. A phase never guesses whether Claude is
alive. The monitor shows both, side by side, so
`BUSINESS_DECISION / WAITING_USER` is visibly different from
`BUSINESS_DECISION / POSSIBLY_STALLED`.

A run that goes quiet is reported as `POSSIBLY_STALLED`, never as `FAILED`.

## Packages

| Package | Purpose |
| --- | --- |
| `@claude-workflow-kit/workflow-core` | Workflow definitions (YAML), state machine, run store, event schema, the `cw` CLI |
| `@claude-workflow-kit/claude-adapter` | The `senior-dev` preset: skills, agents, hook script, `CLAUDE.md` block, settings template |
| `@claude-workflow-kit/monitor-server` | Run discovery, JSON API, SSE stream, stall detection (zero runtime dependencies) |
| `@claude-workflow-kit/monitor-ui` | React + React Flow live workflow diagram |
| `claude-workflow-kit` | The published package: `init` / `update` / `doctor` / `uninstall`, and the `cw` binary |

## Workflows are data

Graph topology lives in YAML, never in React. The state machine and the diagram
read the same file, so adding a phase is a YAML edit.

```yaml
nodes:
  - id: business
    label: Business Decision
    gate: BUSINESS_READY
  - id: await-business
    kind: waiting
    gate: BUSINESS_READY
edges:
  - { from: business, to: await-business, when: "!BUSINESS_READY" }
  - { from: business, to: readiness,      when: BUSINESS_READY }
```

Built-in: `feature-change`, `bug-fix`, `generic`. A project overrides any of
them by dropping a file with the same `id` in `.ai-workflow/workflows/`.

## The `cw` CLI owns state

Claude never edits `state.json`. Skills emit transitions:

```
cw run start feature-change --label "edit history"
cw phase enter evidence
cw phase complete
cw phase enter business
cw gate wait BUSINESS_READY --message "aggregate or per-entity ownership?"
cw gate pass BUSINESS_READY
cw phase enter readiness
cw run complete
cw status                      # where am I, which transitions are legal
```

An illegal transition is refused:

```
$ cw phase enter implementation
cw: cannot enter "implementation" from "business": no edge business -> implementation.
    Allowed: await-business
```

## Runtime layout in the target project

```
my-project/
├── .claude/
│   ├── skills/          feature-change, bug-fix, work, wf-*
│   ├── agents/          business-analyst, root-cause-analyst, independent-reviewer
│   ├── hooks/cw-hook.mjs
│   └── settings.json    kit hooks merged into your settings
├── .ai-workflow/
│   ├── config.json
│   ├── conventions/     persisted repo knowledge, reused across tasks
│   ├── runs/<run-id>/   state.json, events.jsonl, evidence.md, validation.md, …
│   └── current-run
└── CLAUDE.md            your rules + one managed <!-- CW:START --> block
```

## Installer safety

- `CLAUDE.md` gets a marked block. Everything outside it is never touched.
- `.claude/settings.json` hooks are merged; unrelated settings survive; reruns
  do not duplicate entries.
- Modified files are backed up as `*.cw-backup`.
- `uninstall` removes only what the manifest recorded, and keeps run evidence
  unless you pass `--purge`.

## Run correlation

One workflow command creates one run. A follow-up prompt while the run is
`WAITING_USER` continues the **same** run — it does not open a new one. An
unrelated prompt with no active run may open a `generic` run
(`autoGenericRun` in `config.json`).

## Caveman is optional

If `caveman:caveman-compress` is installed, the preset uses it for user-facing
output. If it is not, the built-in compact-output policy applies. Workflow
correctness never depends on it.

## Development

```
npm install
npm run build      # all packages
npm test           # unit tests (workflow-core, installer)
npm run e2e        # install into a temp copy of examples/demo-project and drive a full run
npm run dev:monitor  # UI on :5173, proxying to a `cw monitor` on :4173
```

Docs: [architecture and design decisions](docs/architecture.md) ·
[preset mapping](docs/preset-senior-dev.md) ·
[migrating an existing project](docs/migration.md)

## License

MIT
