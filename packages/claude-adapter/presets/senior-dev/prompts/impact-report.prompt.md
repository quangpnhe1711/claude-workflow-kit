# Impact report

For: what a proposed change would affect, produced **before** building it.

```markdown
# Impact — <proposed change>

## Change under assessment
What would change, in system terms. Signature, semantics, shape, data, or rule.

## Direct impact
| Area / file | What must change | Why |

## Indirect impact
| Consumer | Behaves differently how | Handled by |
Background jobs, exports, reports, caches, serialized payloads, other services,
tests asserting current behavior.

## Unknown
Consumers that cannot be determined from this repository. Naming them is the
point — do not convert them into assumptions.

## Data and contracts
Schema, stored payloads, API or event shapes, permissions. `Not applicable`
when none.

## Risk
| Risk | Likelihood | Consequence | Mitigation |
Only evidence-backed risks. No generic "may cause regressions".

## Verification strategy
Which check would catch each indirect impact, and which indirect impacts have
no cheap check today.

## Recommendation
Proceed, proceed with conditions, or do not proceed — and the reason.
```
