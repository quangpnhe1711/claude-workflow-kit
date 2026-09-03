# Migrating a project that already has a hand-rolled `.claude/` workflow

Written for the source project this preset was extracted from, but the steps
apply to any repository that already carries its own skills and rules.

The toolkit passed its own E2E (`npm run e2e`) before this plan was written:
install, full gated run, waiting-user resume, hook activity, monitor API + SSE,
doctor, uninstall.

## 0. Prerequisites

Node >= 18.17. Nothing else.

## 1. Snapshot what exists

```
git status                  # must be clean
git checkout -b chore/claude-workflow-kit
```

The installer also writes `*.cw-backup` files, but a branch is the real safety net.

## 2. Dry run first

```
npx claude-workflow-kit init --project . --dry-run
```

Read the file list. Anything under `.claude/skills/`, `.claude/agents/`,
`.claude/hooks/` that the kit writes will replace the same-named local file.
If a local skill must survive, rename it before installing.

## 3. Install

```
npx claude-workflow-kit init --project .
```

What happens:

- `.claude/skills/*`, `.claude/agents/*`, `.claude/hooks/cw-hook.mjs` written.
- `.claude/settings.json` — kit hooks merged, existing settings and existing
  hooks preserved, backup written.
- `CLAUDE.md` — the kit's rules land inside `<!-- CW:START -->…<!-- CW:END -->`.
  Project-specific rules outside the markers are untouched, backup written.
- `.claude/prompts/*` — output contracts, read only when a document is asked
  for. `.claude/instructions/` is created with its contract; its content comes
  from `/map-repo`, never from the package.
- `.ai-workflow/{config.json,runs/}` created. Nothing else is runtime state any
  more: shared knowledge lives under `.claude/`.
  Existing customized or legacy-ownership files are preserved and reported;
  `doctor` explains any manual merge needed.

## 4. Verify

```
npx claude-workflow-kit doctor
```

Every line should be `✓`, except `monitor` until it is running. `runtimeUrl`
must be `ok` — that is the check that proves hooks can actually load the
runtime.

## 5. Reconcile the rules file

Open `CLAUDE.md`. The managed block now restates the workflow rules. Delete any
duplicate rule that used to live outside the markers, and keep only the parts
that are genuinely project-specific (domain vocabulary, deployment
constraints, module ownership).

## 6. Run one real task under the monitor

```
npx cw monitor        # http://127.0.0.1:4173
```

Then, inside Claude Code, just describe a bounded real change. Confirm it runs
natively: no classification block, no artifacts, and a
`Changed / Why / Verified` response. The monitor shows a `generic` run with live
tool activity — that is the expected shape for ordinary work.

For the hard-gate probe, deliberately run an irreversible example with
`/deep-change` (a migration or a permission change over existing data). Watch the
diagram: phases should advance as the work advances, the gate should turn amber
if Claude has a real decision to ask about, and the active node should show the
live tool.

Two things to check deliberately on the first run:

- Ask Claude to edit a file before the decision is recorded. The `PreToolUse`
  hook must refuse it, naming `DECISION_READY`. If the edit goes through,
  `enforceGates` is off or the hooks are not wired — run `doctor`.
- If the diagram lags the conversation, the skill is not emitting `cw`. The run
  is flagged `semantic lag` in the monitor and by `doctor`; the engineering work
  itself is unaffected.

## 7. Decide what to commit

```
.claude/instructions/        commit — scoped repository knowledge
.claude/prompts/             commit — output contracts
.ai-workflow/runs/           gitignored by default (a .gitignore is installed)
.ai-workflow/config.json     gitignored — it holds an absolute runtimeUrl for
                             this machine; re-created by `init` on each clone
.ai-workflow/sessions.json   gitignored — machine-local session correlation
.claude/                     commit
CLAUDE.md                    commit
*.cw-backup                  delete once satisfied
```

The installer writes `.ai-workflow/.gitignore` covering the machine-local files,
so this is the default without any action.

## 8. Updating later

```
npx claude-workflow-kit update
```

Refreshes skills, agents, hooks and the managed block. Keeps `config.json`
values, conventions and run history.

## Rollback

```
npx claude-workflow-kit uninstall          # keeps .ai-workflow evidence
npx claude-workflow-kit uninstall --purge  # removes it too
```

Or `git checkout -- .` on the branch. Backups are `*.cw-backup` next to each
modified file.
