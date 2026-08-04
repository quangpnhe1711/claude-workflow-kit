---
name: wf-convention-manager
description: Internal step for loading cached code/comment/test/database conventions and refreshing only missing, stale, or locally contradicted sections.
user-invocable: false
effort: medium
---

Convention directory:
`<runtimeDir>/conventions/`

Expected:
- `code.md`
- `comments.md`
- `testing.md`
- `database.md`
- `metadata.json`

Algorithm:

0. Run `cw conventions status`. It reports, per area: present/missing, whether
   the recorded evidence files still exist, and whether any of them changed
   since the last refresh. That is a filesystem fact — prefer it over judgement.
1. Determine which convention areas are relevant to current scope.
2. Load existing relevant artifacts.
3. Reuse every area the status report marks `OK`.
4. Do NOT rescan the whole codebase on every task.
5. Treat `STALE` or `UNRECORDED` as a review signal, not proof that every rule
   must be rediscovered. Refresh only the relevant area when the changed
   evidence can materially affect its guidance. Refresh a relevant `MISSING` or
   `INVALID` area when local files are insufficient, and otherwise only when:
   - artifact/section is missing;
   - evidence is stale due to material framework/architecture/module change;
   - nearby code repeatedly contradicts cached guidance;
   - current task enters a previously unseen module;
   - user requests refresh.
6. If one or two neighboring files establish the intentional local convention,
   use them instead of refreshing the project-wide cache.
7. For refresh, inspect representative existing code and update only the
   affected convention area.
8. Local intentional convention near modified files has precedence over generic
   cache. Record meaningful divergence rather than rewriting the entire cache.

Comments follow exactly the same cache policy as code.
Never generate comments just to increase documentation.
Follow observed comment language/style and prefer WHY/business
rationale/compatibility/non-obvious constraints over obvious WHAT.

Precedence, highest first:
1. a local intentional convention in the code being touched;
2. this cache;
3. a generic external comment/style skill or default.

An external generic skill never overrides a convention this repository
demonstrably follows.

If bootstrap is required, follow the same evidence rules as `refresh-conventions`.

Return the loaded conventions and any refresh performed to the calling workflow.
