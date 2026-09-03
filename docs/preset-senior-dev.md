# Preset: `senior-dev`

A set of developer capabilities that can be called at the right moment — not a
process every task has to pass through.

The v1 preset split the world by workflow phase and task category
(`quick-fix`, `standard-change`, `feature-change`, `bug-fix`, `checkpoint`,
`implementation`, `verification`, `review`). Every task, however small, entered
a router, produced artifacts, and reported through phases. It cost latency on
ordinary work without improving the result. This preset replaces that split.

## Layers

| Layer | Installed to | Loaded |
| --- | --- | --- |
| Global rules | `CLAUDE.md` managed block | always (167 lines) |
| Scoped repository knowledge | `.claude/instructions/<area>.instructions.md` | only the area being touched |
| Specialist capabilities | `.claude/skills/<name>/SKILL.md` | when the task needs the method |
| Output contracts | `.claude/prompts/<name>.prompt.md` | only when a document was asked for |
| Specialist agent | `.claude/agents/adversarial-reviewer.md` | inside `deep-change` only |

Each layer has one responsibility, and only the first is always in context.

## Routing

```text
any task            -> inspect -> change -> targeted verification -> report
evidence of a       -> load the matching capability, keep going
  specialized need
irreversible change -> deep-change: one gate, one decision, adversarial review
document requested  -> read one contract from .claude/prompts/
```

There is no classification step and no mission header. Depth is chosen from
three facts found while reading the code — change surface, uncertainty, and
blast radius — not from whether the request used the word "bug" or "feature".

## Capabilities

Each exists because Claude would otherwise be missing a method, not because a
process has a step with that name.

| Skill | The capability it adds |
| --- | --- |
| `root-cause-analysis` | value bisection, time/data/environment bisection, symptom vs contributing factor vs cause, tests that encode the bug |
| `impact-analysis` | consumer discovery for same-signature semantic changes, serialized-payload and job consumers, impact-to-check mapping |
| `feature-analysis` | system understanding: flow, data model, state transitions, transaction boundaries, idempotency, acceptance criteria to verification |
| `sql-compare` | normalization, join and NULL semantics, aggregation fan-out, pagination stability, parameter binding, dialect differences, `EXCEPT ALL` proof |
| `legacy-parity` | reference and tolerance up front, characterization tests, dual-run corpora, difference triage against the legacy's accidents |
| `schema-migration` | expand/migrate/switch/contract, the deploy invariant, locking behavior, resumable backfills, honest rollback |
| `api-contract-review` | breaking-change taxonomy including silent semantic breaks, consumer enumeration, compatible shipping strategies |
| `performance-investigation` | measure before changing, locate the dominant cost, fix one thing, prove it with a before/after |
| `map-repo` | derive and freshness-record `.claude/instructions/` from repeated evidence |
| `deep-change` | the one gated path for a change that cannot be reverted |

## The gated path

`deep-change` is for changes where being wrong costs data, access, money, or an
external consumer. It runs the `deep-change` workflow: one hard gate
(`DECISION_READY`) that the installed PreToolUse hook enforces by denying every
edit until the decision is recorded and — when it is a genuine product or risk
choice — answered by the user.

```text
investigate -> decide (gate + decision.md) -> implement -> verify -> review -> done
```

One gate, one artifact, one independent reviewer. Wide is not risky: a rename
across forty files is reversible and stays an ordinary task.

## Observability

`cw` still records runs for the Mission Board and the monitor, and the installed
hook feeds it automatically from Claude's tool activity. The preset no longer
narrates work through it: `deep-change` is the only path that drives it
explicitly. The other topologies (`quick-fix`, `standard-change`, `bug-fix`,
`feature-change`, `solution-analysis`) remain in the runtime for projects that
opt into them, but nothing in the preset routes to them.

## Repository knowledge

Nothing is shipped for `.claude/instructions/` except its contract. How a
repository does an area can only be derived from that repository; a packaged
stub would be a stale instruction on the first day. `/map-repo <area>` writes a
file with `appliesTo` globs and an `evidence` list, and
`cw instructions status` re-checks that every evidence file still exists and has
not changed since the file was written.

Areas are open — `database` and `api` in one repository, `billing` and
`reporting` in another.

## What this preset promises

For the same task, it should beat a plain senior-developer prompt on at least
one of: repository understanding, impact detection, specialized reasoning,
regression prevention, or verification evidence — without making ordinary work
slower. A simple change should run at close to native speed, because on a simple
change nothing above the global rules is loaded at all.
