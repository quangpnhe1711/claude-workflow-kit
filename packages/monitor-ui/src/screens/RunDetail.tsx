import { useEffect, useState } from 'react';
import { artifactUrl, fetchRunDetail } from '../api';
import { useProjectId } from '../project';
import { elapsed, formatDuration } from '../derive';
import { WorkflowGraph } from '../graph/WorkflowGraph';
import { ActivityFeed } from '../panels/ActivityFeed';
import { MissionBoard } from '../panels/MissionBoard';
import { NodeDetail } from '../panels/NodeDetail';
import { Timeline } from '../panels/Timeline';
import { href } from '../router';
import { useMonitor } from '../store';
import type { RunDetail as Detail, Snapshot } from '../types';

interface Props {
  runId: string;
  snapshot: Snapshot;
  nowMs: number;
}

/** One metric. A value that was never measured says N/A — never 0. */
function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="metric" title={title}>
      <div className="metric__value">{value}</div>
      <div className="metric__label">{label}</div>
    </div>
  );
}

/**
 * The run workspace: what is happening, in which phase, and what it has done —
 * on one screen. Everything deeper (a phase's activity, the governance board,
 * the full event history) opens in place rather than on another page.
 */
export function RunDetail({ runId, snapshot, nowMs }: Props) {
  const projectId = useProjectId();
  const { selectedNodeId, sideTab, selectNode, setSideTab } = useMonitor();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const live = snapshot.runs.find((r) => r.runId === runId) ?? null;
  // Live runs re-fetch when the snapshot says they moved; a finished run is
  // fetched once. `updatedAt` is the only trigger, so an idle run costs nothing.
  const version = live?.updatedAt ?? '';

  useEffect(() => {
    let cancelled = false;
    if (detail?.run.runId !== runId) setDetail(null);
    fetchRunDetail(projectId, runId)
      .then((next) => {
        if (!cancelled) {
          setDetail(next);
          setError(null);
        }
      })
      .catch((failure: Error) => {
        if (!cancelled) setError(failure.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, runId, version]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      selectNode(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectNode]);

  if (error) {
    return (
      <div className="screen__pad">
        <a className="backlink" href={href({ name: 'runs', projectId })}>
          ← Runs
        </a>
        <div className="detail__error">{error}</div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="screen__pad">
        <div className="skeleton skeleton--head" />
        <div className="skeleton skeleton--block" />
      </div>
    );
  }

  const run = detail.run;
  const rollup = detail.rollup;
  const workflow = detail.workflow;
  const status = run.derivedStatus;
  const board = detail.board;
  const pending = board?.pendingCheckpoints.length ?? 0;
  const blocked = pending > 0 || board?.readiness.ok === false;

  return (
    <div className="rundetail">
      <header className="rundetail__head">
        <div className="rundetail__title">
          <a className="backlink" href={href({ name: 'runs', projectId })}>
            ← Runs
          </a>
          <h1>
            {run.label ?? workflow.label}
            <span className="mono dim">{run.runId}</span>
          </h1>
          <div className="rundetail__sub dim">
            {workflow.label}
            {board?.taskType && ` · ${board.taskType}`}
            {board?.workflowClass && ` · ${board.workflowClass.toLowerCase()}`}
            {` · phase ${run.currentNode}`}
          </div>
        </div>

        <div className="rundetail__status">
          <span className={`pill pill--${status.toLowerCase()}`}>
            {status === 'RUNNING' ? '● ' : status === 'COMPLETED' ? '✓ ' : status === 'FAILED' ? '✕ ' : ''}
            {status.replace('_', ' ')}
          </span>
          {blocked && (
            <button type="button" className="header__alert" onClick={() => setSideTab('board')}>
              ⚠ {pending > 0 ? `${pending} decision${pending > 1 ? 's' : ''} required` : 'blocked'}
            </button>
          )}
        </div>
      </header>

      <div className="metrics">
        <Metric label="duration" value={elapsed(run.startedAt, run.finishedAt, nowMs)} />
        <Metric
          label="tokens"
          value={rollup?.usage.available ? String(rollup.usage.totalTokens) : 'N/A'}
          title="No token source is wired up in this build; the runtime never sees Claude's usage."
        />
        <Metric
          label="cost"
          value={rollup?.usage.available && rollup.usage.estimatedCost !== null ? `$${rollup.usage.estimatedCost.toFixed(2)}` : 'N/A'}
          title="Derived from token usage; unavailable while usage is unavailable."
        />
        <Metric label="files changed" value={rollup ? String(rollup.files.changed) : '—'} />
        <Metric label="files read" value={rollup ? String(rollup.files.read) : '—'} />
        <Metric label="tool calls" value={rollup ? String(rollup.tools.calls) : '—'} />
        <Metric
          label="test runs"
          value={rollup ? String(rollup.tests.commandsStarted) : '—'}
          title="Test commands executed. Individual test cases are not parsed, so case counts are N/A."
        />
        <Metric label="events" value={rollup ? String(rollup.eventCount) : String(detail.events.length)} />
      </div>

      <div className="rundetail__cols">
        <section className="col col--graph">
          <div className="col__head">
            <span className="panel__subtitle">Workflow</span>
            <span className="dim">{board ? `${board.progress.percent}% complete` : workflow.id}</span>
          </div>
          <div className="col__graph">
            <WorkflowGraph
              workflow={workflow}
              run={run}
              nowMs={nowMs}
              stallThresholdSeconds={snapshot.stallThresholdSeconds}
              selectedNodeId={selectedNodeId}
              onSelectNode={selectNode}
              rollup={rollup}
            />
          </div>
        </section>

        <section className="col col--activity">
          <div className="col__head">
            <span className="panel__subtitle">Current activity</span>
          </div>
          <ActivityFeed run={run} events={detail.events} nowMs={nowMs} />
        </section>

        <section className="col col--context">
          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={sideTab === 'board'}
              className={`tab${sideTab === 'board' ? ' is-active' : ''}`}
              onClick={() => setSideTab('board')}
            >
              Governance
              {pending > 0 && <span className="chip chip--count">{pending}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sideTab === 'phase'}
              className={`tab${sideTab === 'phase' ? ' is-active' : ''}`}
              disabled={!selectedNodeId}
              title={selectedNodeId ? undefined : 'Click a phase in the diagram to inspect it.'}
              onClick={() => setSideTab('phase')}
            >
              Phase
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sideTab === 'context'}
              className={`tab${sideTab === 'context' ? ' is-active' : ''}`}
              onClick={() => setSideTab('context')}
            >
              Context
            </button>
          </div>

          <div className="col__scroll">
            {sideTab === 'phase' && selectedNodeId ? (
              <NodeDetail
                workflow={workflow}
                run={run}
                detail={detail}
                nodeId={selectedNodeId}
                nowMs={nowMs}
                stallThresholdSeconds={snapshot.stallThresholdSeconds}
              />
            ) : sideTab === 'context' ? (
              <RunContext detail={detail} />
            ) : board ? (
              <MissionBoard run={run} board={board} onApplied={setDetail} />
            ) : (
              <div className="empty">
                This run has no mission record. It appears once the workflow classifies the task
                (<code>cw mission classify</code>).
              </div>
            )}
          </div>
        </section>
      </div>

      <Timeline runId={run.runId} tail={detail.events} eventBytes={detail.eventBytes ?? 0} />
    </div>
  );
}

/** Files, artifacts and outcome — the run's paper trail. */
function RunContext({ detail }: { detail: Detail }) {
  const projectId = useProjectId();
  const rollup = detail.rollup;
  const changed = rollup?.files.changedPaths ?? [];
  const read = rollup?.files.readPaths ?? [];

  return (
    <div>
      <div className="panel__subtitle">Files changed ({rollup?.files.changed ?? 0})</div>
      {changed.length === 0 ? (
        <div className="empty">No repository writes recorded.</div>
      ) : (
        <ul className="detail__list mono">
          {changed.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      )}

      <div className="panel__subtitle">Artifacts</div>
      {detail.artifacts.length === 0 ? (
        <div className="empty">No evidence files written yet.</div>
      ) : (
        <ul className="detail__list">
          {detail.artifacts.map((name) => (
            <li key={name}>
              <a href={artifactUrl(projectId, detail.run.runId, name)} target="_blank" rel="noreferrer">
                {name}
              </a>
            </li>
          ))}
        </ul>
      )}

      <details className="group">
        <summary>
          Files read
          <span className="group__count">{rollup?.files.read ?? 0}</span>
        </summary>
        <div className="group__body">
          {read.length === 0 ? (
            <div className="empty">Nothing recorded.</div>
          ) : (
            <ul className="detail__list mono dim">
              {read.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <details className="group">
        <summary>
          Commands
          <span className="group__count">{rollup?.commands.started ?? 0}</span>
        </summary>
        <div className="group__body">
          <ul className="board__metrics">
            <li>
              <span>completed</span>
              <span>{rollup?.commands.completed ?? 0}</span>
            </li>
            <li>
              <span>failed</span>
              <span className={rollup?.commands.failed ? 'warn' : undefined}>{rollup?.commands.failed ?? 0}</span>
            </li>
            <li>
              <span>test runs</span>
              <span>{rollup?.tests.commandsStarted ?? 0}</span>
            </li>
            <li title="No test reporter is parsed, so individual case counts are unavailable.">
              <span>test cases</span>
              <span className="dim">N/A</span>
            </li>
          </ul>
        </div>
      </details>

      <details className="group">
        <summary>
          Timing
          <span className="group__count">{rollup ? formatDuration(rollup.run.durationMs ?? undefined) : '—'}</span>
        </summary>
        <div className="group__body">
          <dl className="detail__grid">
            <dt>Started</dt>
            <dd className="mono">{detail.run.startedAt}</dd>
            <dt>Finished</dt>
            <dd className="mono">{detail.run.finishedAt ?? '—'}</dd>
            <dt>Workflow</dt>
            <dd>{detail.workflow.id}</dd>
            <dt>Owner</dt>
            <dd className="mono">{detail.run.ownerSessionId ?? '—'}</dd>
          </dl>
        </div>
      </details>
    </div>
  );
}
