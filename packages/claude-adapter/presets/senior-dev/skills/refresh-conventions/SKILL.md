---
name: refresh-conventions
description: Bootstrap or refresh persisted code, comment, testing, and database conventions for this repository. Run once initially or when conventions are stale.
disable-model-invocation: true
argument-hint: "[all|code|comments|testing|database|module-path]"
effort: medium
---

Refresh only the requested convention area in `$ARGUMENTS`; if no area is
supplied, inspect all convention areas once.

Write/update:
- `.ai-workflow/conventions/code.md`
- `.ai-workflow/conventions/comments.md`
- `.ai-workflow/conventions/testing.md`
- `.ai-workflow/conventions/database.md`
- `.ai-workflow/conventions/metadata.json`

Derive conventions from repeated codebase evidence, not personal preference.

For every convention:
- state the observed pattern;
- include representative file paths/examples;
- distinguish REQUIRED/DOMINANT/LOCAL/UNCERTAIN;
- do not invent a rule from a single accidental occurrence.

For comments specifically discover:
- language;
- placement;
- docblock usage;
- when comments are expected;
- whether TODO/FIXME is used;
- whether comments explain business rationale/compatibility/non-obvious behavior;
- patterns that should not be copied.

`metadata.json` records, per area: `status`, `last_refresh`, and the concrete
`evidence` files inspected, plus a `repo_shape` summary of the stacks and
services detected. Keep it factual; it is the cache-invalidation record for
future tasks.

Do not modify product code.
