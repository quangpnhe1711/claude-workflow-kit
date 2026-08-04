---
name: quick-fix
description: Execute the L0-L1 fast path for a trivial or small explicitly specified change. Make the smallest correct change and verify minimally or targetedly. Escalate to the L2 medium path or an L3 full workflow only on concrete evidence.
disable-model-invocation: true
argument-hint: "[the small fix, with its expected result]"
effort: low
---

Invoke `wf-quick-fix` for `$ARGUMENTS`.

The user chose the fast path deliberately. Start narrow. Do not prove the task
is small with a broad audit and do not convert it into a larger workflow unless
investigation finds a concrete L2 or L3 factor.

The body owns classification detail, execution, proportional verification,
escalation, and quick-versus-detailed reporting.
