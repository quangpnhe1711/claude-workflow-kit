import { useEffect, useState } from 'react';
import { fetchRuns, type RunFilter } from '../api';
import { ago, formatDuration } from '../derive';
import { href } from '../router';
import type { RunIndexEntry, RunPage, Snapshot } from '../types';

interface Props {
  snapshot: Snapshot;
  nowMs: number;
}

const STATUSES = ['RUNNING', 'WAITING_USER', 'COMPLETED', 'FAILED', 'ABANDONED'] as const;
const PAGE = 25;

/**
 * History. Everything here comes from the derived index, one page at a time —
 * opening this screen must not deserialise a thousand runs.
 */
export function RunExplorer({ snapshot, nowMs }: Props) {
  const [filter, setFilter] = useState<RunFilter>({ limit: PAGE, offset: 0, sort: 'started' });
  const [page, setPage] = useState<RunPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Re-query on filter change, and whenever the live snapshot moves: a run that
  // just finished should not need a manual refresh to change status here.
  const liveVersion = snapshot.runs.map((r) => `${r.runId}:${r.status}`).join(',');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchRuns(filter)
      .then((next) => {
        if (cancelled) return;
        setPage(next);
        setError(null);
      })
      .catch((failure: Error) => {
        if (!cancelled) setError(failure.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, liveVersion]);

  const set = (patch: Partial<RunFilter>) => setFilter((current) => ({ ...current, offset: 0, ...patch }));
  const toggleStatus = (status: string) => {
    const active = filter.status ?? [];
    set({ status: active.includes(status) ? active.filter((s) => s !== status) : [...active, status] });
  };

  const runs = page?.runs ?? [];
  const total = page?.total ?? 0;
  const offset = page?.offset ?? 0;

  return (
    <div className="screen__pad">
      <div className="screen__head">
        <h1>Runs</h1>
        <span className="dim">{total} in history</span>
      </div>

      <div className="filters">
        <input
          className="input"
          type="search"
          placeholder="Search run id or label…"
          value={filter.q ?? ''}
          onChange={(event) => set({ q: event.target.value })}
        />
        <div className="filters__chips">
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`chipbtn${filter.status?.includes(status) ? ' is-active' : ''}`}
              onClick={() => toggleStatus(status)}
            >
              {status.replace('_', ' ').toLowerCase()}
            </button>
          ))}
        </div>
        <select
          className="input input--select"
          value={filter.workflow ?? ''}
          onChange={(event) => set({ workflow: event.target.value || undefined })}
        >
          <option value="">All workflows</option>
          {snapshot.workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.label}
            </option>
          ))}
        </select>
        <select
          className="input input--select"
          value={filter.sort ?? 'started'}
          onChange={(event) => set({ sort: event.target.value as RunFilter['sort'] })}
        >
          <option value="started">Newest first</option>
          <option value="updated">Recently updated</option>
          <option value="duration">Longest</option>
        </select>
      </div>

      {error && <div className="detail__error">{error}</div>}

      {loading && !page && (
        <>
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
        </>
      )}

      {page && runs.length === 0 && (
        <div className="empty empty--panel">
          <strong>No runs match.</strong>
          <div className="empty__hint">
            {total === 0
              ? 'Run your first skill to start collecting workflow execution data — /work, /bug-fix, /feature-change.'
              : 'Clear a filter to see the rest of the history.'}
          </div>
        </div>
      )}

      {runs.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th>Workflow</th>
              <th>Skills</th>
              <th className="num">Duration</th>
              <th className="num">Files</th>
              <th className="num">Tokens</th>
              <th className="num">Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((entry) => (
              <RunRow key={entry.runId} entry={entry} nowMs={nowMs} />
            ))}
          </tbody>
        </table>
      )}

      {total > (page?.limit ?? PAGE) && (
        <div className="pager">
          <button
            type="button"
            className="btn"
            disabled={offset === 0 || loading}
            onClick={() => setFilter((f) => ({ ...f, offset: Math.max(0, offset - PAGE) }))}
          >
            ← Newer
          </button>
          <span className="dim">
            {offset + 1}–{Math.min(offset + runs.length, total)} of {total}
          </span>
          <button
            type="button"
            className="btn"
            disabled={offset + runs.length >= total || loading}
            onClick={() => setFilter((f) => ({ ...f, offset: offset + PAGE }))}
          >
            Older →
          </button>
        </div>
      )}
    </div>
  );
}

function RunRow({ entry, nowMs }: { entry: RunIndexEntry; nowMs: number }) {
  return (
    <tr>
      <td>
        <a className="table__link" href={href({ name: 'run', runId: entry.runId })}>
          {entry.label ?? entry.runId}
        </a>
        <div className="mono dim">{entry.runId}</div>
      </td>
      <td>
        <span className={`pill pill--${entry.status.toLowerCase()}`}>{entry.status.replace('_', ' ')}</span>
        {entry.pendingCheckpoints > 0 && (
          <span className="chip chip--count" title="Awaiting your answer">
            {entry.pendingCheckpoints}
          </span>
        )}
      </td>
      <td>{entry.workflow}</td>
      <td className="dim">{entry.skills.slice(0, 2).join(', ') || '—'}</td>
      <td className="num">{entry.durationMs === null ? '—' : formatDuration(entry.durationMs)}</td>
      <td className="num">{entry.filesChanged === null ? '—' : entry.filesChanged}</td>
      <td className="num dim" title="No token source is wired up in this build.">
        {entry.usageAvailable ? entry.totalTokens : 'N/A'}
      </td>
      <td className="num dim">{ago(entry.startedAt, nowMs)}</td>
    </tr>
  );
}
