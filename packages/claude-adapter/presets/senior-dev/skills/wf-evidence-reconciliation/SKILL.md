---
name: wf-evidence-reconciliation
description: Internal workflow step for reconciling user intent, requirement/design documents, DB, current code, and tests without treating any source as absolute truth.
user-invocable: false
effort: high
---

Analyze all available sources.

Output internally and persist to `.ai-workflow/runs/<runId>/evidence.md` when a
run directory exists, then record it with `cw artifact evidence.md`:

1. Desired business outcome stated by user.
2. Current system behavior with code/data evidence.
3. Documented behavior grouped by source.
4. Contradictions with stable IDs `C-001`, `C-002`, ...
5. Classification:
   - FACT
   - INFERENCE
   - ASSUMPTION
   - PROPOSAL
6. Resolution options only for material conflicts.
7. Recommended resolution with reasoning and compatibility impact.
8. Open business decisions.

Do not implement.
Do not assume document > code or code > document.
Do not raise every mismatch: raise only contradictions that materially affect
behavior, data, permissions, compatibility, or implementation direction.

For deep read-only reconciliation, delegate to the `business-analyst` agent.
Pass the stated outcome, `runDir` and the source entry points — not your own
summary of them. Expect its structured output back and fold it into
`evidence.md`.

Return the reconciliation to the calling workflow. Do not write a long report to
the user; only an open business decision is worth interrupting for.
