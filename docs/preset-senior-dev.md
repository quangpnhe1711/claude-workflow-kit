# Preset `senior-dev` — mapping from the source project

The preset is a direct port of an existing per-project Claude Code setup
(`D:\lvn-erp`). This file records what moved where, so drift is visible.

## Skills

| Source | Preset | Change |
| --- | --- | --- |
| `.claude/skills/work/SKILL.md` | `skills/work` | L0-L3 classification, one-body routing, and report-only routing. |
| `.claude/skills/solution-analysis/SKILL.md` | `skills/solution-analysis` | Analysis-only entry with smart intake, source impact, solution selection, and explicit approval. |
| `.claude/skills/feature-change/SKILL.md` | `skills/feature-change` | Risk-adaptive entry; full feature body reserved for L3. |
| `.claude/skills/bug-fix/SKILL.md` | `skills/bug-fix` | Risk-adaptive entry; full root-cause-gated body reserved for L3. |
| — | `skills/wf-quick-fix` | L0-L1 fast path with targeted verification and requested detailed reporting. |
| — | `skills/wf-standard-change` | New gate-free L2 targeted-impact workflow body. |
| — | `skills/wf-solution-analysis` | Produces the six-file analysis contract and stops at `ANALYSIS_READY`. |
| — | `skills/wf-feature-from-analysis` | Checks source freshness and continues implementation without repeating analysis. |
| `.claude/skills/refresh-conventions/SKILL.md` | `skills/refresh-conventions` | `metadata.json` contract documented; "Javadoc" generalised to "docblock". |
| `.claude/skills/wf-evidence-reconciliation` | same | Artifact path + `cw artifact`; delegation to `business-analyst` made explicit. |
| `.claude/skills/wf-bug-root-cause` | same | Gate outcome commands added. |
| `.claude/skills/wf-business-decision` | same | Gate outcome commands added. |
| `.claude/skills/wf-change-readiness` | same | Artifact paths made concrete. |
| `.claude/skills/wf-convention-manager` | same | Unchanged apart from the `refresh-conventions` reference. |
| `.claude/skills/wf-implement` | same | Precondition check phrased against `cw status`. |
| `.claude/skills/wf-validation-e2e` | same | Risk-based verification; E2E requires a stated coverage/risk reason. |
| `.claude/skills/wf-product-assessment` | same | Artifact path made concrete. |
| `.claude/skills/wf-final-report` | same | Quick/detailed router; reuses project report templates. |
| — | `skills/wf-status` | New. Resume/inspect the current run. |

## Agents

`business-analyst`, `root-cause-analyst`, `independent-reviewer` are ported
verbatim except that `TKCB/TKCT/BR` became "design documents" in one
description.

## Rules

`CLAUDE.md` moves into the managed block `presets/senior-dev/claude-md.md`,
with L0-L3 classification, proportional business/testing gates, on-demand skill
use, convention-cache reuse, manual-verification semantics, quick/detailed
reporting, and the `cw` state-reporting contract. The policy is self-contained
and depends on no external output-compression plugin.

Report, intake, and solution-analysis artifact structures live under
`templates/` and install into `.ai-workflow/templates/`. Existing project
templates are reused on update.

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
├── agents/<name>.md
└── templates/*.md   reusable detailed-report structures
```

Then `claude-workflow-kit init --preset <id>`. Presets may reference workflow
ids shipped by `workflow-core` or ones the project supplies in
`.ai-workflow/workflows/`.
