---
name: wf-checkpoint
description: Open and resolve a human checkpoint, and record a material technical decision with its evidence, alternatives and risk. Use when the mission reaches a decision only the user may make, when a mandatory checkpoint applies, or when risk escalates to HIGH or CRITICAL.
user-invocable: false
effort: low
---

A checkpoint is a state the mission stops in, not a paragraph in a report. While a
blocking checkpoint is pending, the installed hook denies repository writes and
arbitrary commands; read-only investigation and `cw` keep working.

## When a checkpoint is mandatory

`cw mission route`/`cw mission classify` prints the mandatory list. Beyond that,
open one when:

- the plan is large, multi-module, or changes database, API contract, permission
  or security (`PLAN`);
- investigation found behavior that contradicts the requirement, a new
  dependency, or more than one viable direction (`INVESTIGATION`);
- a defect of MEDIUM risk or higher has its root cause (`ROOT_CAUSE`);
- a structural change appears — new service, cache, queue, persistence or
  authorization model, changed communication pattern (`ARCHITECTURE`);
- several solutions are plausible, or an API/database/contract shape must be
  chosen (`DESIGN`);
- data loss, permission, security, migration, compatibility or production impact
  is on the table (`HIGH_RISK`);
- the user asked to review code before it is applied, or the change is a large
  feature, refactor, permission or security change (`CODE`);
- release needs a migration, deployment step, cache invalidation, production
  configuration or a rollback plan (`RELEASE`).

Risk escalation has its own rule: LOW -> MEDIUM is a warning on the board,
MEDIUM -> HIGH opens a checkpoint, HIGH -> CRITICAL stops implementation until it
is mitigated or the user explicitly accepts it.

## Open it

```text
cw checkpoint open <PLAN|INVESTIGATION|ROOT_CAUSE|ARCHITECTURE|DESIGN|HIGH_RISK|CODE|RELEASE> \
  --summary "<what was found, one or two lines>" \
  --decision "<exactly what the user must decide>" \
  --recommend "<your recommendation>" \
  --alternatives "<option A;option B>" \
  --evidence "<file:symbol;file:symbol>" \
  --risk <low|medium|high|critical> --impact "<what changes>" --confidence <0-100>
```

Then ask the user the same question in the response, in one screen: summary,
decision required, recommendation, alternatives, evidence, risk, impact,
confidence. Notify with `PushNotification` when the run will sit and wait.

Do not open two checkpoints of the same kind, and do not open one to look
thorough: a checkpoint that has no real decision behind it trains the user to
approve without reading.

## Resolve it

Only the user's answer closes a checkpoint — from the chat or from the Mission
Board:

```text
cw checkpoint resolve <id> --action approve|reject|modify|cancel --note "<their answer>"
```

`reject` and `modify` require the note. After `approve` the mission continues;
after `reject`/`modify` it returns to the phase that produced the decision. Never
resolve a checkpoint on your own behalf, and never treat silence as approval.

## Record the decision

Every material technical decision goes on the record with its reason and its
rejected alternatives:

```text
cw mission decision --decision "<what was decided>" --reason "<why>" \
  --evidence "<what proves it>" --alternatives "<what else was possible>" \
  --rejected "<why each was rejected>" --impact "<what it changes>" \
  --risk <level> --reversibility "<how it is undone>" --confidence <0-100> [--approval]
```

"I think we should reuse the existing middleware" is not a decision record. The
reason, the evidence, the rejected alternatives and the reversibility are.

For a deliverable version, reuse `<runtimeDir>/templates/decision-record.md`
(normally `.ai-workflow/templates/decision-record.md`).

## When the user chooses to proceed anyway

A blocker the user knowingly accepts is recorded, never erased:

```text
cw mission accept-risk --reason "<why proceeding is acceptable>"
```

State in the final report what was accepted, what evidence is still missing, and
the consequence if the assumption is wrong.
