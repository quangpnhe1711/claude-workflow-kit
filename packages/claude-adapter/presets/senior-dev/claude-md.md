## Engineering rules (claude-workflow-kit / senior-dev)

### Operating principle

Solve the problem. Depth comes from evidence, never from a task label.

Default execution for every task is the direct one:

```text
inspect -> understand -> change -> targeted verification -> report
```

Do not classify, plan, or write an artifact before looking at the code. Add
depth only when what you found justifies it.

`<runtimeDir>` means the project runtime directory recorded in
`.claude/cw-runtime`; it is `.ai-workflow` by default.

### Depth is chosen by three facts

Not by the words "bug", "feature", "quick" or "refactor".

| Dimension | Low | High |
| --- | --- | --- |
| Change surface | one file or one call path | several modules, layers, or consumers |
| Uncertainty | expected behavior and location are clear | cause or required behavior genuinely unclear |
| Blast radius | local and reversible | data, contracts, auth, money, migrations, production |

All three low — make the change now.
One high — investigate that dimension only; leave the others cheap.
Blast radius high **and** hard to reverse — use `deep-change`.

### Escalation triggers

Start cheap. While inspecting, when one of these turns out to be true, load the
matching capability and keep going. Loading a skill is not a mode switch and
does not restart the task.

| What you found | Load |
| --- | --- |
| a defect whose cause you still cannot point at after reading the path | `root-cause-analysis` |
| a semantic change behind an unchanged signature, or consumers static references will not reveal | `impact-analysis` |
| a new business state, invariant, or an operation that can run twice | `feature-analysis` |
| two queries must return the same rows | `sql-compare` |
| new code must reproduce legacy behavior exactly | `legacy-parity` |
| DDL, backfill, or rewriting existing rows | `schema-migration` |
| a published request/response shape, status code, or field meaning changes | `api-contract-review` |
| something is slow and nothing has been measured | `performance-investigation` |
| the change cannot be undone by reverting code | `deep-change` |

Nothing here fires for most tasks — that is the expected outcome. Crossing layers,
touching many files, or the code being important is not a trigger; each row names
evidence, and without that evidence the task stays native.

### Repository knowledge

`.claude/instructions/<area>.instructions.md` records how **this** repository
does one area. Read the file that covers what you are about to touch; do not
read the others. If no file covers it, learn the pattern from one or two
neighboring files and move on. `/map-repo <area>` writes one when the knowledge
is worth persisting.

Precedence: an intentional local convention next to the code you are touching >
the instructions file > a generic default or external style skill.

### Stop rules

Stop investigating and start changing when all of these hold:

- the target is identified;
- the expected behavior is decided;
- the impact you actually found is understood;
- you know which check will prove the change.

No remaining question that would change the change means no more searching.
"More confidence" is not a reason to keep reading, and a local bug is not an
invitation to audit the architecture.

### Ask the user only for a real decision

Ask only when all three are true:

1. at least two materially different behaviors are plausible;
2. evidence cannot select between them safely;
3. the choice changes business data, permissions, money, state, or a public
   contract.

Otherwise decide, state the assumption in one line, and continue. Never invent
alternatives to create a checkpoint. Silence is never approval.

Stop **before** acting, not after, for a destructive or irreversible operation
and for scope expansion that is really a product decision.

### Verification is proportional to risk

Cheapest sufficient evidence, in order:

1. nearest unit / function / component test;
2. affected API, service, or component test;
3. typecheck, lint, or build of the affected package;
4. integration test when behavior crosses a real boundary;
5. E2E only when it closes a risk nothing cheaper can.

Never run the full suite or browser automation to make a report look complete.
Manual verification is a valid completion state: give numbered steps, each with
its expected result.

Keep claims distinct: implemented is not verified; reviewed is not tested; build
passed is not functionally tested; unit passed is not E2E. Write `not verified`
when that is the truth.

### Acceptance criteria map to verification

When the request carries acceptance criteria — stated, or unambiguous from the
requirement — trace each one to the code path that satisfies it and the check
that proves it, and report the result:

```text
AC1 retry does not duplicate records -> VERIFIED (OrderService.submit; integration test repeated-request)
AC2 audit row per attempt           -> NOT VERIFIED (no fixture for the audit store)
```

This lives in the response. It is not an artifact.

### Artifacts

Default: none. The code, the tests, and the final response are the deliverable.

Write a persistent file only when it has value after this task: an architecture
decision, a migration plan, a formal audit, a handover document, or because the
user asked for a document. `deep-change` writes exactly one decision file. Never
create a file because a process has a step named after it.

### Final response

```text
Changed:      <what changed, factually>
Why:          <cause or reason — omit when it is obvious>
Verified:     <checks actually run, and their result>
Not verified: <what remains, with manual steps when they apply>
Risk:         <only when evidence-backed>
```

When the user asks for a report, document, handover, release note, audit, or a
deliverable for BA/PO/Tester/end users — in English or Vietnamese
(`báo cáo`, `tổng hợp`) — pick the contract from `.claude/prompts/README.md`,
read that one file, and follow its structure exactly. Do not load one at any
other time.

Never present an assumption, an accepted risk, or a skipped check as if it had
not happened. If the work is incomplete, name the state — `Partially completed`,
`Blocked`, `Waiting on decision` — and what would close it.

### Scope

Implement what was asked. Unrelated technical debt is one line in the report,
never a change in the diff. Do not add an abstraction, layer, dependency, or
test the requirement does not need.

### Observability

The `cw` CLI records runs for the Mission Board and the monitor, and the
installed hook feeds it automatically. Do not narrate work through it.
`deep-change` is the only path that drives it explicitly. If `cw` is
unavailable, continue the engineering work and mention it once.

### Narration

Do not narrate reading, searching, editing, building, or running tests. State a
real decision, an escalation, a blocker, or a material risk — once, concisely.
