---
name: map-repo
description: Record high-density repository facts for one area as .claude/instructions/<area>.instructions.md - real paths, the repeated pattern, its exceptions, and the evidence - with adaptive sampling and a freshness record. Use to bootstrap an area, when `cw instructions status` reports it STALE, or when tasks keep rediscovering the same conventions.
argument-hint: "[area, or a path/module to map]"
effort: medium
---

## Why this skill exists

Vanilla Claude asked to "document the conventions" is likely to:

- write **prose about the framework** — how dependency injection works, why
  layering is good — which is true in every repository and useful in none;
- generalize from **one file** it happened to open, promoting an accident to a
  rule;
- describe only the dominant pattern and omit the **exception**, which is exactly
  the file the next task will touch;
- produce a document nobody can check: no paths, no evidence, no way to tell
  whether it is still true;
- keep reading — history, every module, the whole test suite — with no sampling
  rule that says when it has seen enough.

This skill adds: a fact format instead of prose, adaptive sampling with a stop
rule, an OBSERVED / INFERRED / UNKNOWN separation, exception capture, and a
verifiable freshness record.

## 1. Decide whether the file earns its place

Write one only when the answer to "how does this repo do X?" is (a) repeated
across the codebase, (b) not visible from a single file, and (c) costly to get
wrong. If the next task can learn it from the file next door, say so and stop.

Never write a file for an area with one implementation. One occurrence is a
sample, not a convention.

## 2. Sample adaptively — do not read the module

```text
read 2 representative implementations
  consistent?      -> stop; record it as OBSERVED with those two as evidence
  conflicting?     -> read 2 more, then decide:
                        a dominant pattern with a named exception, or
                        two coexisting patterns (record both, and which is newer)
  still unclear?   -> record UNKNOWN, do not guess
```

Read the oldest and newest examples **only** when the two samples conflict and
you need to know which way the convention is moving. Do not open git history by
default — it is expensive and usually answers a question nobody asked.

Choose representatives by weight, not by alphabet: the area's busiest module and
its most recently added one.

## 3. Write facts, not documentation

Each entry is: **path → pattern → exception → evidence.** No paragraphs.

```text
REST controllers
  path:      src/main/java/**/<feature>/*Controller.java
  pattern:   controller delegates directly to <Feature>Service; no logic in the
             controller; validation via @Valid on the request record
  exception: AuthController goes through AuthFacade (2 downstream services)
  evidence:  CandidateController.java, JobController.java
  status:    OBSERVED (4 of 5 controllers)

Transactions
  pattern:   @Transactional on the service method, never on the repository;
             external calls are made after the method returns
  exception: none found
  evidence:  CandidateService.java:88, JobService.java:120
  status:    OBSERVED

Integration test database
  pattern:   Testcontainers Postgres, schema applied by Flyway in AbstractIT
  gotcha:    a test that needs seed data must extend SeededIT, not AbstractIT —
             AbstractIT truncates between tests
  evidence:  AbstractIT.java, CandidateRepositoryIT.java
  status:    OBSERVED
```

Mark every entry:

```text
OBSERVED   seen in the evidence files listed
INFERRED   consistent with what was read but not directly demonstrated
UNKNOWN    looked, did not establish — say what would settle it
```

`UNKNOWN` is a useful entry. A wrong instruction costs more than a missing one.

## 4. What is worth recording

Per area, the non-obvious only:

- **architecture** — module boundaries, what may import what, the composition
  root, forbidden directions and why;
- **database** — where entities/repositories/migrations live, naming, who opens
  transactions and where they end, how integration tests get a schema, soft
  delete / auditing / optimistic locking if present;
- **api** — routing and handler shape, request/response serialization, where
  validation lives, the error envelope, status-code conventions, auth wiring,
  pagination shape, versioning;
- **testing** — runner and invocation, unit vs integration split, fixtures and
  factories, what is mocked and what never is, how to run a single test;
- **frontend** — state management, data fetching, component and styling
  conventions, forms and validation, routing, generated types;
- **logging** — logger, level policy, correlation ids, what must never be logged;
- **security** — where authorization is enforced, the permission model, secret
  handling, trust boundaries;
- **legacy** — which paths are legacy, what still calls them, what must keep
  working, what is safe to change.

Always record: **generated code that must not be hand-edited**, and the build and
test commands the area needs. Those two save the most time per line.

## 5. Write the file

`.claude/instructions/<area>.instructions.md`, per the contract in
`.claude/instructions/README.md`:

```markdown
---
area: <area>
appliesTo: ["<glob>", "<glob>"]
updated: <YYYY-MM-DD>
evidence: ["<path>", "<path>"]
---

## Where things live
## Conventions
## Gotchas
```

Rules: every claim points at a real path; mark each rule `REQUIRED` (enforced by
tooling or review), `DOMINANT` (the repeated pattern), `LOCAL` (true in one
module) or `UNCERTAIN`; record contradictions rather than averaging them ("v1
validates in the controller, v2 in a middleware — v2 is newer"). No framework
tutorials, no generic best practice, nothing already in `CLAUDE.md`.

Target one screen per area. A long instruction file will not be read, and an
unread instruction is a stale instruction.

## 6. Record freshness

`.claude/instructions/metadata.json`:

```json
{
  "database": {
    "status": "OK",
    "last_refresh": "2026-08-31T09:12:00Z",
    "evidence": ["src/repositories/OrderRepository.ts", "migrations/2026_03_add_status.sql"]
  },
  "repo_shape": { "stacks": ["typescript", "postgres"], "services": ["api", "worker"] }
}
```

`status` ∈ `OK` | `PARTIAL` | `STALE` | `UNKNOWN`. `evidence` holds
project-relative paths you actually read — `cw instructions status` re-checks
that each still exists and has not changed since `last_refresh`, so an invented
path makes the whole area unverifiable. Then run `cw instructions status` and
confirm the area reports `OK`.

## Conclusions this skill must not reach

```text
one file does it this way        != this is the convention
the framework recommends it      != this repository does it
the dominant pattern             != the whole picture (name the exception)
I read the module                != I sampled representatively
it was true when written         != it is true now (that is what evidence files are for)
```

## Stop when

Two representative examples agree, or the disagreement is recorded as a dominant
pattern plus its exception. Then write the file and stop.

Do not read every implementation, do not open history unless the samples
conflict, and do not map areas the current task does not touch.

Do not modify product code.

## Refreshing

Refresh one area only when it is `MISSING`, `INVALID`, materially `STALE`, the
task entered a module the file never covered, or local code repeatedly
contradicts it. A changed evidence timestamp means: re-read that file and correct
the affected rule. It is not a reason to rediscover the repository.
