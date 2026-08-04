---
name: feature-change
description: Execute a requested feature or behavior change using risk-adaptive L0-L3 routing. Small explicit changes use the fast path, bounded multi-layer changes use the medium path, and only high-risk changes use the full controlled feature workflow.
disable-model-invocation: true
argument-hint: "[desired outcome + relevant inputs]"
effort: medium
---

Classify `$ARGUMENTS` before execution using the L0-L3 definitions in the
installed engineering rules.

If the arguments explicitly reference an approved analysis run, or the current
feature run has `sourceAnalysisRunId`, invoke `wf-feature-from-analysis` instead
of reclassifying or repeating discovery.

- L0-L1 -> invoke `wf-quick-fix`.
- L2 -> invoke `wf-standard-change`.
- L3 -> invoke `wf-feature-change`.

Choosing `/feature-change` identifies the request as a change, not as automatic
consent to every full-workflow phase. Reserve the hard-gated body for concrete
high-risk factors. A command name does not override risk classification.

Pass the original arguments and the classification to the selected body. Do not
start a run here and do not invoke more than one body.
