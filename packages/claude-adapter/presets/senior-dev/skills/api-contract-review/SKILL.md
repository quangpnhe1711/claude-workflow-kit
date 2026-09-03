---
name: api-contract-review
description: Decide whether a change to an HTTP, RPC, event, or published interface breaks its consumers - shape, nullability, enum evolution, status codes, error body, pagination, filter semantics, auth, idempotency, serialization - in both deploy directions, and choose the compatible way to ship it. Use when a request/response shape, status code, field meaning, or event payload changes.
effort: medium
---

## Why this skill exists

Vanilla Claude is likely to:

- call an added response field "safe" without checking whether consumers use
  **strict deserialization** — a generated client, a `Decodable` struct, or a
  parser configured to fail on unknown properties rejects the whole payload;
- miss the **silent break**: same field name and type, different meaning, unit,
  timezone, or rounding. No schema diff shows it and no test fails;
- treat an added enum value as additive, when every consumer that switches
  exhaustively now hits an unhandled case;
- review only the happy path and ignore the **error contract** — status codes,
  error body shape, error codes — which is what clients branch and retry on;
- check the new client against the new server and conclude compatibility, never
  testing old-client/new-server or new-client/old-server;
- forget consumers that are not code: payloads already queued, stored webhooks
  awaiting retry, cached responses, mobile app versions that cannot be upgraded.

This skill adds: a compatibility classification per dimension, the two deploy
directions, strict-reader verification, and a shipping strategy chosen from the
consumer set rather than from preference.

## 1. Classify per dimension, not per endpoint

```text
BACKWARD COMPATIBLE        every existing consumer keeps working, unchanged
CONDITIONALLY COMPATIBLE   safe only under a stated condition — verify the condition
BREAKING                   some existing consumer stops working or misbehaves
UNKNOWN                    consumers cannot be enumerated from here
```

| Dimension | Usually | Watch |
| --- | --- | --- |
| new endpoint / method / event type | COMPATIBLE | routing catch-alls, strict OpenAPI validation |
| new **optional** request field | COMPATIBLE | server-side strict validation rejecting unknown input |
| new **required** request field | BREAKING | including "required unless" rules |
| optional → required | BREAKING | |
| new response field | CONDITIONAL | **only** if every consumer tolerates unknown fields |
| removed / renamed field | BREAKING | including a rename that keeps the old field as a duplicate |
| **same field, new meaning/unit/timezone/precision** | BREAKING, silently | the dangerous row |
| nullability introduced | BREAKING | `null`, missing key and empty string are three values |
| type widening (int → long, string length) | CONDITIONAL | client-side fixed widths, JS number precision past 2^53 |
| type narrowing | BREAKING | |
| new enum value **the client must interpret** | BREAKING | exhaustive switches, DB check constraints on the consumer side |
| new enum value the client only **produces** | COMPATIBLE | |
| removed enum value | BREAKING | stored historical values still deserialize |
| status code change | BREAKING | clients branch on 4xx vs 5xx; 200-with-error-body → 4xx changes retry |
| error body shape or error codes | BREAKING | it is part of the contract even when undocumented |
| validation tightened | BREAKING | previously accepted input now rejected |
| validation relaxed | COMPATIBLE | unless a consumer relied on rejection |
| default value changed | BREAKING | for every caller that omits the field |
| pagination: page size, cursor format, total count | BREAKING | cursor stability across the change; behavior past the end |
| ordering | CONDITIONAL | if it was stable in practice, consumers depend on it |
| filter/search semantics | BREAKING | same parameter, different match rule |
| serialization naming, date format, number format | BREAKING | `2026-08-31` vs ISO instant; decimals as string vs number |
| auth: new scope / narrower permission | BREAKING | callers that previously succeeded now 403 |
| idempotency / retry semantics | BREAKING | which key dedupes, which methods are safe |
| rate limits, timeouts | CONDITIONAL | a tightened limit breaks a batch consumer |
| headers (auth, correlation, content negotiation) | CONDITIONAL | |
| event payload / webhook | as above | plus replay of stored old-format messages |

## 2. Enumerate the consumers — the class decides the strategy

- **In this repository**: clients, SDKs, generated types, tests, fixtures,
  contract snapshots.
- **In the organisation**: search other services for the route string, the event
  name, the field name. A consumer you can enumerate can be coordinated.
- **Outside your control**: public endpoints, partner integrations, mobile apps.
  Mobile is the hard constraint — old versions run for years.
- **Already serialized**: messages in flight on a queue, stored event payloads,
  webhook retry buffers, cached responses, persisted JSON columns. These arrive
  *after* the deploy carrying the *old* shape, and they are consumers.

Anything you cannot enumerate is `UNKNOWN`, and `UNKNOWN` consumers force a
backward-compatible or versioned change. That is the whole point of naming them.

## 3. Verify tolerance instead of assuming it

Before relying on "consumers ignore unknown fields", check how each consumer
actually deserializes:

```text
generated client from a schema     -> often strict; regenerate and diff
typed struct with strict decoding  -> strict (Swift Decodable, some Jackson/serde configs)
hand-written parser                -> usually tolerant
schema-validating gateway/proxy    -> strict, and often forgotten
```

Regenerating the client and reading the diff **is** the review for typed
consumers.

## 4. Both deploy directions

During a rollout both versions exist. Answer both:

```text
old client + new server  -> works?
new client + old server  -> works?   (canary/rollback, and clients deployed first)
```

For events, add: a new consumer reading old messages, and an old consumer reading
new messages.

## 5. Ship it compatibly

In order of preference:

1. **Additive, with tolerance verified** (§3).
2. **New field beside the old**, both populated; deprecate the old with a date
   and a migration note.
3. **New version** — versioned route, media type, or event type — when the change
   cannot be expressed additively. State how long the old version is supported
   and what retires it.
4. **Coordinated breaking change** — only with an enumerable consumer list, all
   updated first, and a written deploy order.

Never reuse a field name with a new meaning, and never reuse a removed name later
for something else. If a unit or meaning changes, the name changes with it
(`total` → `total_cents`).

## 6. Verify the contract, not only the code

- a contract test or schema snapshot that fails when the shape changes;
- a test sending the **old** request shape;
- tests for the **error** responses, not only 200;
- for events, a test deserializing a stored old-format payload;
- regenerate every generated client and diff — that diff is the review;
- an old-version consumer run against the new server where one exists.

## Conclusions this skill must not reach

```text
additive change            != safe (strict deserializers exist — verify)
tests pass                 != backward compatible (tests use the new client)
no compile error           != no consumer breaks (JSON has no compiler)
same field name and type   != same meaning
undocumented behavior      != not part of the contract
internal API               != no external consumer (queues, caches, other teams)
we control all callers     != true until the consumer list is actually enumerated
new client works           != old client works
```

## Stop when

Every changed dimension is classified, every consumer class is enumerated or
explicitly `UNKNOWN`, both deploy directions are answered, and the shipping
strategy follows from that set. Dimensions the change does not touch are out of
scope — this is not an API audit.

## Report

```text
GET /orders/{id}

BREAKING     `total` changes from dollars (float) to cents (int), same name
             -> ship as `total_cents`; keep `total` until v1 retires
CONDITIONAL  new `discount_code` field — safe only for tolerant readers
             verified: web client (tolerant), reporting-service (tolerant),
             mobile SDK regenerated and diffed -> no strict-decode failure
BREAKING     404 replaced by 410 for archived orders — clients branch on 404
             -> keep 404; add `archived: true`
UNKNOWN      mobile app 3.x pins /orders v1 -> v1 supported until 2027-01

Both directions: old client + new server OK (additive); new client + old server
OK (total_cents absent -> falls back to total).
Verified: contract snapshot updated, old-shape request test added, error-path tests added.
```
