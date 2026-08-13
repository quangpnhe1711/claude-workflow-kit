# Traceability Map

The source of truth linking the delivered design document to this repository.
`cw analysis ready` fingerprints every design document cited below: if one
changes later, the analysis is reported STALE and the affected rows must be
re-checked before implementation continues.

This file must contain exactly one markdown table — the one below. Put anything
else in prose or bullets, or the traceability parser will reject the stray rows.

## Design Documents

- `<path/to/design.md>` — received `<date>`, version `<x>`, `<what it covers>`

## Requirements

One row per verifiable design requirement. Ids are stable: never renumber an
approved row — supersede it and add a new one.

- **ID** — `SPEC-001`, ascending, unique within this run.
- **Requirement** — one testable statement, in the design document's own terms.
- **Design Ref** — `path/to/design.md#section`. The path must exist in the repo.
- **Code Paths** — comma-separated files or directories that implement it.
  A trailing `/` or `/**` covers everything beneath. Leave the cell empty only
  when nothing implements it yet; `cw spec check` reports the row as unclaimed.

| ID | Requirement | Design Ref | Code Paths |
| --- | --- | --- | --- |
| SPEC-001 |  |  |  |

## Not Traceable

Design statements deliberately excluded from the map, each with the
evidence-based reason (out of scope, superseded, non-functional prose, already
satisfied by existing behavior).

- `<design.md#section>` — `<reason>`
