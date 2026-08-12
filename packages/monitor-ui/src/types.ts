import type {
  RunState,
  WorkflowDefinition,
  WorkflowEvent,
} from '@claude-workflow-kit/workflow-core';

export type { RunState, WorkflowDefinition, WorkflowEvent, WorkflowNode, WorkflowEdge, NodeState, ClaudeStatus } from '@claude-workflow-kit/workflow-core';
export type {
  RunIndexEntry,
  RunRollup,
  StepRollup,
  UsageRollup,
} from '@claude-workflow-kit/workflow-core';
export type {
  Checkpoint,
  CheckpointKind,
  DecisionRecord,
  EvidenceRecord,
  MissionBoardView,
  MissionRecord,
  MissionState,
  MissionTask,
  RiskRecord,
} from '@claude-workflow-kit/workflow-core';

/** Mission summary the server attaches to every run in the list. */
export interface MissionSummary {
  state: string;
  health: string;
  healthReason: string;
  workflowClass?: string;
  taskType?: string;
  complexity?: string;
  riskLevel?: string;
  progressPercent: number;
  progressBasis: 'tasks' | 'state';
  completedTasks: number;
  totalTasks: number;
  pendingCheckpoints: number;
  openRisks: number;
  blockers: string[];
}

export type RunStatusView =
  | 'RUNNING'
  | 'WAITING_USER'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABANDONED'
  | 'POSSIBLY_STALLED';

/** Runtime moving while the phase does not. Never a failure, always reported. */
export type SemanticView = 'OK' | 'SEMANTIC_LAG';

export type RunView = RunState & {
  derivedStatus: RunStatusView;
  derivedSemantic: SemanticView;
  missionSummary?: MissionSummary;
};

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
  /** Live rail: unfinished runs plus the most recent finished ones. */
  runs: RunView[];
  totalRuns?: number;
  unreadableRuns: string[];
  quarantinedRuns?: string[];
  policyHealth?: PolicyHealthView | null;
  generatedAt: string;
}

export interface RunDetail {
  run: RunView;
  workflow: WorkflowDefinition;
  events: WorkflowEvent[];
  eventBytes?: number;
  artifacts: string[];
  /** Mission Board, or null for a run that never classified. */
  board: import('@claude-workflow-kit/workflow-core').MissionBoardView | null;
  rollup: import('@claude-workflow-kit/workflow-core').RunRollup | null;
}

export interface RunPage {
  runs: import('@claude-workflow-kit/workflow-core').RunIndexEntry[];
  total: number;
  offset: number;
  limit: number;
}

export interface EventPage {
  runId: string;
  events: WorkflowEvent[];
  cursor: number;
  size: number;
  hasMore: boolean;
}

export interface WorkflowStat {
  workflow: string;
  runs: number;
  completed: number;
  failed: number;
  abandoned: number;
  successRate: number | null;
  averageDurationMs: number | null;
  medianDurationMs: number | null;
}

export interface SkillStat {
  skill: string;
  runs: number;
  completed: number;
  successRate: number | null;
  averageDurationMs: number | null;
  lastRunAt: string | null;
}

export interface Analytics {
  totalRuns: number;
  active: number;
  blocked: number;
  completed: number;
  failed: number;
  abandoned: number;
  successRate: number | null;
  averageDurationMs: number | null;
  medianDurationMs: number | null;
  workflows: WorkflowStat[];
  skills: SkillStat[];
  usage: { available: boolean; totalTokens: number | null; estimatedCost: number | null };
  generatedAt: string;
}

/** One Mission Board action, as the POST body the monitor server expects. */
export interface BoardAction {
  action: string;
  checkpointId?: string;
  note?: string;
  reason?: string;
  taskId?: string;
  scope?: string;
  state?: string;
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
