import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AgentState } from '@claude-workflow-kit/workflow-core';
import { elapsed } from '../derive';

export interface AgentNodeData extends Record<string, unknown> {
  agent: AgentState;
  nowMs: number;
}

export function AgentNode({ data }: NodeProps) {
  const { agent, nowMs } = data as AgentNodeData;
  return (
    <div className={`agent-node agent-${agent.status.toLowerCase()}`}>
      <Handle type="target" position={Position.Left} />
      <span className="dot claude-subagent_running" />
      <span className="agent-node__name">{agent.name}</span>
      <span className="dim">{elapsed(agent.startedAt, agent.finishedAt, nowMs)}</span>
    </div>
  );
}
