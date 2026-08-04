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
- `<runtimeDir>/conventions/code.md`
- `<runtimeDir>/conventions/comments.md`
- `<runtimeDir>/conventions/testing.md`
- `<runtimeDir>/conventions/database.md`
- `<runtimeDir>/conventions/metadata.json`

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

`metadata.json` records, per area: `status`, `last_refresh` (ISO 8601), and the
concrete `evidence` files inspected as **project-relative paths**, plus a
`repo_shape` summary of the stacks and services detected:

```json
{
  "code":     { "status": "OK", "last_refresh": "2026-08-03T09:12:00Z",
                "evidence": ["src/api/orders.py", "src/api/customers.py"] },
  "comments": { "status": "OK", "last_refresh": "...", "evidence": ["..."] },
  "testing":  { "...": "..." },
  "database": { "...": "..." },
  "repo_shape": { "stacks": ["..."], "services": ["..."] }
}
```

`cw conventions status` reads exactly these fields: it re-checks that every
evidence file still exists and has not been modified since `last_refresh`.
Recording vague or missing evidence paths makes the cache unverifiable, so list
the files you actually read.

Run `cw conventions status` when finished to confirm every refreshed area
reports `OK`.

Do not modify product code.
