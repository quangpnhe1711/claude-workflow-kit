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
- `WAITING_USER` — the run is parked on the user's answer. Inspect `gates` and
  `mutation`: an L3 gate-bound wait has a `WAITING` gate and denies repository
  mutation; an L2 advisory wait has no gate and does not. Continue the same run;
  do not start a new one.
- `POSSIBLY_STALLED` — no activity for longer than the configured threshold.
  Claude is not necessarily dead; re-check before acting.
- `SEMANTIC_LAG` — Claude is active but no phase transition has been emitted for
  a long time. The diagram is behind reality: emit the phase actually in
  progress.
- `mutation DENIED` — the listed gates are still open, so the hook refuses every
  repository write *and* every command that is not read-only. Resolve the gate;
  do not retry the edit and do not look for a shell that gets through. Writing
  the current phase's declared artifact into the run directory still works.
- `missing` — artifacts this phase declares that are not on disk yet.
- `unusable` — an artifact file exists but cannot serve as evidence (empty, or a
  directory with the right name). Rewrite it.
- `override` — a gate was opened with `cw gate override`, not earned. Say so in
  the final report.
- `policy DEGRADED` — the `PreToolUse` policy itself failed and is failing open,
  so gates are **not** being enforced right now. Report it; run
  `claude-workflow-kit doctor` for the reason.
- `next` lists the transitions the state machine will accept from here.
- exit code `2` with `CORRUPT` — the active run's `state.json` is unreadable.
  This is not "no active run": do **not** start a new run (it is refused anyway).
  Follow the printed recovery, or retire it without deserialising it:
  `cw run quarantine-current --reason "corrupt state"`, which preserves the files.

`cw policy` answers "is enforcement actually live?" on its own.

Report the result compactly. Do not dump raw JSON unless asked.
