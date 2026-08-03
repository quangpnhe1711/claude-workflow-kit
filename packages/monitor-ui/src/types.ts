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
  | 'ABANDONED'
  | 'POSSIBLY_STALLED';

/** Runtime moving while the phase does not. Never a failure, always reported. */
export type SemanticView = 'OK' | 'SEMANTIC_LAG';

export type RunView = RunState & { derivedStatus: RunStatusView; derivedSemantic: SemanticView };

export interface PolicyHealthView {
  status: 'OK' | 'DEGRADED' | 'DISABLED';
  enforceGates: boolean;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  errorCount: number;
  updatedAt: string;
}

export interface Snapshot {
  projectRoot: string;
  runtimeDir: string;
  stallThresholdSeconds: number;
  semanticLagThresholdSeconds: number;
  currentRunId: string | null;
  workflows: WorkflowDefinition[];
  runs: RunView[];
  unreadableRuns: string[];
  quarantinedRuns?: string[];
  policyHealth?: PolicyHealthView | null;
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
