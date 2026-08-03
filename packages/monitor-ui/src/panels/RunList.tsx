import type { Snapshot } from '../types';
import { ago } from '../derive';

interface Props {
  snapshot: Snapshot;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  nowMs: number;
}

export function RunList({ snapshot, selectedRunId, onSelect, nowMs }: Props) {
  return (
    <aside className="runlist">
      <div className="panel__title">Runs</div>
      {snapshot.runs.length === 0 && <div className="empty">No runs yet. Start one with a workflow skill.</div>}
      <ul>
        {snapshot.runs.map((run) => (
          <li key={run.runId}>
            <button
              type="button"
              className={`runlist__item${run.runId === selectedRunId ? ' is-selected' : ''}`}
              onClick={() => onSelect(run.runId)}
            >
              <div className="runlist__row">
                <span className={`pill pill--${run.derivedStatus.toLowerCase()}`}>
                  {run.derivedStatus.replace('_', ' ')}
                </span>
                {run.runId === snapshot.currentRunId && <span className="chip chip--current">current</span>}
                {run.derivedSemantic === 'SEMANTIC_LAG' && <span className="chip warn">lag</span>}
              </div>
              <div className="runlist__id">{run.runId}</div>
              <div className="runlist__label">{run.label ?? run.workflow}</div>
              <div className="dim">{ago(run.lastActivityAt, nowMs)}</div>
            </button>
          </li>
        ))}
      </ul>
      {snapshot.unreadableRuns?.length > 0 && (
        <div
          className="runlist__broken warn"
          title='CORRUPT: state.json cannot be read as a run. Retire it with: cw run quarantine-current --reason "corrupt state"'
        >
          CORRUPT: {snapshot.unreadableRuns.join(', ')}
        </div>
      )}
      {snapshot.quarantinedRuns && snapshot.quarantinedRuns.length > 0 && (
        <div className="runlist__broken dim" title="Retired by hand; the files are preserved.">
          quarantined: {snapshot.quarantinedRuns.join(', ')}
        </div>
      )}
    </aside>
  );
}
