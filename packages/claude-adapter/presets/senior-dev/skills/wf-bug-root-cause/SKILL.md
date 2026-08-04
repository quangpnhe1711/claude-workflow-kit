---
name: wf-bug-root-cause
description: Internal LEVEL 3 bug-analysis step that reproduces where feasible, traces the necessary current/legacy flow, and establishes a causal root cause before a high-risk fix.
user-invocable: false
effort: high
---

Do not edit product code.

1. Reproduce the bug when feasible.
2. Capture expected vs actual behavior.
3. Trace the relevant current/legacy path as far as required by the risk:
   UI/request -> controller/handler -> service/domain -> repository/integration -> DB/state -> response/UI.
4. Explain the old/current implementation:
   - what data it reads;
   - what decisions it makes;
   - what state it changes;
   - why those decisions lead to the observed symptom.
5. Separate:
   - SYMPTOM
   - CONTRIBUTING FACTORS
   - ROOT CAUSE
6. Identify the smallest safe root-cause fix direction.
7. Identify whether existing tests encode the buggy behavior.

Root cause must be causal, not merely "line X is wrong".

If reproduction fails:
- say NOT_REPRODUCED;
- continue static tracing if deterministic evidence is available;
- do not pretend runtime confirmation exists.

Persist to `<runtimeDir>/runs/<runId>/root-cause.md` and record it with
`cw artifact root-cause.md`. Write the file **before** touching the gate:
`cw gate pass ROOT_CAUSE_READY` is refused while `root-cause.md` is missing, and
while the gate is open the hook denies every file edit.

Gate outcome:
- causal root cause established -> `cw gate pass ROOT_CAUSE_READY`
- not establishable -> `cw gate wait ROOT_CAUSE_READY --message "<what is missing>"`

For deep read-only tracing, delegate to the `root-cause-analyst` agent: pass the
symptom, reproduction and `runDir`, and expect its structured output back.

Return the analysis to the calling workflow. Interrupt the user only when the
gate has to wait.
