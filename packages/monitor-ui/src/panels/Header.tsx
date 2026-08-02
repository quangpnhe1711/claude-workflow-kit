import type { RunView, Snapshot } from '../types';
import { ago, elapsed } from '../derive';

interface Props {
  snapshot: Snapshot;
  run: RunView | null;
  connection: 'connecting' | 'live' | 'offline';
  nowMs: number;
}

export function Header({ snapshot, run, connection, nowMs }: Props) {
  const workflow = snapshot.workflows.find((w) => w.id === run?.workflow);
  return (
    <header className="header">
      <div className="header__left">
        <div className="header__title">
          {workflow?.label ?? 'Claude Workflow Monitor'}
          {run && <span className="header__runid">{run.runId}</span>}
        </div>
        <div className="header__sub">{run?.label ?? snapshot.projectRoot}</div>
      </div>

      <div className="header__right">
        {run && (
          <>
            <span className={`pill pill--${run.derivedStatus.toLowerCase()}`}>
              {run.derivedStatus.replace('_', ' ')}
            </span>
            <span className="header__stat">
              <span className={`dot claude-${run.runtime.claude.toLowerCase()}`} />
              claude {run.runtime.claude.replace('_', ' ').toLowerCase()}
            </span>
            {run.runtime.tool && <span className="header__stat tool">{run.runtime.tool}</span>}
            <span className="header__stat dim">{ago(run.runtime.lastEventAt ?? run.lastActivityAt, nowMs)}</span>
            <span className="header__stat dim">elapsed {elapsed(run.startedAt, run.finishedAt, nowMs)}</span>
          </>
        )}
        <span className={`conn conn--${connection}`}>{connection}</span>
      </div>
    </header>
  );
}
