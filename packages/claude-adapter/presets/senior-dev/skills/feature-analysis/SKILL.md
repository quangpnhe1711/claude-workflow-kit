---
name: feature-analysis
description: Model the behavior of a feature that introduces or changes business state - the invariants that must hold, the legal state transitions, what commits together, what happens on partial failure, retry and concurrency, and which acceptance criterion each check proves. Not for CRUD that merely crosses controller/service/repository, and not for a change with no new state or rule.
effort: high
---

## Why this skill exists

Vanilla Claude writes a working feature. What it routinely leaves out is the part
that fails in production three weeks later:

- it implements the **happy path transition** and never enumerates which
  transitions are illegal, so the entity reaches a state nothing handles;
- it puts five effects in one method and never asks **what commits together** —
  the row is written, the email is sent, and the third step throws, leaving state
  no code can reach;
- it never asks whether the operation is **idempotent**, so a double-click, a
  webhook redelivery, or a job re-run creates two records;
- it assumes one actor: two users acting on the same entity produce a lost
  update, because the read-modify-write has no guard;
- it enforces authorization at the endpoint but not on the **data scope**, so the
  query returns another tenant's rows to a correctly-authenticated caller;
- it treats a business rule as a validation, missing that it is an **invariant**
  that must also hold for existing rows and for every other path that writes them;
- it writes tests for what it built rather than for what was **asked**, and
  nobody can say which acceptance criterion is unproven.

This skill adds: invariant identification, an explicit transition model, a
commit-boundary and partial-failure analysis, idempotency and concurrency
decisions, and a requirement→boundary→evidence map.

## When this does not apply

Do **not** load this because a change crosses layers, touches several files, or
is called a "feature". A field added to an existing CRUD endpoint following the
established pattern needs the repository's conventions and a targeted test, not a
behavior model.

Load it when at least one is true:

- the feature introduces a new **state** an entity can be in, or a new transition
  between existing ones;
- it introduces or changes a **business invariant** (something that must be true
  of the data at all times, not just at the moment of input);
- it writes in more than one place, or writes **and** calls something external;
- it can be triggered twice — retry, redelivery, concurrent actors;
- it changes who may see or do something.

If none holds, this skill has nothing to add. Say so and continue natively.

## 1. Anchor on the closest existing implementation

Before modelling anything, find the feature this repository already built that is
most like the requested one, and read it end to end. It answers layering,
transaction style, error handling, authorization placement, and testing in one
pass, and it is what review will compare against.

If nothing comparable exists, that is the most important finding: the feature
introduces a pattern, which raises both its cost and its review bar.

## 2. Invariants before mechanics

State what must be true of the data **at all times**, independent of any code
path:

```text
INV-1  an order's total equals the sum of its line items, minus applied discounts
INV-2  at most one active subscription per customer
INV-3  a cancelled order has no pending fulfilment
```

For each, answer three questions:

- **Where is it enforced?** Application code, a database constraint, or nowhere
  (i.e. it is a hope). Prefer the database for anything that must survive a bug.
- **Which other paths write this data?** An invariant enforced on one path and
  not on the import job is not enforced.
- **Do existing rows satisfy it?** A new invariant over old data is a migration
  question (`schema-migration`), not a validation question.

An invariant is not a field validation. "Amount must be positive" is validation;
"the sum of allocations never exceeds the invoice total" is an invariant, and it
is the kind that breaks under concurrency.

## 3. Model the transitions explicitly

For anything stateful, write the model. Three states or more, or any state
reachable from two places, earns a table:

```text
STATE       EVENT           GUARD                         EFFECTS              -> STATE
DRAFT       submit          all lines priced              reserve stock        SUBMITTED
SUBMITTED   approve         actor has approver role       write audit row      APPROVED
SUBMITTED   cancel          -                             release stock        CANCELLED
APPROVED    cancel          not yet fulfilled             release stock,
                                                          refund               CANCELLED
APPROVED    fulfil          stock still reserved          emit shipped event   FULFILLED
```

Then answer the questions the table makes askable:

- **Illegal transitions**: what happens on `cancel` from `FULFILLED`? Rejected
  with which error, or silently ignored? Every cell you did not write is a
  behavior someone will hit.
- **Terminal states**: which states are final, and is anything still allowed
  there?
- **Who owns the state**: which component may change it. State mutated from three
  places has no owner and no invariant.
- **Is the state derivable** from other data instead of stored? A stored status
  that can disagree with the rows it summarises is a future defect.
- **Existing rows**: which states do they occupy, and are any of them
  unreachable-but-present?

## 4. Commit boundaries and partial failure

List the effects of the operation, in order, and draw the transaction boundary:

```text
1. write order row              ]
2. decrement stock              ]  inside the transaction
3. write audit row              ]
--------------------------------
4. publish order.submitted      outside — can fail independently
5. send confirmation email      outside — can fail independently
```

For each effect outside the boundary, answer: what if it fails? Retried by whom,
how often, and is the retry safe? Is the system correct while it has not
happened? A user-visible "your order is confirmed" that depends on step 5 is a
lie the code tells.

Watch for the classic errors: reading outside the transaction that a later write
depends on; a side effect fired before commit (the event references a row that
gets rolled back); a rollback that does not undo a non-transactional effect; a
transaction held open across an external call.

## 5. Idempotency, retry, concurrency

Only when the operation can happen twice, or two actors can act on one entity —
but check, because that is more often than it looks: double-click, client retry
on timeout (the request may have succeeded), webhook redelivery, at-least-once
queues, job re-runs, browser back-and-resubmit.

- **Idempotency key**: what makes a repeat a no-op — a client-supplied request
  id, a natural unique key, a state guard (`WHERE status = 'DRAFT'`). Decide it,
  and enforce it with a **unique constraint** where possible; an
  application-level check has a race inside it.
- **Concurrency**: does the operation read-modify-write? Then choose optimistic
  locking (version column, compare-and-set) or a row lock, and say which. "It
  won't happen often" is a decision to lose data occasionally.
- **Ordering**: can two events arrive out of order? What does the later-arriving
  older event do?

## 6. Authorization and data scope

Two different questions, and the second is the one that gets missed:

- **May this actor perform this action?** Enforced where the repository already
  enforces it, with the negative case tested.
- **Which rows may this actor see or affect?** Tenant, ownership, hierarchy. A
  correct permission check on a query that is not scoped still leaks. Check the
  list endpoint, the search, the export, and the by-id fetch — by-id is the one
  usually forgotten.

## 7. The consistency window, and what must be auditable

- Anything **eventually consistent** — a projection, a cache, a read replica, an
  async handler — has a window in which a user sees the old value after acting.
  State what they see and for how long. "Briefly wrong" is a requirement
  question, not an implementation detail, and it is the one users report as a bug.
- If the requirement implies an **audit trail** — who did it, when, to what, and
  what the previous value was — that is an acceptance criterion with a
  verification, not a log line. Decide whether a failed attempt is also recorded.

## 8. Requirement → boundary → evidence

The output that makes this skill worth loading. One row per criterion, including
the ones the requirement implies rather than states:

```text
AC1  retry must not create duplicate orders
     boundary:     OrderService.submit — unique index on (customer_id, request_id)
     verification: integration test, same request_id twice -> one row, second returns the first

AC2  only the owner may cancel
     boundary:     OrderPolicy.canCancel + controller guard + tenant-scoped query
     verification: unit test owner/non-owner; query test for cross-tenant id

AC3  cancelling an approved order releases stock
     boundary:     transition APPROVED -> CANCELLED, inside the transaction
     verification: integration test asserting stock level after cancel
```

A criterion with no verification is not done. A verification with no criterion is
a test nobody asked for. Carry this list to the end of the task and report each
as `VERIFIED` or `NOT VERIFIED` with the reason.

## Conclusions this skill must not reach

```text
the happy path works              != the transitions are defined
validated on input                != the invariant holds (other writers exist)
tests pass                        != the acceptance criteria are proven
one actor tested                  != concurrency handled
"retry is unlikely"               != idempotent
authorized                        != scoped (the check and the query are separate)
committed                         != the external effect happened
status column exists              != the state is owned
```

## Stop when

The invariants are named and their enforcement point is known, every legal and
illegal transition has a defined behavior, the commit boundary and each
out-of-boundary failure are decided, idempotency and concurrency are decided or
explicitly ruled out with a reason, and every acceptance criterion maps to a
boundary and a check.

Sections that do not apply are marked `Not relevant` — that is a finding, not an
omission. Do not model states the feature does not have.

## Output

This normally stays in the conversation: the closest existing pattern, the
invariants, the transition table, the commit boundary, the decisions, the
AC map — then implementation.

Write a document only when the user asked for analysis without code, or the
result must survive the session; then follow
`.claude/prompts/analysis-report.prompt.md` and stop before implementing.
