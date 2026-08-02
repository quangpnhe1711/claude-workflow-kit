/** Workflow definition — the data the state machine and the diagram both read. */

export type NodeKind = 'start' | 'phase' | 'waiting' | 'end';

export interface WorkflowNode {
  id: string;
  label: string;
  kind: NodeKind;
  description?: string;
  /** Gate owned by this node, or the gate a `waiting` node is bound to. */
  gate?: string;
  /** Claude skill that implements this phase (informational, for the UI). */
  skill?: string;
  /** Claude agent that implements this phase (informational, for the UI). */
  agent?: string;
  /** Artifact this phase is expected to persist in the run directory. */
  artifact?: string;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** Gate condition: `GATE_NAME` or `!GATE_NAME`. Absent = unconditional. */
  when?: string;
  label?: string;
}

export interface WorkflowDefinition {
  id: string;
  label: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** Semantic phase status. STALE is derived at read time, never stored. */
export type NodeStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'WAITING_USER'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED';

export type GateStatus = 'OPEN' | 'WAITING' | 'PASSED' | 'FAILED';

export type RunStatus = 'RUNNING' | 'WAITING_USER' | 'COMPLETED' | 'FAILED';

/** Claude runtime status, sourced only from Claude Code hooks. */
export type ClaudeStatus =
  | 'UNKNOWN'
  | 'IDLE'
  | 'ACTIVE'
  | 'TOOL_RUNNING'
  | 'SUBAGENT_RUNNING'
  | 'STOPPED'
  | 'FAILED';

export interface NodeState {
  status: NodeStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Number of times this phase has been entered (review loops re-enter). */
  visits: number;
  error?: string;
}

export interface AgentState {
  id: string;
  name: string;
  status: 'RUNNING' | 'STOPPED';
  startedAt: string;
  finishedAt?: string;
}

export interface RuntimeState {
  claude: ClaudeStatus;
  /** Current tool while TOOL_RUNNING, otherwise the last tool seen. */
  tool?: string;
  toolStatus?: 'RUNNING' | 'OK' | 'FAILED';
  agent?: string;
  sessionId?: string;
  /** Timestamp of the last hook event. Basis for stall detection. */
  lastEventAt?: string;
}

export interface RunState {
  runId: string;
  workflow: string;
  label?: string;
  status: RunStatus;
  currentNode: string;
  startedAt: string;
  updatedAt: string;
  /** Last semantic OR runtime activity. Basis for POSSIBLY_STALLED. */
  lastActivityAt: string;
  finishedAt?: string;
  error?: string;
  nodes: Record<string, NodeState>;
  gates: Record<string, GateStatus>;
  runtime: RuntimeState;
  agents: Record<string, AgentState>;
  artifacts: string[];
}

export type EventType =
  // semantic — emitted by skills through the cw CLI
  | 'RUN_STARTED'
  | 'RUN_COMPLETED'
  | 'RUN_FAILED'
  | 'NODE_ENTER'
  | 'NODE_COMPLETE'
  | 'NODE_SKIP'
  | 'NODE_FAIL'
  | 'GATE_WAIT'
  | 'GATE_PASS'
  | 'GATE_FAIL'
  | 'ARTIFACT'
  | 'NOTE'
  // runtime — emitted by Claude Code hooks
  | 'SESSION_START'
  | 'SESSION_END'
  | 'PROMPT_SUBMIT'
  | 'TOOL_START'
  | 'TOOL_END'
  | 'TOOL_FAIL'
  | 'SUBAGENT_START'
  | 'SUBAGENT_STOP'
  | 'TASK_CREATED'
  | 'TASK_COMPLETED'
  | 'TURN_COMPLETE'
  | 'TURN_FAILED';

export interface WorkflowEvent {
  ts: string;
  type: EventType;
  runId: string;
  node?: string;
  gate?: string;
  tool?: string;
  agent?: string;
  agentId?: string;
  sessionId?: string;
  message?: string;
  artifact?: string;
  data?: Record<string, unknown>;
}

export interface KitConfig {
  /** Runtime root, relative to project root. */
  runtimeDir: string;
  /** Absolute file URL of the workflow-core entry, used by hooks. */
  runtimeUrl?: string;
  monitorPort: number;
  /** Seconds without any event before a RUNNING run reads as POSSIBLY_STALLED. */
  stallThresholdSeconds: number;
  /** Open a `generic` run when a prompt arrives and no run is active. */
  autoGenericRun: boolean;
  preset?: string;
  version?: string;
}

export const DEFAULT_CONFIG: KitConfig = {
  runtimeDir: '.ai-workflow',
  monitorPort: 4173,
  stallThresholdSeconds: 120,
  autoGenericRun: true,
};
