import { useState, type ReactNode } from 'react';
import { postBoardAction } from '../api';
import { clock } from '../derive';
import type { BoardAction, Checkpoint, MissionBoardView, RunDetail, RunView } from '../types';

interface Props {
  run: RunView;
  board: MissionBoardView;
  onApplied: (detail: RunDetail) => void;
}

/** A collapsed reference section. Native <details>: no state, no library. */
function Group({
  title,
  count,
  open,
  children,
}: {
  title: string;
  count?: string | number;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="group" open={open}>
      <summary>
        {title}
        {count !== undefined && count !== '' && <span className="group__count">{count}</span>}
      </summary>
      <div className="group__body">{children}</div>
    </details>
  );
}

/**
 * The Mission Board. It answers one question first — "what does this run need
 * from me right now?" — and keeps everything else (plan, tasks, evidence,
 * decisions) collapsed underneath. Every button maps to one server action;
 * nothing decides on the user's behalf, and an action the server would refuse
 * is disabled with the reason on it rather than failing after the click.
 */
export function MissionBoard({ run, board, onApplied }: Props) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const send = async (action: BoardAction, label: string): Promise<void> => {
    setBusy(action.action);
    setError(null);
    setDone(null);
    try {
      const detail = await postBoardAction(run.runId, {
        ...action,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onApplied(detail);
      setNote('');
      setDone(label);
      window.setTimeout(() => setDone((current) => (current === label ? null : current)), 4000);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const hasNote = note.trim().length > 0;
  const working = busy !== null;
  const checkpoints = board.pendingCheckpoints;
  const openRisks = board.risks.filter((risk) => risk.status === 'OPEN');
  const blocked = !board.readiness.ok;
  const offTrack = board.offTrack?.status === 'OFF_TRACK' ? board.offTrack : null;
  const doneTasks = board.tasks.filter((task) => task.status === 'DONE').length;
  const thresholds = board.confidenceThresholds;

  // One note field for the whole board, rendered beside whichever buttons need
  // it. Without this, actions that require a reason had nowhere to read it from.
  const noteField = (why: string) => (
    <>
      <textarea
        className="board__note"
        placeholder="Note / reason — sent with the button you click"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
      />
      <p className="board__note-hint">{why}</p>
    </>
  );

  const checkpointCard = (checkpoint: Checkpoint) => (
    <section key={checkpoint.id} className="attention attention--decision">
      <div className="attention__label">Decision required</div>
      <div className="attention__title">
        {checkpoint.kind.replace(/_/g, ' ').toLowerCase()} · {checkpoint.id}
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
        <Group title="Alternatives" count={checkpoint.alternatives.length}>
          <ul className="detail__list">
            {checkpoint.alternatives.map((alternative) => (
              <li key={alternative}>{alternative}</li>
            ))}
          </ul>
        </Group>
      )}
      {checkpoint.evidence.length > 0 && (
        <Group title="Evidence given" count={checkpoint.evidence.length}>
          <ul className="detail__list dim">
            {checkpoint.evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Group>
      )}
      <div className="board__meta">
        {checkpoint.risk && <span>risk {checkpoint.risk.toLowerCase()}</span>}
        {checkpoint.confidence !== undefined && <span>confidence {checkpoint.confidence}%</span>}
        <span>opened {clock(checkpoint.openedAt)}</span>
      </div>

      {noteField('Approve needs no note. Reject, modify and “more evidence” record yours as the reason.')}

      <div className="board__actions">
        <button
          type="button"
          className="btn btn--approve"
          disabled={working}
          onClick={() =>
            void send({ action: 'checkpoint.approve', checkpointId: checkpoint.id }, 'Approved')
          }
        >
          Approve
        </button>
        <button
          type="button"
          className="btn"
          disabled={working || !hasNote}
          title={hasNote ? undefined : 'Write a note first: modify records what to change and why.'}
          onClick={() =>
            void send({ action: 'checkpoint.modify', checkpointId: checkpoint.id }, 'Sent for modification')
          }
        >
          Modify
        </button>
        <button
          type="button"
          className="btn btn--reject"
          disabled={working || !hasNote}
          title={hasNote ? undefined : 'Write a note first: a rejection records why.'}
          onClick={() =>
            void send({ action: 'checkpoint.reject', checkpointId: checkpoint.id }, 'Rejected')
          }
        >
          Reject
        </button>
        <button
          type="button"
          className="btn"
          disabled={working || !hasNote}
          title={hasNote ? undefined : 'Write a note first: name the evidence that is missing.'}
          onClick={() =>
            void send(
              { action: 'checkpoint.request-evidence', checkpointId: checkpoint.id },
              'Asked for more evidence',
            )
          }
        >
          More evidence
        </button>
      </div>
      <p className="board__hint">Repository writes stay denied until this is answered.</p>
    </section>
  );

  return (
    <div className="board">
      <div className="board__head">
        <div className="board__head-row">
          <div style={{ minWidth: 0 }}>
            <div className="board__title">{board.title ?? board.runId}</div>
            <div className="board__where">
              {board.missionState.replace(/_/g, ' ').toLowerCase()} · {board.currentPhase}
              {board.stateDrift && (
                <span className="warn" title="The topology implies a different phase than the mission state.">
                  {' '}
                  (phase says {board.stateDrift.toLowerCase()})
                </span>
              )}
            </div>
          </div>
          <span
            className={`pill pill--health_${board.health.health.toLowerCase()}`}
            title={board.health.reasons.join('; ')}
          >
            {board.health.health.replace('_', ' ').toLowerCase()}
          </span>
        </div>

        <div className="board__bar">
          <div className="board__bar-fill" style={{ width: `${board.progress.percent}%` }} />
        </div>
        <div className="board__progress">
          <span>{board.currentAction}</span>
          <span>
            {board.progress.percent}%
            {board.progress.basis === 'tasks' &&
              ` · ${board.progress.completedTasks}/${board.progress.totalTasks} tasks`}
          </span>
        </div>
      </div>

      {error && <div className="detail__error">{error}</div>}
      {done && <div className="detail__ok">{done}.</div>}

      {board.health.reasons.length > 0 && (
        <ul className="board__reasons">
          {board.health.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      {checkpoints.map(checkpointCard)}

      {blocked && (
        <section className="attention attention--blocked">
          <div className="attention__label">Implementation blocked</div>
          <ul className="detail__list warn">
            {board.readiness.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
          <div className="board__actions">
            <button
              type="button"
              className="btn btn--risk"
              disabled={working}
              title="Records the blockers as knowingly accepted, with your note as the reason."
              onClick={() =>
                void send(
                  {
                    action: 'mission.accept-risk',
                    reason: note.trim() || 'accepted from the Mission Board',
                  },
                  'Blockers accepted',
                )
              }
            >
              Proceed anyway
            </button>
          </div>
        </section>
      )}

      {offTrack && (
        <section className="attention">
          <div className="attention__label">Off track</div>
          <p className="warn">{offTrack.reason ?? 'investigation left the mission scope'}</p>
          {offTrack.actualScope && (
            <p className="dim">
              expected {offTrack.expectedScope ?? '—'} · actual {offTrack.actualScope}
            </p>
          )}
          <div className="board__actions">
            <button
              type="button"
              className="btn"
              disabled={working}
              onClick={() => void send({ action: 'mission.return-to-scope' }, 'Back on track')}
            >
              Return to scope
            </button>
            <button
              type="button"
              className="btn"
              disabled={working || !offTrack.actualScope}
              title={
                offTrack.actualScope
                  ? 'Widen the plan to the scope actually worked on; your note becomes the recorded reason.'
                  : 'No actual scope was recorded, so there is nothing to widen the plan to.'
              }
              onClick={() =>
                void send(
                  {
                    action: 'mission.add-to-scope',
                    scope: offTrack.actualScope ?? '',
                    reason: note.trim() || 'scope widened from the Mission Board',
                  },
                  'Scope widened',
                )
              }
            >
              Add to scope
            </button>
          </div>
        </section>
      )}

      {checkpoints.length === 0 && !blocked && !offTrack && (
        <section className="attention attention--clear">
          Nothing is waiting on you. The run continues on its own; you will see a decision here when
          one opens.
        </section>
      )}

      {board.readiness.warnings.length > 0 && (
        <Group title="Warnings" count={board.readiness.warnings.length} open={!blocked}>
          <ul className="detail__list warn">
            {board.readiness.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Group>
      )}

      {board.tasks.length > 0 && (
        <Group title="Tasks" count={`${doneTasks}/${board.tasks.length}`} open>
          <ul className="board__tasks">
            {board.tasks.map((task) => (
              <li key={task.id}>
                <span className={`pill pill--${task.status.toLowerCase()}`}>
                  {task.status.replace('_', ' ').toLowerCase()}
                </span>
                <span className="board__task-title" title={task.reason ?? task.title}>
                  {task.epic} · {task.title}
                </span>
                {task.status !== 'DONE' && task.status !== 'SKIPPED' && (
                  <button
                    type="button"
                    className="btn btn--tiny btn--ghost"
                    disabled={working}
                    title="Mark this task skipped; your note is recorded with it."
                    onClick={() => void send({ action: 'task.skip', taskId: task.id }, 'Task skipped')}
                  >
                    skip
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Group>
      )}

      {openRisks.length > 0 && (
        <Group
          title="Risks"
          count={`${openRisks.length} open`}
          open={openRisks.some((risk) => risk.level === 'HIGH' || risk.level === 'CRITICAL')}
        >
          <ul className="detail__list">
            {openRisks.map((risk) => (
              <li key={risk.id}>
                <span className={`pill pill--risk_${risk.level.toLowerCase()}`}>{risk.level.toLowerCase()}</span>{' '}
                {risk.id} {risk.category} — {risk.trigger}
                {risk.mitigation && <span className="dim"> · mitigation: {risk.mitigation}</span>}
              </li>
            ))}
          </ul>
        </Group>
      )}

      {(Object.keys(board.confidence).length > 0 || Object.keys(board.evidence).length > 0) && (
        <Group title="Confidence & evidence">
          {Object.keys(board.confidence).length > 0 && (
            <ul className="board__metrics">
              {Object.entries(board.confidence).map(([dimension, value]) => {
                const minimum = thresholds[dimension as keyof typeof thresholds];
                const low = minimum !== undefined && (value ?? 0) < minimum;
                return (
                  <li key={dimension} className={low ? 'warn' : undefined}>
                    <span>{dimension}</span>
                    <span className="board__meter">
                      <i className={low ? 'low' : undefined} style={{ width: `${value ?? 0}%` }} />
                    </span>
                    <span>
                      {value}%{minimum !== undefined && <span className="dim"> / {minimum}%</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {Object.keys(board.evidence).length > 0 && (
            <ul className="board__metrics" style={{ marginTop: 8 }}>
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
          )}
        </Group>
      )}

      {board.plan && (
        <Group title="Plan">
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
        </Group>
      )}

      {board.decisions.length > 0 && (
        <Group title="Decisions" count={board.decisions.length}>
          <ul className="detail__list">
            {board.decisions.slice(-8).reverse().map((decision) => (
              <li key={decision.id}>
                <strong>{decision.id}</strong> {decision.decision}
                <div className="dim">{decision.reason}</div>
                {decision.rejected.length > 0 && (
                  <div className="dim">rejected: {decision.rejected.join('; ')}</div>
                )}
              </li>
            ))}
          </ul>
        </Group>
      )}

      {board.deliverables.length > 0 && (
        <Group
          title="Deliverables"
          count={`${board.deliverables.filter((d) => d.status === 'DONE').length}/${board.deliverables.length}`}
        >
          <ul className="board__metrics">
            {board.deliverables.map((deliverable) => (
              <li key={deliverable.name} title={deliverable.reason ?? ''}>
                <span>
                  {deliverable.name}
                  {!deliverable.required && <span className="dim"> (optional)</span>}
                </span>
                <span className={deliverable.status === 'DONE' ? undefined : 'dim'}>
                  {deliverable.status.toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </Group>
      )}

      <Group title="Classification">
        <dl className="detail__grid">
          <dt>Workflow</dt>
          <dd>
            {board.workflowClass ? `${board.workflowClass.toLowerCase()} · ${board.topology}` : board.topology}
          </dd>
          {board.taskType && (
            <>
              <dt>Task type</dt>
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
          <dt>Run</dt>
          <dd>{board.runId}</dd>
        </dl>
      </Group>

      <Group title="Mission control" open>
        {checkpoints.length === 0 &&
          noteField('Pause, cancel and “proceed anyway” record this note as the reason.')}
        <div className="board__actions">
          {board.availableActions.includes('pause') && (
            <button
              type="button"
              className="btn"
              disabled={working}
              title="Denies repository writes until you resume. Read-only work continues."
              onClick={() =>
                void send(
                  { action: 'mission.pause', reason: note.trim() || 'paused from the board' },
                  'Mission paused',
                )
              }
            >
              Pause
            </button>
          )}
          {board.availableActions.includes('resume') && (
            <button
              type="button"
              className="btn btn--approve"
              disabled={working}
              onClick={() => void send({ action: 'mission.resume' }, 'Mission resumed')}
            >
              Resume
            </button>
          )}
          {board.availableActions.includes('cancel') && (
            <button
              type="button"
              className="btn btn--reject"
              disabled={working || !hasNote}
              title={
                hasNote
                  ? 'Retires the run as cancelled, with your note as the reason.'
                  : 'Write a note first: cancelling records why the mission was withdrawn.'
              }
              onClick={() => void send({ action: 'mission.cancel', reason: note.trim() }, 'Mission cancelled')}
            >
              Cancel mission
            </button>
          )}
        </div>
      </Group>
    </div>
  );
}
