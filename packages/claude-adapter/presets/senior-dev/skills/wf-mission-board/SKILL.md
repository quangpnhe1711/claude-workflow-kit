---
name: wf-mission-board
description: Keep the Mission Board honest - mission state, current action, confidence, evidence status, risks, task breakdown, off-track and context monitors - and read it back when resuming. Use while executing any classified mission, and when the user asks where the work stands.
user-invocable: false
effort: low
---

The Mission Board is the mission's source of truth. Chat carries the decision;
the board carries the state. Read it with:

```text
cw board            # organised state, checkpoints, blockers, actions
cw board --json     # same, machine readable
cw status           # run + phase + mission summary in a few lines
```

`cw board` is safe to run behind any gate or checkpoint.

## What to emit, and when

Emit only on real change. Do not narrate reading, searching, editing or building.

| Moment | Command |
| --- | --- |
| classification decided | `cw mission classify --type … --complexity … [--flags …]` |
| plan ready | `cw mission plan --objective "…" --scope "a,b" --out-of-scope "…"` |
| task breakdown | `cw mission task add --epic "…" --title "…" [--weight n]` |
| task finished | `cw mission task <id> DONE` |
| starting a distinct activity | `cw mission action "Reading PermissionMiddleware"` |
| an evidence area resolved | `cw mission evidence <category> SUFFICIENT` |
| an evidence area missing or contradictory | `cw mission evidence <category> MISSING\|CONFLICTING --note "…"` |
| understanding changed materially | `cw mission confidence <dimension> <0-100>` |
| a risk appeared or moved | `cw mission risk --category … --level … --trigger "…"` |
| a decision was made | `cw mission decision --decision "…" --reason "…"` (see `wf-checkpoint`) |
| requirement changed mid-run | `cw mission scope --previous "…" --new "…" --reason "…"` |
| a deliverable is decided or produced | `cw mission deliverable "<name>" [--not-required] [--status DONE]` |

Mission state follows the phase automatically. Set it by hand only when the
phase cannot express it (`cw mission state <STATE>`), and use `--force` only when
the mission genuinely jumped — a forced jump is recorded as forced.

## Confidence and evidence are gates, not decoration

Entering the implementation phase is refused while a threshold is unmet, a
required checkpoint is unanswered, evidence is `MISSING`/`CONFLICTING`/`OUTDATED`,
or a CRITICAL risk is open. Thresholds scale with depth: a Lightning mission owes
`requirement` and `scope`; a Deep permission mission also owes `businessRule` and
`architecture` at 80%, and a defect owes `rootCause` at 75%.

Give numbers you can defend from evidence. An unassessed dimension is honest and
blocks; an invented 90% is neither.

The way past a blocker is the user's decision, never a workaround:
`cw mission accept-risk --reason "<why>"`.

## Off-track monitor

Mark it the moment investigation leaves the mission:

```text
cw mission offtrack OFF_TRACK --expected "<mission scope>" --actual "<what is being read>" \
  --reason "<why it happened>" --recommendation "return to scope|add to scope"
cw mission offtrack ON_TRACK
```

Prefer returning to scope. Widen scope only with evidence that the new area is
actually affected, and record it as a scope change. Unrelated technical debt is an
observation in the report, not work in the diff.

## Context monitor

When the mission is long, the requirement moved several times, or an earlier
decision can no longer be explained, write the recovery summary and continue from
it:

```text
cw mission context --summary "<mission, confirmed requirements, scope, decisions, open questions>" \
  --coverage <0-100> --questions "<open question;open question>" [--degraded]
```

Never quietly drop an earlier decision. If a new finding contradicts one, say so
and record the correction.

## Resuming

On a follow-up prompt: read `cw board` first, continue the same run, and answer
from the recorded state — not from memory of what the plan probably was.
`WAITING_USER` or a pending checkpoint means the user's answer is the next input;
`SEMANTIC_LAG` means the board is behind the work and needs the phase emitted.
