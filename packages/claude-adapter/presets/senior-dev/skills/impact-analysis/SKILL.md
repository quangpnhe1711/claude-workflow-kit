---
name: impact-analysis
description: Bound the consumers of a change that static references alone will not reveal - a semantic change behind an unchanged signature, a stored or serialized shape, a symbol reached by reflection, DI, configuration, SQL, or an event payload. Not for a local change whose callers the compiler already enumerates.
effort: medium
---

## Why this skill exists

Vanilla Claude is likely to:

- grep the symbol, find the callers, and stop — which is exactly the set the
  compiler would have found anyway;
- treat **no grep hit as no consumer**, missing reflection, DI registration,
  string-addressed routes, config keys, SQL text, and payloads already
  serialized and sitting in a queue;
- miss the dangerous class entirely: the signature is unchanged, so nothing
  breaks at build time and every consumer silently changes behavior;
- report a flat list of files instead of what must change, what must be
  verified, and what genuinely cannot be determined from this repository;
- either stop too early (direct callers only) or never stop (recursive audit of
  the whole repo).

This skill adds: a change taxonomy that predicts *which* consumer classes can be
affected, a search strategy per class that static analysis does not cover, a
four-way classification with required negative evidence, and a bound.

## 1. Name the change; the taxonomy predicts the search

| Change | What can break | Compiler finds it? |
| --- | --- | --- |
| signature or type | every caller | yes — cheap, do it first |
| **semantics behind the same signature** | every caller, silently | **no** |
| return/DTO shape, field name | API clients, snapshots, exports, stored payloads | partly |
| stored data shape or meaning | old rows, backups, replicas, reports | no |
| default value or config key | environments that never set it | no |
| timing, ordering, transaction boundary | concurrent writers, retries, jobs | no |
| permission or visibility rule | every screen and query that assumed the old one | no |
| removal / rename | anything not statically linked: config, reflection, SQL, strings | no |
| exception type or error path | callers that catch, retry, or map errors | rarely |

If the row you are in says "no", the sections below are the only defense.

## 2. Consumer classes, and how each is actually found

Walk the classes that exist in this repository. Skip the rest explicitly.

| Class | How to find it |
| --- | --- |
| direct static references | compiler, LSP, `grep -rn "<symbol>"` |
| transitive callers | one or two hops out, only where behavior — not just types — propagates |
| interface implementations / subclasses / overrides | find the type, then its implementors; a changed contract binds all of them |
| reflection, dynamic dispatch, code generation | search the **string** form of the name; check annotation/decorator scanners and generated output |
| DI / container registration | search the registration module and configuration for the type name |
| runtime configuration, feature flags, env keys | search the key, not the symbol; check defaults in every environment file |
| serialization contracts | search the serialized field name; check custom serializers, and payloads **already** written: queues in flight, stored JSON columns, event logs, caches, sessions |
| database / schema consumers | column and table name across the repo, including raw SQL, views, triggers, FKs, indexes |
| SQL / reporting / analytics | reporting queries, warehouse models, dashboards, tracked event names |
| async / event / message consumers | topic, queue, or event-type name; other services that subscribe |
| scheduled and background jobs | scheduler registry, cron definitions, worker entry points |
| frontend / API consumers | route string, client SDK, generated types, mobile clients pinned to a version |
| external integrations, webhooks | outbound contracts and their retry windows |
| tests encoding current behavior | each is a consumer with an opinion; a test that must change is a finding, not a chore |
| operational surface | alerts, log-based monitors, SLO queries that parse the old shape |

Two searches are worth running even when nothing suggests them, because they are
the classic silent misses: the **string form** of the identifier, and the
**serialized field name**.

## 3. Classify every finding

```text
MUST CHANGE        breaks or misbehaves unless changed in this diff
MUST VERIFY        plausibly affected; needs a named check before shipping
LIKELY UNAFFECTED  references it, and here is the reason it does not care
UNKNOWN            cannot be determined from this repository
```

`LIKELY UNAFFECTED` without a stated reason is a guess wearing a label.
`UNKNOWN` is a legitimate, valuable answer — an external consumer you cannot
enumerate is exactly the finding that should force a backward-compatible
approach instead of a coordinated one.

## 4. Record negative evidence

The absence of a consumer is a claim, and it needs its own evidence. State what
you searched and what you did not:

```text
searched "orderTotal" as a string   -> 0 hits outside the changed module
checked serializers                 -> only OrderDto maps this field
checked event subscribers           -> no consumer of order.updated reads total
did NOT check                       -> other repositories in the organisation
```

This is what makes the analysis auditable, and it is what tells the reader which
part of the conclusion is thin.

## 5. Turn impact into checks, or it was paperwork

Every `MUST VERIFY` gets the cheapest check that would actually catch its
regression, and that check gets run:

```text
MUST VERIFY  OrderExportJob reads total from the same DTO
             -> order-export.test.ts covers it; run it            [PASS]
MUST VERIFY  cached order payloads written before this deploy
             -> added a deserialization test for the old shape    [PASS]
UNKNOWN      reporting-service consumes /orders v1
             -> response shape kept additive; no test possible here
```

If a consumer has no cheap check, say so rather than implying coverage.

## Conclusions this skill must not reach

```text
no grep result              != no runtime consumer
compiles                    != semantically unaffected
same signature              != same behavior for callers
"internal" / "private"      != no consumer (reflection, DI, tests, serialized data)
no test failed              != no regression (the path may be untested)
found the callers           != bounded the impact
one repository searched     != the organisation searched
```

## Stop when

Every materially plausible consumer class is identified, verified unaffected with
a stated reason, or explicitly marked `UNKNOWN`. That is the bound.

Do not widen into modules that merely neighbour the change, do not follow
transitive callers past the point where behavior stops propagating, and do not
open the architecture because a shared helper was touched.

## Report

```text
Impact (semantic change: total switches from gross to net)
  MUST CHANGE        OrderController.confirm, OrderDto
  MUST VERIFY        OrderExportJob        -> order-export.test.ts   PASS
  MUST VERIFY        cached payloads       -> old-shape test added   PASS
  LIKELY UNAFFECTED  InvoicePdf — reads amountDue, not total
  UNKNOWN            reporting-service (separate repo); shape kept additive
  Negative evidence  string search "total" outside module: 0; no event subscriber reads it
```
