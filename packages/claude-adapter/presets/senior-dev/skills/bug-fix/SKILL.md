---
name: bug-fix
description: Fix a defect using risk-adaptive L0-L3 routing. Bounded defects use the fast or medium path; only high-risk defects use the full root-cause and business-gated bug workflow.
disable-model-invocation: true
argument-hint: "[bug + reproduction + expected/actual]"
effort: medium
---

Classify `$ARGUMENTS` before execution using the L0-L3 definitions in the
installed engineering rules.

- L0-L1 -> invoke `wf-quick-fix`.
- L2 -> invoke `wf-standard-change`.
- L3 -> invoke `wf-bug-fix`.

Every non-trivial bug still needs a causal explanation, but a bounded root cause
does not require a full gated run or a root-cause document. Use the full body
only for concrete high-risk factors. The command name does not override risk
classification.

Pass the original arguments and the classification to the selected body. Do not
start a run here and do not invoke more than one body.
