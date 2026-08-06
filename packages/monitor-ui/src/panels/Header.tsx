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
            {run.derivedSemantic === 'SEMANTIC_LAG' && (
              <span
                className="pill pill--semantic_lag"
                title="Claude is active but the workflow has not reported a phase transition. The diagram is behind the work."
              >
                semantic lag
              </span>
            )}
            <span className="header__stat">
              <span className={`dot claude-${run.runtime.claude.toLowerCase()}`} />
              claude {run.runtime.claude.replace('_', ' ').toLowerCase()}
            </span>
            {run.runtime.tool && <span className="header__stat tool">{run.runtime.tool}</span>}
            {run.missionSummary && (
              <>
                <span
                  className={`pill pill--health_${run.missionSummary.health.toLowerCase()}`}
                  title={run.missionSummary.healthReason}
                >
                  {run.missionSummary.health.replace('_', ' ').toLowerCase()}
                </span>
                <span className="header__stat dim" title="Mission state">
                  {run.missionSummary.state.replace(/_/g, ' ').toLowerCase()}
                  {run.missionSummary.workflowClass
                    ? ` · ${run.missionSummary.workflowClass.toLowerCase()}`
                    : ''}
                </span>
                {run.missionSummary.pendingCheckpoints > 0 && (
                  <span
                    className="pill pill--waiting_user"
                    title="A human checkpoint is open. Repository writes are denied until it is answered."
                  >
                    {run.missionSummary.pendingCheckpoints} checkpoint
                    {run.missionSummary.pendingCheckpoints > 1 ? 's' : ''}
                  </span>
                )}
              </>
            )}
            <span className="header__stat dim">{ago(run.runtime.lastEventAt ?? run.lastActivityAt, nowMs)}</span>
            <span className="header__stat dim">elapsed {elapsed(run.startedAt, run.finishedAt, nowMs)}</span>
          </>
        )}
        {snapshot.policyHealth && snapshot.policyHealth.status !== 'OK' && (
          <span
            className={`pill pill--policy_${snapshot.policyHealth.status.toLowerCase()}`}
            title={
              snapshot.policyHealth.status === 'DEGRADED'
                ? `The PreToolUse gate policy failed and is failing open: ${snapshot.policyHealth.lastError ?? ''}`
                : 'Gate enforcement is switched off in config.json (enforceGates=false).'
            }
          >
            policy {snapshot.policyHealth.status.toLowerCase()}
          </span>
        )}
        <span className={`conn conn--${connection}`}>{connection}</span>
      </div>
    </header>
  );
}
