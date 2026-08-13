import { ago } from '../derive';
import { href } from '../router';
import type { Snapshot } from '../types';

interface Props {
  snapshot: Snapshot;
  nowMs: number;
  activeRunId: string | null;
}

/**
 * The live rail: what is running right now, plus the last few finished runs.
 *
 * It is deliberately not the history list — the snapshot behind it is rebuilt
 * every second, so it carries only work in progress. Everything older is in the
 * Run Explorer, which reads the index instead.
 */
export function LiveRail({ snapshot, nowMs, activeRunId }: Props) {
  const runs = snapshot.runs;
  const waiting = runs.filter((run) => (run.missionSummary?.pendingCheckpoints ?? 0) > 0).length;

  return (
    <aside className="rail">
      <div className="rail__head">
        <span className="panel__title">Live</span>
        {waiting > 0 && <span className="chip chip--count">{waiting} waiting</span>}
      </div>

      {runs.length === 0 && (
        <div className="empty">
          Nothing is running.
          <div className="empty__hint">
            Start a run with <code>/work</code>, or open history under Runs.
          </div>
        </div>
      )}

      <ul className="rail__list">
        {runs.map((run) => {
          const pending = run.missionSummary?.pendingCheckpoints ?? 0;
          const percent = run.missionSummary?.progressPercent ?? 0;
          return (
            <li key={run.runId}>
              <a
                className={`rail__item${run.runId === activeRunId ? ' is-selected' : ''}${
                  pending > 0 ? ' needs-you' : ''
                }`}
                href={href({ name: 'run', runId: run.runId })}
                aria-current={run.runId === activeRunId}
              >
                <div className="rail__row">
                  <span className={`pill pill--${run.derivedStatus.toLowerCase()}`}>
                    {run.derivedStatus.replace('_', ' ')}
                  </span>
                  {pending > 0 && (
                    <span className="chip chip--count" title="Checkpoints awaiting your answer">
                      {pending}
                    </span>
                  )}
                  {run.runId === snapshot.currentRunId && <span className="chip chip--current">current</span>}
                  {run.derivedSemantic === 'SEMANTIC_LAG' && <span className="chip warn">lag</span>}
                </div>
                <div className="rail__label" title={run.label ?? run.workflow}>
                  {run.label ?? run.workflow}
                </div>
                <div className="rail__meta">
                  <span className="mono">{run.runId}</span>
                  <span>{ago(run.lastActivityAt, nowMs)}</span>
                </div>
                {percent > 0 && (
                  <div className="bar bar--thin">
                    <div className="bar__fill" style={{ width: `${percent}%` }} />
                  </div>
                )}
              </a>
            </li>
          );
        })}
      </ul>

      {typeof snapshot.totalRuns === 'number' && snapshot.totalRuns > runs.length && (
        <a className="rail__more" href={href({ name: 'runs' })}>
          {snapshot.totalRuns - runs.length} more in history →
        </a>
      )}

      {snapshot.unreadableRuns?.length > 0 && (
        <div
          className="rail__broken warn"
          title='CORRUPT: state.json cannot be read as a run. Retire it with: cw run quarantine-current --reason "corrupt state"'
        >
          CORRUPT: {snapshot.unreadableRuns.join(', ')}
        </div>
      )}
      {snapshot.quarantinedRuns && snapshot.quarantinedRuns.length > 0 && (
        <div className="rail__broken dim" title="Retired by hand; the files are preserved.">
          quarantined: {snapshot.quarantinedRuns.join(', ')}
        </div>
      )}
    </aside>
  );
}
