---
name: wf-implement
description: Internal implementation step that codes only after business, root-cause (for bugs), plan, impact/risk/scope, test strategy, and conventions are ready.
user-invocable: false
effort: high
---

Before editing verify:
- Business status is `BUSINESS_READY` (`cw status` shows `BUSINESS_READY=PASSED`).
- For bugs, root cause is established (`ROOT_CAUSE_READY=PASSED`).
- `cw status` does not print a `mutation DENIED` line. If it does, the hook will
  refuse every edit; resolve the gate instead of retrying.
- Implementation plan exists.
- Impact/risk/scope exists.
- Test strategy exists.
- Relevant conventions are loaded.

If a required gate is not passed, stop. Do not edit product code.

Implement the smallest correct solution.

Rules:
- Implement resolved business behavior, not documents blindly.
- Address root cause for bug fixes.
- Follow existing local architecture and cached conventions.
- Follow cached/local comment conventions.
- Preserve backward compatibility unless explicitly changed.
- Avoid unrelated refactor.
- Do not implement optional improvements discovered while coding.
- Add/update tests that belong naturally with the implementation, guided by the
  pre-defined strategy.
- Keep changes reviewable.

After coding inspect the diff for accidental/out-of-scope changes before validation.

Return the change summary to the calling workflow. Do not write a user-facing
report here.

## Independent review handoff

When the workflow reaches the review phase, the reviewer is given *pointers*,
never your account of what you did. A reviewer that reads the implementer's
summary is reviewing the summary.

Run `cw review-context` and pass its output verbatim: it prints the canonical
pointers (run directory, resolved spec, plan, test strategy, validation, diff
command) so the handoff cannot drift into your own account of the work.

Pass exactly:
- the `cw review-context` output — `runDir` plus the resolved artifact paths the
  reviewer reads itself;
- `diff`: how to obtain the change — the base ref or commit range, e.g.
  `git diff <base>...HEAD`, or the list of changed paths if there is no base;
- `taskLabel`: the run label;
- nothing else. No summary of the change, no self-assessment, no "I verified X".

Expected back: a verdict object — `PASS` or `FAIL` plus findings, each with
Severity / Evidence / Problem / Impact / Recommended correction. Persist it to
`review.md`.
