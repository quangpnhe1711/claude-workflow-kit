---
name: solution-analysis
description: Analyze a free-form feature or business requirement against the current source code, measure direct and downstream impact, compare solution options, recommend the best codebase-aligned approach, and produce an approved artifact handoff without implementing. Use for requests such as business analysis, impact assessment, solution selection, technical planning, or "chưa cần code".
disable-model-invocation: true
argument-hint: "[free-form requirement, documents, constraints, or analysis approval]"
effort: high
---

Treat `$ARGUMENTS` as free-form input; never require a rigid form.

Check `cw status --json` first:

- No active solution analysis: invoke `wf-solution-analysis` with the original
  input unchanged.
- Active `solution-analysis` at `ANALYSIS_READY`: if the user explicitly
  approves the recommended solution and scope, persist the approval with
  `cw analysis approve --solution "<chosen solution>" --scope "<approved scope>"`.
  Then run `cw analysis handoff --label "<short feature label>"` and invoke
  `wf-feature-from-analysis`. If the user edits the decision, update the affected
  artifacts first and present the revised analysis for approval again.
- Active linked `feature-change`: invoke `wf-feature-from-analysis`; do not start
  another run.

Never interpret silence, "looks okay", or a request to keep analyzing as
approval. Never implement while the solution-analysis run is waiting.

