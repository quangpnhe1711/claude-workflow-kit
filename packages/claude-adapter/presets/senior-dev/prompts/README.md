# Output contracts

A prompt file says **how to present a result**. It never says how to analyze
one — that is what skills are for. Read exactly one, only when the user asked
for a document, and follow its structure.

| The user asked for | Contract |
| --- | --- |
| what changed / implementation report / handover / feature summary | `change-report.prompt.md` |
| a defect investigation or fix write-up | `bug-report.prompt.md` |
| what a change would affect, before building it | `impact-report.prompt.md` |
| test results, QA evidence | `test-report.prompt.md` |
| a code review or audit result | `review-report.prompt.md` |
| analysis, options, a recommendation, no code | `analysis-report.prompt.md` |
| a query or legacy comparison result | `parity-report.prompt.md` |
| a migration plan | `migration-plan.prompt.md` |
| something for BA / PO / Tester / end users / a stakeholder | `business-summary.prompt.md` |
| one architectural or irreversible decision, recorded | `decision-record.prompt.md` |
| release notes, changelog entry | `release-note.prompt.md` |

Audience beats document type. A bug fix explained to a PO uses
`business-summary.prompt.md`. For a mixed audience, produce **Business summary**
then **Technical detail**, each following its own contract.

## Rules that apply to every contract

- Only the request, the code and diff, and the checks actually run are sources.
  Never fill a section by inference.
- Missing information has a name: `Not applicable`, `Not verified`,
  `Unknown from current scope`, `No business behavior changed.` Use it instead
  of writing something plausible.
- Keep state claims distinct: implemented is not verified, reviewed is not
  tested, build passed is not functionally tested, unit passed is not E2E,
  manual verification required is not failure.
- Omit a section that has nothing in it rather than padding it. Detailed means
  structurally complete and true, not long.
- Match the reader's language. If the request was in Vietnamese, write in
  Vietnamese.
- If this repository already has its own template for the document, use that one.
