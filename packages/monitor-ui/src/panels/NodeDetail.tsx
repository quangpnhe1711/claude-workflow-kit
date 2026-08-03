import { artifactUrl } from '../api';
import { clock, elapsed, nodeStatusView } from '../derive';
import type { RunDetail, RunView, WorkflowDefinition } from '../types';

interface Props {
  workflow: WorkflowDefinition;
  run: RunView;
  detail: RunDetail | null;
  nodeId: string | null;
  nowMs: number;
  stallThresholdSeconds: number;
  onClose: () => void;
}

export function NodeDetail({
  workflow,
  run,
  detail,
  nodeId,
  nowMs,
  stallThresholdSeconds,
  onClose,
}: Props) {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const state = run.nodes[node.id];
  const status = nodeStatusView(run, node.id, nowMs, stallThresholdSeconds);
  const events = (detail?.events ?? []).filter((e) => e.node === node.id || (node.gate && e.gate === node.gate));
  const present = detail?.artifacts ?? run.artifacts;
  const declared = node.artifacts ?? [];
  // A phase owns every artifact it declares; show the missing ones too, because
  // "declared but absent" is the interesting state.
  const artifacts: Array<{ name: string; present: boolean }> = declared.length
    ? declared.map((name) => ({ name, present: present.includes(name) }))
    : node.kind === 'end'
      ? present.map((name) => ({ name, present: true }))
      : [];
  const runningAgents = Object.values(run.agents).filter(
    (a) => a.status === 'RUNNING' && run.currentNode === node.id,
  );

  return (
    <aside className="detail">
      <div className="detail__head">
        <div>
          <div className="panel__title">{node.label}</div>
          <div className="dim">{node.id}</div>
        </div>
        <button type="button" className="detail__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {node.description && <p className="detail__desc">{node.description}</p>}

      <dl className="detail__grid">
        <dt>Status</dt>
        <dd>
          <span className={`pill pill--${status.toLowerCase()}`}>{status.replace('_', ' ')}</span>
        </dd>
        <dt>Started</dt>
        <dd>{clock(state?.startedAt)}</dd>
        <dt>Finished</dt>
        <dd>{clock(state?.finishedAt)}</dd>
        <dt>Duration</dt>
        <dd>{elapsed(state?.startedAt, state?.finishedAt, nowMs)}</dd>
        <dt>Visits</dt>
        <dd>{state?.visits ?? 0}</dd>
        {node.gate && (
          <>
            <dt>Gate</dt>
            <dd>
              <span className={`gate gate--${(run.gates[node.gate] ?? 'OPEN').toLowerCase()}`}>
                {node.gate} = {run.gates[node.gate] ?? 'OPEN'}
              </span>
            </dd>
          </>
        )}
        {node.skill && (
          <>
            <dt>Skill</dt>
            <dd>{node.skill}</dd>
          </>
        )}
        {node.agent && (
          <>
            <dt>Agent</dt>
            <dd>{node.agent}</dd>
          </>
        )}
      </dl>

      {state?.error && <div className="detail__error">{state.error}</div>}

      {run.currentNode === node.id && run.derivedSemantic === 'SEMANTIC_LAG' && (
        <div className="detail__warn warn">
          Semantic lag: Claude is still active but no phase transition has been recorded since{' '}
          {clock(run.lastSemanticAt)}. The diagram may be behind the actual work.
        </div>
      )}

      {runningAgents.length > 0 && (
        <section>
          <div className="panel__subtitle">Subagents</div>
          <ul className="detail__list">
            {runningAgents.map((agent) => (
              <li key={agent.id}>
                <span className="dot claude-subagent_running" /> {agent.name} ·{' '}
                {elapsed(agent.startedAt, agent.finishedAt, nowMs)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {artifacts.length > 0 && (
        <section>
          <div className="panel__subtitle">Artifacts</div>
          <ul className="detail__list">
            {artifacts.map((artifact) => (
              <li key={artifact.name}>
                {artifact.present ? (
                  <a href={artifactUrl(run.runId, artifact.name)} target="_blank" rel="noreferrer">
                    {artifact.name}
                  </a>
                ) : (
                  <span className="warn">{artifact.name} — declared, not written</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="panel__subtitle">Activity</div>
        {events.length === 0 && <div className="empty">No events recorded for this phase.</div>}
        <ul className="detail__events">
          {events.slice(-40).reverse().map((event, i) => (
            <li key={`${event.ts}-${i}`}>
              <span className="dim">{clock(event.ts)}</span>
              <span className={`etype etype--${event.type.toLowerCase()}`}>{event.type}</span>
              {event.tool && <span className="tool">{event.tool}</span>}
              {event.message && <span className="detail__msg">{event.message}</span>}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
