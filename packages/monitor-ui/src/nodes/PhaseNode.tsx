import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeStatusView, RunView, WorkflowNode } from '../types';
import { ago, elapsed } from '../derive';

export interface PhaseNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  status: NodeStatusView;
  artifacts: Array<{ name: string; present: boolean }>;
  run: RunView;
  nowMs: number;
  selected: boolean;
}

const BADGE: Record<NodeStatusView, string> = {
  PENDING: '○',
  ACTIVE: '●',
  WAITING_USER: '◐',
  COMPLETED: '✓',
  FAILED: '✕',
  SKIPPED: '–',
  STALE: '◌',
};

export function PhaseNode({ data }: NodeProps) {
  const { node, status, artifacts, run, nowMs, selected } = data as PhaseNodeData;
  const state = run.nodes[node.id];
  const isCurrent = run.currentNode === node.id;
  const live = status === 'ACTIVE' || status === 'STALE' || status === 'WAITING_USER';
  const missing = (artifacts ?? []).filter((a) => !a.present);
  const lagging = isCurrent && run.derivedSemantic === 'SEMANTIC_LAG';

  return (
    <div
      className={`phase-node status-${status.toLowerCase()} kind-${node.kind}${selected ? ' is-selected' : ''}`}
      data-current={isCurrent || undefined}
    >
      <Handle type="target" position={Position.Top} />
      <div className="phase-node__head">
        <span className="phase-node__badge">{BADGE[status]}</span>
        <span className="phase-node__label">{node.label}</span>
      </div>

      <div className="phase-node__meta">
        {node.gate && <span className={`gate gate--${(run.gates[node.gate] ?? 'OPEN').toLowerCase()}`}>{node.gate}</span>}
        {state && state.visits > 1 && <span className="chip">×{state.visits}</span>}
        {state?.startedAt && <span className="chip">{elapsed(state.startedAt, state.finishedAt, nowMs)}</span>}
      </div>

      {live && isCurrent && (
        <div className="phase-node__runtime">
          {status === 'WAITING_USER' ? (
            <span>waiting for user</span>
          ) : status === 'STALE' ? (
            <span className="warn">no activity for {ago(run.lastActivityAt, nowMs).replace(' ago', '')}</span>
          ) : (
            <>
              <span className={`dot claude-${run.runtime.claude.toLowerCase()}`} />
              <span>{run.runtime.claude.replace('_', ' ').toLowerCase()}</span>
              {run.runtime.tool && <span className="tool">{run.runtime.tool}</span>}
              <span className="dim">{ago(run.runtime.lastEventAt ?? run.lastActivityAt, nowMs)}</span>
            </>
          )}
        </div>
      )}

      {lagging && (
        <div className="phase-node__lag warn">
          semantic lag — no transition since {ago(run.lastSemanticAt, nowMs)}
        </div>
      )}

      {missing.length > 0 && (
        <div className="phase-node__missing warn">missing {missing.map((a) => a.name).join(', ')}</div>
      )}

      {status !== 'STALE' && !live && node.skill && <div className="phase-node__impl">{node.skill}</div>}
      {node.agent && <div className="phase-node__impl">agent: {node.agent}</div>}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
