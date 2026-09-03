# Repository instructions

One file per area, holding **how this repository does that area** — not how the
area works in general. A file that would still be true in another repository
does not belong here.

```text
.claude/instructions/
├── README.md                        this contract
├── metadata.json                    freshness record, checked by `cw instructions status`
├── architecture.instructions.md
├── database.instructions.md
├── api.instructions.md
├── testing.instructions.md
├── frontend.instructions.md
├── logging.instructions.md
├── security.instructions.md
└── legacy.instructions.md
```

Nothing here ships with the kit. `/map-repo <area>` derives each file from
repeated evidence in this codebase. Areas are open — add `queues`, `billing`,
`reporting` or whatever this system actually has.

## When they are read

Only the file covering the area being touched, and only before editing it. A
frontend task never opens `database.instructions.md`. If no file covers the
area, learn from one or two neighboring files instead; that is cheaper than a
wrong instruction.

## Format

```markdown
---
area: database
appliesTo:
  - "src/repositories/**"
  - "migrations/**"
updated: 2026-08-31
evidence:
  - src/repositories/OrderRepository.ts
  - migrations/2026_03_add_order_status.sql
---

## Where things live
...

## Conventions
...

## Gotchas
...
```

`appliesTo` is what makes the layer scoped: it says which paths the file governs.
`evidence` is what makes it verifiable — the concrete files the guidance was
derived from. `cw instructions status` re-checks that every evidence file still
exists and has not changed since `updated`, and reports the area `STALE` when it
has. Vague or missing evidence makes the file unverifiable, so list the files
actually read.

## What belongs in a file

- where a kind of thing lives, by real path;
- the naming, layering, and wiring pattern this repo repeats;
- required conventions, and the ones that are merely dominant;
- gotchas that cost someone an hour: transaction boundaries, generated code that
  must not be hand-edited, a test DB that needs a fixture, a legacy path still
  in production.

Mark each rule `REQUIRED`, `DOMINANT`, `LOCAL`, or `UNCERTAIN`. One accidental
occurrence is not a convention.

## What does not

Framework tutorials, language documentation, generic best practice, anything
already stated in `CLAUDE.md`, and anything a reader could get by opening the
file next to the one they are editing.

## Precedence

An intentional local convention next to the code being touched wins over this
directory, which wins over a generic default or an external style skill.
