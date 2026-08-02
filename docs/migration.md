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
- `.ai-workflow/{config.json,conventions/,runs/}` created. An existing
  `conventions/` directory is left exactly as it is.

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

Then, inside Claude Code, run a small real change with `/feature-change`.
Watch the diagram: phases should advance as the work advances, the gate should
turn amber when Claude asks a business question, and the active node should
show the live tool.

If the diagram lags the conversation, the skill is not emitting `cw` — that is
the failure mode to look for, and it does not affect the engineering work
itself.

## 7. Decide what to commit

```
.ai-workflow/conventions/    commit — shared repository knowledge
.ai-workflow/runs/           gitignored by default (a .gitignore is installed)
.ai-workflow/config.json     commit — port and thresholds are team settings
.claude/                     commit
CLAUDE.md                    commit
*.cw-backup                  delete once satisfied
```

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
