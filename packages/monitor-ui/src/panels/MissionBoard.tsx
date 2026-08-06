import { useState } from 'react';
import { postBoardAction } from '../api';
import { clock } from '../derive';
import type { BoardAction, MissionBoardView, RunDetail, RunView } from '../types';

interface Props {
  run: RunView;
  board: MissionBoardView;
  onApplied: (detail: RunDetail) => void;
}

/**
 * The Mission Board: classification, progress, monitors, decisions — and the
 * controls that let the user steer without typing a command. Every button maps to
 * one server action; nothing here decides anything on the user's behalf, and an
 * action the server refuses shows its reason instead of failing silently.
 */
export function MissionBoard({ run, board, onApplied }: Props) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (action: BoardAction): Promise<void> => {
    setBusy(action.action);
    setError(null);
    try {
      const detail = await postBoardAction(run.runId, { ...action, ...(note.trim() ? { note: note.trim() } : {}) });
      onApplied(detail);
      setNote('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const checkpoint = board.pendingCheckpoints[0];
  const openRisks = board.risks.filter((risk) => risk.status === 'OPEN');
  const thresholds = board.confidenceThresholds;

  return (
    <aside className="detail board">
      <div className="detail__head">
        <div>
          <div className="panel__title">Mission Board</div>
          <div className="dim">{board.title ?? board.runId}</div>
        </div>
        <span className={`pill pill--health_${board.health.health.toLowerCase()}`}>
          {board.health.health.replace('_', ' ').toLowerCase()}
        </span>
      </div>

      <dl className="detail__grid">
        <dt>State</dt>
        <dd>
          {board.missionState.replace(/_/g, ' ').toLowerCase()}
          {board.stateDrift && (
            <span className="warn" title="The topology implies a different phase than the mission state.">
              {' '}
              (phase says {board.stateDrift.toLowerCase()})
            </span>
          )}
        </dd>
        <dt>Workflow</dt>
        <dd>
          {board.workflowClass ? `${board.workflowClass.toLowerCase()} · ${board.topology}` : board.topology}
        </dd>
        {board.taskType && (
          <>
            <dt>Task</dt>
            <dd>
              {board.taskType}
              {board.subtypes.length > 0 && <span className="dim"> +{board.subtypes.join(', ')}</span>}
            </dd>
            <dt>Sizing</dt>
            <dd>
              {board.complexity?.toLowerCase()} · risk {board.riskLevel?.toLowerCase()} · effort{' '}
              {board.effort?.replace('_', ' ').toLowerCase()}
            </dd>
          </>
        )}
        <dt>Phase</dt>
        <dd>{board.currentPhase}</dd>
        <dt>Action</dt>
        <dd>{board.currentAction}</dd>
        <dt>Progress</dt>
        <dd>
          {board.progress.percent}%{' '}
          <span className="dim">
            {board.progress.basis === 'tasks'
              ? `(${board.progress.completedTasks}/${board.progress.totalTasks} tasks, weighted)`
              : '(from mission state)'}
          </span>
        </dd>
      </dl>

      <div className="board__bar">
        <div className="board__bar-fill" style={{ width: `${board.progress.percent}%` }} />
      </div>

      {board.health.reasons.length > 0 && (
        <ul className="board__reasons">
          {board.health.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      {checkpoint && (
        <section className="board__checkpoint">
          <div className="panel__subtitle">
            Checkpoint {checkpoint.id} · {checkpoint.kind.replace('_', ' ').toLowerCase()}
          </div>
          <p className="board__summary">{checkpoint.summary}</p>
          <p className="board__decision">{checkpoint.decisionRequired}</p>
          {checkpoint.recommendation && (
            <p className="board__reco">
              <span className="dim">recommended: </span>
              {checkpoint.recommendation}
            </p>
          )}
          {checkpoint.alternatives.length > 0 && (
            <ul className="detail__list">
              {checkpoint.alternatives.map((alternative) => (
                <li key={alternative}>{alternative}</li>
              ))}
            </ul>
          )}
          {checkpoint.evidence.length > 0 && (
            <ul className="detail__list dim">
              {checkpoint.evidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          <div className="dim board__meta">
            {checkpoint.risk && <span>risk {checkpoint.risk.toLowerCase()}</span>}
            {checkpoint.confidence !== undefined && <span>confidence {checkpoint.confidence}%</span>}
            <span>opened {clock(checkpoint.openedAt)}</span>
          </div>

          <textarea
            className="board__note"
            placeholder="Note — required to reject, modify, or ask for more evidence"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
          />
          <div className="board__actions">
            <button
              type="button"
              className="btn btn--approve"
              disabled={busy !== null}
              onClick={() => void send({ action: 'checkpoint.approve', checkpointId: checkpoint.id })}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void send({ action: 'checkpoint.modify', checkpointId: checkpoint.id })}
            >
              Modify
            </button>
            <button
              type="button"
              className="btn btn--reject"
              disabled={busy !== null}
              onClick={() => void send({ action: 'checkpoint.reject', checkpointId: checkpoint.id })}
            >
              Reject
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void send({ action: 'checkpoint.request-evidence', checkpointId: checkpoint.id })}
            >
              More evidence
            </button>
          </div>
        </section>
      )}

      {!board.readiness.ok && (
        <section>
          <div className="panel__subtitle">Implementation blocked</div>
          <ul className="detail__list warn">
            {board.readiness.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn--risk"
            disabled={busy !== null}
            title="Records the blockers as knowingly accepted, with your note as the reason."
            onClick={() =>
              void send({
                action: 'mission.accept-risk',
                reason: note.trim() || 'accepted from the Mission Board',
              })
            }
          >
            Proceed anyway
          </button>
        </section>
      )}

      {Object.keys(board.confidence).length > 0 && (
        <section>
          <div className="panel__subtitle">Confidence</div>
          <ul className="board__metrics">
            {Object.entries(board.confidence).map(([dimension, value]) => {
              const minimum = thresholds[dimension as keyof typeof thresholds];
              const low = minimum !== undefined && (value ?? 0) < minimum;
              return (
                <li key={dimension} className={low ? 'warn' : undefined}>
                  <span>{dimension}</span>
                  <span>
                    {value}%{minimum !== undefined && <span className="dim"> / {minimum}%</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {Object.keys(board.evidence).length > 0 && (
        <section>
          <div className="panel__subtitle">Evidence</div>
          <ul className="board__metrics">
            {Object.entries(board.evidence).map(([category, record]) => (
              <li
                key={category}
                className={['MISSING', 'CONFLICTING', 'OUTDATED'].includes(record.status) ? 'warn' : undefined}
              >
                <span>{category}</span>
                <span title={record.note ?? ''}>{record.status.replace('_', ' ').toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {openRisks.length > 0 && (
        <section>
          <div className="panel__subtitle">Risks</div>
          <ul className="detail__list">
            {openRisks.map((risk) => (
              <li key={risk.id}>
                <span className={`pill pill--risk_${risk.level.toLowerCase()}`}>{risk.level.toLowerCase()}</span>{' '}
                {risk.id} {risk.category} — {risk.trigger}
                {risk.mitigation && <span className="dim"> · mitigation: {risk.mitigation}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {board.tasks.length > 0 && (
        <section>
          <div className="panel__subtitle">Task breakdown</div>
          <ul className="board__tasks">
            {board.tasks.map((task) => (
              <li key={task.id}>
                <span className={`pill pill--${task.status.toLowerCase()}`}>{task.status.toLowerCase()}</span>
                <span className="board__task-title" title={task.reason ?? ''}>
                  {task.epic} · {task.title}
                </span>
                {task.status !== 'DONE' && task.status !== 'SKIPPED' && (
                  <button
                    type="button"
                    className="btn btn--tiny"
                    disabled={busy !== null}
                    onClick={() => void send({ action: 'task.skip', taskId: task.id })}
                  >
                    skip
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {board.decisions.length > 0 && (
        <section>
          <div className="panel__subtitle">Decisions</div>
          <ul className="detail__list">
            {board.decisions.slice(-6).reverse().map((decision) => (
              <li key={decision.id}>
                <strong>{decision.id}</strong> {decision.decision}
                <div className="dim">{decision.reason}</div>
                {decision.rejected.length > 0 && (
                  <div className="dim">rejected: {decision.rejected.join('; ')}</div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {board.offTrack?.status === 'OFF_TRACK' && (
        <section>
          <div className="panel__subtitle">Off track</div>
          <p className="warn">{board.offTrack.reason ?? 'investigation left the mission scope'}</p>
          {board.offTrack.actualScope && (
            <p className="dim">
              expected {board.offTrack.expectedScope ?? '—'} · actual {board.offTrack.actualScope}
            </p>
          )}
          <div className="board__actions">
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void send({ action: 'mission.return-to-scope' })}
            >
              Return to scope
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              title="Widen the scope on purpose; your note becomes the recorded reason."
              onClick={() =>
                void send({
                  action: 'mission.add-to-scope',
                  scope: board.offTrack?.actualScope ?? '',
                  reason: note.trim() || 'scope widened from the Mission Board',
                })
              }
            >
              Add to scope
            </button>
          </div>
        </section>
      )}

      {board.plan && (
        <section>
          <div className="panel__subtitle">Plan</div>
          <p className="board__summary">{board.plan.objective}</p>
          <dl className="detail__grid">
            <dt>Scope</dt>
            <dd>{board.plan.scope.join(', ') || '—'}</dd>
            <dt>Out of scope</dt>
            <dd>{board.plan.outOfScope.join(', ') || '—'}</dd>
            {board.plan.validation.length > 0 && (
              <>
                <dt>Validation</dt>
                <dd>{board.plan.validation.join(', ')}</dd>
              </>
            )}
            {board.plan.stopConditions.length > 0 && (
              <>
                <dt>Stop when</dt>
                <dd>{board.plan.stopConditions.join('; ')}</dd>
              </>
            )}
          </dl>
        </section>
      )}

      {board.deliverables.length > 0 && (
        <section>
          <div className="panel__subtitle">Deliverables</div>
          <ul className="board__metrics">
            {board.deliverables.map((deliverable) => (
              <li key={deliverable.name} title={deliverable.reason ?? ''}>
                <span>
                  {deliverable.name}
                  {!deliverable.required && <span className="dim"> (optional)</span>}
                </span>
                <span>{deliverable.status.toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="panel__subtitle">Mission control</div>
        <div className="board__actions">
          {board.availableActions.includes('pause') && (
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void send({ action: 'mission.pause', reason: note.trim() || 'paused from the board' })}
            >
              Pause
            </button>
          )}
          {board.availableActions.includes('resume') && (
            <button
              type="button"
              className="btn btn--approve"
              disabled={busy !== null}
              onClick={() => void send({ action: 'mission.resume' })}
            >
              Resume
            </button>
          )}
          {board.availableActions.includes('cancel') && (
            <button
              type="button"
              className="btn btn--reject"
              disabled={busy !== null}
              title="Retires the run as cancelled. A note is required."
              onClick={() => void send({ action: 'mission.cancel', reason: note.trim() })}
            >
              Cancel mission
            </button>
          )}
        </div>
        <p className="dim board__hint">
          Pausing or an open checkpoint denies repository writes until you answer. Read-only work
          continues.
        </p>
      </section>

      {error && <div className="detail__error">{error}</div>}
    </aside>
  );
}
