import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeStatusView, RunView, StepRollup, WorkflowNode } from '../types';
import { ago, elapsed } from '../derive';

export interface PhaseNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  status: NodeStatusView;
  artifacts: Array<{ name: string; present: boolean }>;
  run: RunView;
  nowMs: number;
  selected: boolean;
  /** Counts folded from the event log. Absent = not measured. */
  step?: StepRollup;
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
  const { node, status, artifacts, run, nowMs, selected, step } = data as PhaseNodeData;
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

      {/* Counts, not guesses: each one is a folded event. A phase that did none
          of a thing shows nothing rather than a row of zeroes. */}
      {step && node.kind === 'phase' && (
        <div className="phase-node__stats">
          {step.filesChanged > 0 && <span title="files changed">✎ {step.filesChanged}</span>}
          {step.filesRead > 0 && <span title="files read">👁 {step.filesRead}</span>}
          {step.toolCalls > 0 && <span title="tool calls">⚙ {step.toolCalls}</span>}
          {step.tests > 0 && <span title="test runs">✓ {step.tests}</span>}
          {step.findings > 0 && <span className="warn" title="risks recorded">⚑ {step.findings}</span>}
          {step.decisions > 0 && <span title="decisions recorded">⚖ {step.decisions}</span>}
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
