---
name: wf-status
description: Show the current workflow run, its phase, gates, Claude runtime state and the legal next transitions. Use when resuming work or when unsure whether a run is still open.
disable-model-invocation: true
argument-hint: "[optional run id]"
---

Run:

```
cw status
```

For a specific run: `cw status --run <runId>`.
For every run in the project: `cw run list`.

Interpretation:
- `WAITING_USER` — a gate is open and the run is parked on the user's answer.
  Continue the same run; do not start a new one.
- `POSSIBLY_STALLED` — no activity for longer than the configured threshold.
  Claude is not necessarily dead; re-check before acting.
- `next` lists the transitions the state machine will accept from here.

Report the result compactly. Do not dump raw JSON unless asked.
