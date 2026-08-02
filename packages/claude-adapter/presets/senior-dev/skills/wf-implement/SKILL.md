---
name: wf-implement
description: Internal implementation step that codes only after business, root-cause (for bugs), plan, impact/risk/scope, test strategy, and conventions are ready.
user-invocable: false
effort: high
---

Before editing verify:
- Business status is `BUSINESS_READY` (`cw status` shows `BUSINESS_READY=PASSED`).
- For bugs, root cause is established (`ROOT_CAUSE_READY=PASSED`).
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
