# Test report

For: verification evidence, for QA or a release decision.

```markdown
# Test report — <what was tested>

## Scope
What was covered, and explicitly what was not.

## Results
| # | Case | Type | Expected | Actual | Result |
Type is unit / integration / API / manual / E2E. Result is `PASS`, `FAIL`, or
`NOT VERIFIED`. Include the command or steps for each.

## Failures
Each failure: what failed, whether it is caused by this change or pre-existing,
and what it blocks.

## Not verified
What was not covered and why — no fixture, needs production data, manual only.
Manual steps belong here, numbered, each with its expected result.

## Verdict
`PASS`, `PASS WITH MANUAL VERIFICATION`, or `FAIL`.
```

Report only what actually ran. Never add a test run to make coverage look better.
