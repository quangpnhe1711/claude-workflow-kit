import { useEffect, useState } from 'react';
import { fetchAnalytics } from '../api';
import { ago, formatDuration } from '../derive';
import { href } from '../router';
import type { Analytics, Snapshot } from '../types';

interface Props {
  snapshot: Snapshot;
  nowMs: number;
}

function percent(value: number | null): string {
  return value === null ? 'N/A' : `${Math.round(value * 100)}%`;
}

/**
 * System view. Every number here is folded from persisted runs; anything the
 * runtime cannot measure (tokens, cost) says N/A rather than showing a zero
 * that reads like a measurement.
 */
export function Dashboard({ snapshot, nowMs }: Props) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveVersion = snapshot.runs.map((r) => `${r.runId}:${r.status}`).join(',');

  useEffect(() => {
    let cancelled = false;
    fetchAnalytics()
      .then((next) => {
        if (!cancelled) setAnalytics(next);
      })
      .catch((failure: Error) => {
        if (!cancelled) setError(failure.message);
      });
    return () => {
      cancelled = true;
    };
  }, [liveVersion]);

  if (error) {
    return (
      <div className="screen__pad">
        <div className="detail__error">{error}</div>
      </div>
    );
  }

  if (!analytics) {
    return (
      <div className="screen__pad">
        <div className="skeleton skeleton--head" />
        <div className="skeleton skeleton--block" />
      </div>
    );
  }

  if (analytics.totalRuns === 0) {
    return (
      <div className="screen__pad">
        <div className="empty empty--panel">
          <strong>No runs yet.</strong>
          <div className="empty__hint">
            Run your first skill to start collecting workflow execution data. In Claude Code:
            <code>/work</code>, <code>/bug-fix</code>, <code>/feature-change</code> or{' '}
            <code>/solution-analysis</code>.
          </div>
        </div>
      </div>
    );
  }

  const waiting = snapshot.runs.filter((r) => (r.missionSummary?.pendingCheckpoints ?? 0) > 0);

  return (
    <div className="screen__pad">
      <div className="screen__head">
        <h1>Dashboard</h1>
        <span className="dim">{snapshot.projectRoot}</span>
      </div>

      <div className="kpis">
        <Kpi label="Total runs" value={String(analytics.totalRuns)} />
        <Kpi label="Success rate" value={percent(analytics.successRate)} hint="Of runs that reached a terminal state." />
        <Kpi label="Average duration" value={formatDuration(analytics.averageDurationMs ?? undefined)} />
        <Kpi label="Median duration" value={formatDuration(analytics.medianDurationMs ?? undefined)} />
        <Kpi label="Active" value={String(analytics.active)} tone={analytics.active ? 'ok' : undefined} />
        <Kpi label="Awaiting you" value={String(analytics.blocked)} tone={analytics.blocked ? 'warn' : undefined} />
        <Kpi
          label="Tokens"
          value={analytics.usage.available ? String(analytics.usage.totalTokens) : 'N/A'}
          hint="No token source is wired up in this build; the runtime never sees Claude's usage."
        />
        <Kpi
          label="Estimated cost"
          value={analytics.usage.available && analytics.usage.estimatedCost !== null ? `$${analytics.usage.estimatedCost.toFixed(2)}` : 'N/A'}
          hint="Derived from token usage; unavailable while usage is unavailable."
        />
      </div>

      {waiting.length > 0 && (
        <section className="panel">
          <div className="panel__subtitle">Waiting on you</div>
          <ul className="detail__list">
            {waiting.map((run) => (
              <li key={run.runId}>
                <a className="table__link" href={href({ name: 'run', runId: run.runId })}>
                  {run.label ?? run.runId}
                </a>{' '}
                <span className="dim">
                  {run.missionSummary?.pendingCheckpoints} checkpoint(s) · {ago(run.lastActivityAt, nowMs)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <div className="panel__subtitle">Workflow performance</div>
        <table className="table">
          <thead>
            <tr>
              <th>Workflow</th>
              <th className="num">Runs</th>
              <th className="num">Success</th>
              <th className="num">Average</th>
              <th className="num">Median</th>
            </tr>
          </thead>
          <tbody>
            {analytics.workflows.map((row) => (
              <tr key={row.workflow}>
                <td>{row.workflow}</td>
                <td className="num">{row.runs}</td>
                <td className="num">
                  <span className="meter">
                    <i style={{ width: `${(row.successRate ?? 0) * 100}%` }} />
                  </span>
                  {percent(row.successRate)}
                </td>
                <td className="num">{formatDuration(row.averageDurationMs ?? undefined)}</td>
                <td className="num">{formatDuration(row.medianDurationMs ?? undefined)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <div className="panel__subtitle">Recent runs</div>
        <ul className="detail__list">
          {snapshot.runs.slice(0, 8).map((run) => (
            <li key={run.runId}>
              <span className={`pill pill--${run.derivedStatus.toLowerCase()}`}>
                {run.derivedStatus.replace('_', ' ')}
              </span>{' '}
              <a className="table__link" href={href({ name: 'run', runId: run.runId })}>
                {run.label ?? run.runId}
              </a>{' '}
              <span className="dim">{ago(run.lastActivityAt, nowMs)}</span>
            </li>
          ))}
        </ul>
        <a className="rail__more" href={href({ name: 'runs' })}>
          All runs →
        </a>
      </section>
    </div>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`kpi${tone ? ` kpi--${tone}` : ''}`} title={hint}>
      <div className="kpi__value">{value}</div>
      <div className="kpi__label">{label}</div>
    </div>
  );
}
