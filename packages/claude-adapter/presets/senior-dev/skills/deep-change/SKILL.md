---
name: deep-change
description: Safety path for a change that cannot be undone by reverting code - irreversible data change, destructive operation, breaking an external contract, a security-sensitive change, a costly production action, or a genuine unresolved business decision. Holds every edit until the decision is recorded, then verifies and gets an adversarial review. Not for ordinary large features.
argument-hint: "[the change, and what about it is irreversible]"
effort: high
---

This is a **safety capability, not a reasoning methodology.** The thinking is done
by whichever analysis skill fits — `root-cause-analysis`, `impact-analysis`,
`schema-migration`, `api-contract-review`, `legacy-parity`. What this adds is:
edits are refused until the irreversible decision is written down, the user is
asked only when the decision is genuinely theirs, and the result is reviewed by
someone who reads the diff instead of your account of it.

## Why this skill exists

Vanilla Claude, told to do something irreversible, will do it — competently, and
before anyone with the authority to accept the consequence has seen the plan.
The gap is not analysis; it is that nothing stands between "I understand the
change" and "the data is gone". This closes that gap with a hook-enforced gate,
and it is the only thing in the preset that does.

## Trigger — narrow on purpose

Use it when at least one is true:

```text
irreversible data change        backfill, correction, deletion, destructive migration step
destructive operation           dropping data or objects, purging, force-push, bulk mutation
breaking an external contract   consumers you do not control, or cannot all update first
security-sensitive change       authentication, authorization, secrets, data exposure
high-cost production action     anything that spends money, pages someone, or cannot be retried
genuine unresolved decision     two materially different behaviors, and the choice is the user's
```

Do **not** use it for:

```text
a large feature                 size is not risk
a wide refactor or rename       reversible by revert, however many files
a bug fix in sensitive code     the code being important is not the change being irreversible
"to be careful"                 the gate is not a mood
```

Wide is not risky. A rename across forty files reverts with one command; a
one-line `UPDATE` without a `WHERE` does not.

If the trigger is not met, do the work normally. Overusing the gate is how a gate
becomes a formality.

## 1. Open the run

```text
cw run start deep-change --label "<short label>"
```

While `DECISION_READY` is unpassed the installed hook **denies every file edit
and every non-read-only command**. That is the mechanism, not a malfunction:
investigate and write the decision, then pass the gate. If `cw` is unavailable,
hold to the same discipline manually and say so once.

## 2. Investigate what makes it irreversible

`cw phase enter investigate`

Load the analysis skill that fits and establish only what the decision needs:

- exactly which step cannot be undone, and what recovery costs — in data lost,
  time, and money;
- who depends on the current behavior, including outside this repository;
- which part of the choice is a product decision rather than an engineering one;
- the deploy or migration order, when the change is not atomic;
- what will prove it is right **before** anyone depends on it.

Stop when the decision can be made, not when everything is known.
`cw phase complete`

## 3. Record the decision, then gate on it

`cw phase enter decide`

Write `<runtimeDir>/runs/<runId>/decision.md`:

```markdown
# Decision
## What is changing, and why
## What is irreversible          <!-- the exact step, the recovery path, its cost -->
## Impact                        <!-- consumers, data, permissions, contracts -->
## Options considered            <!-- only real ones; say so if there was one -->
## Chosen approach and rationale
## Deploy / migration order      <!-- when not atomic, and where the point of no return sits -->
## Verification plan             <!-- what proves it before anyone depends on it -->
## Open question for the user    <!-- or: none — decided from evidence -->
```

Then `cw artifact decision.md`.

**Settled by evidence** — the requirement decides it, or only one approach is
defensible — pass the gate and keep working. Do not manufacture a question to
create a checkpoint; a checkpoint with no real decision behind it teaches the
user to approve without reading:

```text
cw gate pass DECISION_READY
```

**A genuine product or risk choice remains** — put it to the user and wait:

```text
cw gate wait DECISION_READY --message "<the open decision>"
```

Ask in one screen: what you found, what must be decided, what you recommend and
why, the alternatives, and what is at risk either way. Then stop, and call
`PushNotification` with the run id and the decision required. Only the user's
answer closes it; silence is never approval, and there is no route around the
gate that is not a lie about the state.

When the answer arrives, continue the **same** run: `cw phase enter decide`,
record the answer in `decision.md`, `cw gate pass DECISION_READY`.

## 4. Implement

`cw phase enter implement`

The smallest change that carries out the recorded decision, inside what was
approved. A finding that widens the scope goes back to step 3, not into the diff.

For a migration, implement the steps in the recorded order and **stop at the
boundary the decision named** — the destructive step is usually a later release.
`cw phase complete`

## 5. Verify

`cw phase enter verify`

Evidence aimed at the failure mode this change creates, not at coverage in
general: the migration invariant queries, the old-shape contract test, the
permission negative case, the parity corpus. Record what ran, what passed, and
what remains unverified. `cw phase complete`

## 6. Adversarial review

`cw phase enter review`

Delegate to the `adversarial-reviewer` agent. Run `cw review-context` and pass its
output verbatim plus how to obtain the diff — **pointers only**. Never pass your
own summary: a reviewer reading the implementer's account is reviewing the
account.

Persist the verdict to `review.md`, then `cw artifact review.md`. Fix confirmed
defects, re-run the affected checks, review again. Three loops maximum; after
that report what is unresolved instead of looping. `cw phase complete`

## 7. Finish

```text
cw run complete
```

Report as usual — Changed / Why / Verified / Not verified / Risk — plus the
decision, who made it, and the recovery path if it turns out to be wrong. If the
user accepted a risk to proceed, say so; never present an accepted risk as if it
had been resolved.
