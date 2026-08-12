# Observability storage — current model and the database phase

Status: **the database is not implemented.** This document records what the
filesystem model is today, what a SQLite implementation would map onto, and what
has to stay true across the move. It exists so the migration is a persistence
change and never a workflow-engine change.

## 1. Current model (implemented)

Authoritative, per project:

```
.ai-workflow/
├── config.json          kit configuration, including optional `pricing`
├── current-run          active run pointer
├── sessions.json        sessionId -> runId
├── policy-health.json   PreToolUse policy liveness
└── runs/<runId>/
    ├── state.json       the run: nodes, gates, runtime, mission   (atomic write)
    ├── events.jsonl     append-only history, ~70 event types
    └── <artifacts>.md   evidence files
```

Derived, rebuildable, never authoritative:

```
.ai-workflow/
├── index/runs.jsonl     one line per run — the history read model
└── runs/<runId>/rollup.json   folded counts for a finished run
```

Rules that hold today and must keep holding:

1. **Derived data is disposable.** Delete `index/` and `rollup.json`; `cw index
   rebuild` and the next fold reproduce them exactly. Nothing in the workflow
   engine, the gate policy or run completion reads them.
2. **`state.json` is the truth about a run**; `events.jsonl` is the truth about
   its history. Analytics are a function of those two and nothing else.
3. **An unmeasured metric is `null`, never `0`.** `usage.available === false` is
   the difference between "we did not look" and "it was free".
4. **Telemetry is normalised before it is written.** `telemetry.ts` persists a
   project-relative path or one program name; arguments, file contents, stdin
   and environment never reach disk.

## 2. Read/write boundary

Writers (all inside `workflow-core`):

| Writer | Writes |
| --- | --- |
| `WorkflowRuntime.record*` | `state.json`, `events.jsonl` |
| `WorkflowRuntime.recordObservations` | `events.jsonl` (`FILE_*`, `COMMAND_*`, `TEST_*`) |
| `WorkflowRuntime.syncUsage` | `events.jsonl` (`USAGE_RECORDED`) |
| `WorkflowRuntime.syncIndex` | `index/runs.jsonl` (derived) |
| `WorkflowRuntime.rollup` | `runs/<id>/rollup.json` (derived, terminal runs only) |

Readers (`monitor-server`, CLI):

| Reader | Source | Cost |
| --- | --- | --- |
| `buildSnapshot` | index + full state of live runs only | O(live runs) |
| `queryRuns` | index | O(runs in index), no deserialisation of runs |
| `buildAnalytics` | index | O(runs in index) |
| `buildRunDetail` | one `state.json` + event tail + rollup | O(1) runs |
| `eventPage` | byte window of one `events.jsonl` | O(page) |

This table is the migration contract: a database implementation has to satisfy
the same five reads, and nothing else needs to change.

## 3. Mapping to SQLite

Direct, no semantic change:

| Filesystem | Table | Notes |
| --- | --- | --- |
| `runs/<id>/state.json` | `workflow_runs` | JSON columns for `mission`, `gates`, `runtime` keep the nested contract intact |
| `state.json:nodes[id]` | `workflow_run_steps` | (run_id, node_id) primary key; status, visits, timestamps |
| `events.jsonl` | `workflow_events` | (run_id, seq) primary key; `seq` replaces the byte cursor |
| `index/runs.jsonl` | a view or materialised table over `workflow_runs` | the index disappears — it exists only because the filesystem has no query |
| `rollup.json` | a view over `workflow_events`, or a cached table | same fold, expressed as SQL |
| `USAGE_RECORDED` | `usage_records` | one row per (run, session) snapshot |
| `FILE_*` / `COMMAND_*` / `TEST_*` | `file_changes`, `command_executions`, `test_executions` | or stay as typed events with an indexed `type` |
| `mission.decisions[]` | `decisions` | run-scoped today; promotion to knowledge is a later phase |
| `mission.risks[]` | `findings` | same |

Indexes the five reads need:

```sql
CREATE INDEX runs_status_started ON workflow_runs(status, started_at DESC);
CREATE INDEX runs_workflow       ON workflow_runs(workflow_id, started_at DESC);
CREATE INDEX events_run_seq      ON workflow_events(run_id, seq);
CREATE INDEX events_run_type     ON workflow_events(run_id, type);
CREATE INDEX steps_run           ON workflow_run_steps(run_id);
CREATE INDEX usage_run           ON usage_records(run_id, session_id);
```

Cursor equivalence: the HTTP contract (`?after=<cursor>&limit=`) is opaque to
the client. Today the cursor is a byte offset; under SQLite it becomes `seq`.
No UI change.

## 4. What the database must not change

* **Semantics.** Phase transitions, gates, mutation policy, checkpoints,
  ownership and completion validation stay exactly where they are. The database
  is a persistence implementation, not a workflow engine.
* **The hook contract.** A hook must still never break a Claude session, which
  means writes must stay non-blocking and failure must stay silent-but-recorded.
  A locked SQLite file during a `PreToolUse` hook would be a new failure mode:
  WAL mode plus a short busy timeout, and the same fail-open-and-mark-degraded
  path as today.
* **Artifacts.** Evidence files stay on disk. The database indexes them; it does
  not swallow them. A reviewer must still be able to open `business-decision.md`
  without the tool.
* **Idempotence.** Events already tolerate replay (a usage snapshot is
  last-wins per session). A unique `(run_id, seq)` preserves that.

## 5. When to migrate

Migrate when a real number says so, not on principle. The signals:

* `index/runs.jsonl` grows past a few thousand runs and `syncIndex` shows up in
  the poll loop.
* Analytics needs group-by queries the fold cannot express cheaply
  (percentiles per step per workflow over months).
* Retention becomes a requirement — deleting a year of events from JSONL means
  rewriting files.

Sequence, unchanged from the current plan:

1. Filesystem system works (done).
2. Observability UI works (done).
3. Data model validated against real runs.
4. `ExecutionRepository` extracted around the five reads above.
5. `SqliteExecutionRepository` behind the same interface, with a one-way
   importer from `runs/` + `events.jsonl`.
6. Filesystem becomes artifact storage and the write-ahead source; the database
   becomes the query layer.

PostgreSQL only if the product becomes centralised (multiple machines, multiple
users, remote monitor). A local, single-repo tool has no use for a server.

## 6. Deliberately not built yet

* `ExecutionRepository` abstraction — one implementation exists, so an interface
  would be a guess about the second one. Extract it when SQLite lands.
* Retention and compaction of `events.jsonl`.
* Cross-run promotion of findings and decisions into project knowledge.
* Step-level percentile analytics (needs per-step durations aggregated across
  runs; the rollup already carries them per run).
