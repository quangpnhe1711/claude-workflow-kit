# Preset `senior-dev` — mapping from the source project

The preset is a direct port of an existing per-project Claude Code setup
(`D:\lvn-erp`). This file records what moved where, so drift is visible.

## Skills

| Source | Preset | Change |
| --- | --- | --- |
| `.claude/skills/work/SKILL.md` | `skills/work` | Note added: the selected workflow opens the run. |
| `.claude/skills/feature-change/SKILL.md` | `skills/feature-change` | `cw` transitions added per phase; `TKCB/TKCT/BR` rephrased as "requirement/design documents (for example …)". |
| `.claude/skills/bug-fix/SKILL.md` | `skills/bug-fix` | `cw` transitions added; `ROOT_CAUSE_READY` made an explicit gate. |
| `.claude/skills/refresh-conventions/SKILL.md` | `skills/refresh-conventions` | `metadata.json` contract documented; "Javadoc" generalised to "docblock". |
| `.claude/skills/wf-evidence-reconciliation` | same | Artifact path + `cw artifact`; delegation to `business-analyst` made explicit. |
| `.claude/skills/wf-bug-root-cause` | same | Gate outcome commands added. |
| `.claude/skills/wf-business-decision` | same | Gate outcome commands added. |
| `.claude/skills/wf-change-readiness` | same | Artifact paths made concrete. |
| `.claude/skills/wf-convention-manager` | same | Unchanged apart from the `refresh-conventions` reference. |
| `.claude/skills/wf-implement` | same | Precondition check phrased against `cw status`. |
| `.claude/skills/wf-validation-e2e` | same | Artifact path made concrete. |
| `.claude/skills/wf-product-assessment` | same | Artifact path made concrete. |
| `.claude/skills/wf-final-report` | same | Optional Caveman clause added. |
| — | `skills/wf-status` | New. Resume/inspect the current run. |

## Agents

`business-analyst`, `root-cause-analyst`, `independent-reviewer` are ported
verbatim except that `TKCB/TKCT/BR` became "design documents" in one
description.

## Rules

`CLAUDE.md` moves into the managed block `presets/senior-dev/claude-md.md`,
with two additions:

1. The optional-Caveman clause.
2. A **Workflow state reporting** section defining the `cw` contract and the
   rule that monitoring is observability, never a gate on engineering work.

## Deliberately not extracted

- `.ai-workflow/conventions/*` — LVN-specific runtime data (FastAPI/Next.js/Go
  service map). Regenerated per project by `/refresh-conventions`.
- Any LVN path, service name, framework or module reference.

## Adding a preset

```
packages/claude-adapter/presets/<id>/
├── preset.json      id, label, skills[], agents[], claudeMd
├── claude-md.md     the managed block
├── skills/<name>/SKILL.md
└── agents/<name>.md
```

Then `claude-workflow-kit init --preset <id>`. Presets may reference workflow
ids shipped by `workflow-core` or ones the project supplies in
`.ai-workflow/workflows/`.
