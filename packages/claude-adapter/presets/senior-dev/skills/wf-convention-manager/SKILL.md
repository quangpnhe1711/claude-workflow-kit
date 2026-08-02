---
name: wf-convention-manager
description: Internal step for loading cached code/comment/test/database conventions and refreshing only missing, stale, or locally contradicted sections.
user-invocable: false
effort: medium
---

Convention directory:
`.ai-workflow/conventions/`

Expected:
- `code.md`
- `comments.md`
- `testing.md`
- `database.md`
- `metadata.json`

Algorithm:

1. Determine which convention areas are relevant to current scope.
2. Load existing relevant artifacts.
3. Reuse them by default.
4. Do NOT rescan the whole codebase on every task.
5. Refresh only when:
   - artifact/section is missing;
   - evidence is stale due to material framework/architecture/module change;
   - nearby code repeatedly contradicts cached guidance;
   - current task enters a previously unseen module;
   - user requests refresh.
6. For refresh, inspect representative existing code and update only the
   affected convention area.
7. Local intentional convention near modified files has precedence over generic
   cache. Record meaningful divergence rather than rewriting the entire cache.

Comments follow exactly the same cache policy as code.
Never generate comments just to increase documentation.
Follow observed comment language/style and prefer WHY/business
rationale/compatibility/non-obvious constraints over obvious WHAT.

If bootstrap is required, follow the same evidence rules as `refresh-conventions`.
