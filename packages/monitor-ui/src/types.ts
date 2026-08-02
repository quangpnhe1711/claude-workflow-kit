import type {
  RunState,
  WorkflowDefinition,
  WorkflowEvent,
} from '@claude-workflow-kit/workflow-core';

export type { RunState, WorkflowDefinition, WorkflowEvent, WorkflowNode, WorkflowEdge, NodeState, ClaudeStatus } from '@claude-workflow-kit/workflow-core';

export type RunStatusView =
  | 'RUNNING'
  | 'WAITING_USER'
  | 'COMPLETED'
  | 'FAILED'
  | 'POSSIBLY_STALLED';

export type RunView = RunState & { derivedStatus: RunStatusView };

export interface Snapshot {
  projectRoot: string;
  runtimeDir: string;
  stallThresholdSeconds: number;
  currentRunId: string | null;
  workflows: WorkflowDefinition[];
  runs: RunView[];
  generatedAt: string;
}

export interface RunDetail {
  run: RunView;
  workflow: WorkflowDefinition;
  events: WorkflowEvent[];
  artifacts: string[];
}

/** Node display status: the stored status, plus STALE derived at render time. */
export type NodeStatusView =
  | 'PENDING'
  | 'ACTIVE'
  | 'WAITING_USER'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'
  | 'STALE';
