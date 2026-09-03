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

// --- app (multi-project) -----------------------------------------------------

/** One row in the project switcher, built from the derived run index. */
export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  runtimeDir: string;
  available: boolean;
  installed: boolean;
  preset?: string;
  monitorPort?: number;
  activeRuns: number;
  waitingRuns: number;
  pendingCheckpoints: number;
  totalRuns: number;
  currentRunId?: string;
  lastActivityAt?: string;
  error?: string;
}

/** What the app can do here — the UI hides what this build cannot offer. */
export interface AppInfo {
  ok: boolean;
  version: string | null;
  capabilities: { provisioning: boolean; launcher: boolean };
  claude: { ok: boolean; bin: string; detail: string };
  presets: string[];
  lastProjectId: string | null;
  projects: ProjectSummary[];
  workspaceFile: string;
}

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface ConfigView {
  config: Record<string, unknown> & {
    runtimeDir: string;
    monitorPort: number;
    stallThresholdSeconds: number;
    semanticLagThresholdSeconds: number;
    autoGenericRun: boolean;
    enforceGates: boolean;
    analysisReportDir?: string;
    preset?: string;
  };
  editable: string[];
  file: string;
  exists: boolean;
}

export type LaunchMode = 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';

export type TaskStatus = 'RUNNING' | 'DONE' | 'FAILED' | 'STOPPED' | 'UNKNOWN';

export interface TaskRecord {
  id: string;
  projectId: string;
  prompt: string;
  mode: LaunchMode;
  status: TaskStatus;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string;
  runId?: string;
  error?: string;
}

export interface TaskOutputPage {
  taskId: string;
  cursor: number;
  size: number;
  text: string;
  done: boolean;
}

/** The install result the app shows after "Add project" or "Update". */
export interface InstallOutcome {
  written: string[];
  skipped: string[];
  backups: string[];
  conflicts: string[];
  projectRoot: string;
}

/** One project's contribution to the workspace roll-up. */
export interface ProjectAnalyticsRow {
  id: string;
  name: string;
  totalRuns: number;
  active: number;
  blocked: number;
  completed: number;
  failed: number;
  abandoned: number;
  successRate: number | null;
  averageDurationMs: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  error?: string;
}

export interface WorkspaceAnalytics {
  generatedAt: string;
  projects: ProjectAnalyticsRow[];
  totals: {
    projects: number;
    installed: number;
    totalRuns: number;
    active: number;
    blocked: number;
    completed: number;
    failed: number;
    abandoned: number;
    successRate: number | null;
    totalTokens: number | null;
    estimatedCost: number | null;
  };
}
