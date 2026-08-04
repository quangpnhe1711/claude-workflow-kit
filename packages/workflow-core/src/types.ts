/** Workflow definition — the data the state machine and the diagram both read. */

export type NodeKind = 'start' | 'phase' | 'waiting' | 'end';

export interface WorkflowNode {
  id: string;
  label: string;
  kind: NodeKind;
  description?: string;
  /** Gate owned by this node, or the optional hard gate a `waiting` node is bound to. */
  gate?: string;
  /** Explicitly marks a gate-free waiting node used only for proportional clarification. */
  advisory?: boolean;
  /** Optional branch phase that legacy/direct runs leave skipped unless explicitly entered. */
  defaultSkipped?: boolean;
  /** Claude skill that implements this phase (informational, for the UI). */
  skill?: string;
  /** Claude agent that implements this phase (informational, for the UI). */
  agent?: string;
  /**
   * Artifacts this phase is expected to persist in the run directory.
   * YAML may declare `artifact: x.md` or `artifacts: [x.md, y.md]`; the loader
   * normalises both into this list.
   */
  artifacts?: string[];
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

export type RunStatus = 'RUNNING' | 'WAITING_USER' | 'COMPLETED' | 'FAILED' | 'ABANDONED';

/** A run in one of these states is finished; nothing may be recorded against it. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['COMPLETED', 'FAILED', 'ABANDONED'];

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

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

/**
 * How a gate reached its current status. Without this a `WAITING` gate cannot be
 * told apart from one that was parked from an unrelated phase, and `gate pass`
 * from a waiting node cannot check that the waiting state was legitimate.
 */
export interface GateProvenance {
  /** Node the run was in when the gate status was last changed. */
  decidedAtNode?: string;
  /** `visits` of the owning phase at that moment. */
  ownerVisit?: number;
  decidedAt?: string;
  /** Waiting node the run legitimately parked on, set by `gate wait`. */
  waitedAtNode?: string;
  waitedAt?: string;
  /** Set when the gate was opened by `cw gate override`. */
  overrideReason?: string;
}

/** One traversed edge. The monitor needs the path actually taken, not a guess. */
export interface Transition {
  from: string;
  to: string;
  at: string;
}

/** An artifact file that exists but does not satisfy the evidence contract. */
export interface InvalidArtifact {
  name: string;
  reason: string;
}

export const SOLUTION_ANALYSIS_ARTIFACTS = [
  'business-analysis.md',
  'impact-analysis.md',
  'solution-options.md',
  'recommended-solution.md',
  'implementation-plan.md',
  'test-strategy.md',
] as const;

export type SolutionAnalysisArtifact = (typeof SOLUTION_ANALYSIS_ARTIFACTS)[number];
export type AnalysisStatus = 'ANALYZING' | 'ANALYSIS_READY' | 'APPROVED';
export type AnalysisFreshness = 'UNCHECKED' | 'VALID' | 'STALE';

export interface SourceSnapshotEntry {
  /** Project-relative path, always slash-normalised. */
  path: string;
  sha256: string;
}

export interface AnalysisApproval {
  analysisRunId: string;
  approvedAt: string;
  approvedSolution: string;
  approvedScope: string;
}

/** Optional so every run written before solution-analysis remains readable. */
export interface SolutionAnalysisState {
  status: AnalysisStatus;
  readyAt?: string;
  sourceSnapshot?: SourceSnapshotEntry[];
  approval?: AnalysisApproval;
  /** Project-relative directory holding the published, human-readable copy. */
  reportDir?: string;
}

/** Optional feature-run link to an approved analysis run. */
export interface AnalysisHandoffState {
  sourceAnalysisRunId: string;
  freshness: AnalysisFreshness;
  checkedAt?: string;
  stalePaths?: string[];
  /** New baseline after a targeted refresh of stale analysis. */
  sourceSnapshot?: SourceSnapshotEntry[];
  refreshedAt?: string;
  refreshReason?: string;
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
  /** Last explicit workflow transition. Basis for SEMANTIC_LAG. */
  lastSemanticAt: string;
  /** Last Claude lifecycle event. Basis for SEMANTIC_LAG. */
  lastRuntimeAt?: string;
  /**
   * Claude session that owns this run. Bound on the first hook event; after
   * that a hook from another session must not mutate it.
   */
  ownerSessionId?: string;
  finishedAt?: string;
  error?: string;
  nodes: Record<string, NodeState>;
  gates: Record<string, GateStatus>;
  /** Per-gate provenance. Added after v0.1; absent on older runs. */
  gateProvenance?: Record<string, GateProvenance>;
  runtime: RuntimeState;
  agents: Record<string, AgentState>;
  /** Artifact files present in the run directory that satisfy the contract. */
  artifacts: string[];
  /** Present-but-unusable artifacts (directory, empty file). Never hidden. */
  invalidArtifacts?: InvalidArtifact[];
  /** Edges actually traversed, oldest first. Capped; only the tail matters. */
  transitions?: Transition[];
  /** Analysis-only lifecycle. Absent on all legacy and non-analysis runs. */
  analysis?: SolutionAnalysisState;
  /** Traceable handoff. Absent keeps feature-change's legacy behavior. */
  sourceAnalysisRunId?: string;
  analysisHandoff?: AnalysisHandoffState;
}

export const MAX_TRANSITIONS = 200;

export type EventType =
  // semantic — emitted by skills through the cw CLI
  | 'RUN_STARTED'
  | 'RUN_ROUTED'
  | 'RUN_ESCALATED'
  | 'RUN_COMPLETED'
  | 'RUN_FAILED'
  | 'RUN_ABANDONED'
  | 'MUTATION_DENIED'
  | 'FORCED_TRANSITION'
  | 'GATE_OVERRIDE'
  | 'ARTIFACT_CONTRACT_OVERRIDE'
  | 'RUN_CLAIMED'
  | 'RUN_TRANSFERRED'
  | 'ANALYSIS_READY'
  | 'ANALYSIS_APPROVED'
  | 'ANALYSIS_HANDOFF'
  | 'ANALYSIS_FRESHNESS'
  | 'ANALYSIS_REFRESHED'
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

/**
 * What a tool call is trying to do, as far as the policy can tell.
 *
 * `workflow-artifact` is the one write that must survive an open gate: the
 * phases that *produce* the evidence a gate needs cannot be blocked by it.
 */
export type MutationKind =
  | 'none'
  | 'workflow-artifact'
  | 'repository'
  | 'command'
  | 'runtime-internal';

/** Result of the PreToolUse gate check. `allow` never blocks a Claude session. */
export interface MutationDecision {
  decision: 'allow' | 'deny';
  reason?: string;
  /** Gates that were still unpassed when a mutation was denied. */
  missingGates?: string[];
  runId?: string;
  kind?: MutationKind;
}

/**
 * Whether the PreToolUse policy is actually running. A hook that fails open is
 * indistinguishable from a hook that allowed the call, so the failure is
 * persisted and surfaced instead of being logged and forgotten.
 */
export type PolicyHealthStatus = 'OK' | 'DEGRADED' | 'DISABLED';

export interface PolicyHealth {
  status: PolicyHealthStatus;
  /** Last time the policy layer evaluated a tool call without throwing. */
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  /** `enforceGates` as read from config at the last evaluation. */
  enforceGates: boolean;
  /** Total failures recorded since the file was created. */
  errorCount: number;
  updatedAt: string;
}

export interface KitConfig {
  /** Runtime root, relative to project root. */
  runtimeDir: string;
  /** Additive persisted-state capability version; absent legacy config = 1. */
  stateSchemaVersion: number;
  /** Absolute file URL of the workflow-core entry, used by hooks. */
  runtimeUrl?: string;
  monitorPort: number;
  /** Seconds without any event before a RUNNING run reads as POSSIBLY_STALLED. */
  stallThresholdSeconds: number;
  /**
   * Seconds of runtime activity without a semantic transition before the run
   * reads as SEMANTIC_LAG — Claude is working, the diagram is not moving.
   */
  semanticLagThresholdSeconds: number;
  /** Open a `generic` run when a prompt arrives and no run is active. */
  autoGenericRun: boolean;
  /** Deny mutation tools while a controlled run has unpassed gates. */
  enforceGates: boolean;
  /** Tool names that write files directly. Denied behind an open gate. */
  mutationTools: string[];
  /**
   * Regexes matched against the tool name for writers we cannot enumerate —
   * chiefly MCP filesystem servers, whose tool names are server-defined.
   */
  mutationToolPatterns: string[];
  /**
   * Tools that execute arbitrary commands. Behind an open gate these are denied
   * unless the command is on the read-only allowlist: a shell can write any file
   * in the repository, so leaving it open makes the gate a suggestion.
   */
  commandTools: string[];
  /**
   * Executables allowed behind an open gate. Matched against argv[0] of every
   * segment of the command line; a segment with an unknown program is denied.
   */
  readOnlyCommands: string[];
  /** `git <sub>` subcommands allowed behind an open gate. */
  readOnlyGitSubcommands: string[];
  /**
   * Allow test/build/lint commands behind an open gate. They cannot change
   * source, but many of them *generate* files (coverage, caches, build output,
   * updated snapshots), so this is the one documented soft edge of the gate.
   */
  allowTestCommandsBehindGate: boolean;
  /** Commands treated as tests/builds when `allowTestCommandsBehindGate`. */
  testCommands: string[];
  /**
   * Project-relative directory the readable copy of a completed solution
   * analysis is published to. Run evidence stays canonical; this is the copy a
   * human opens. Empty string disables publishing.
   */
  analysisReportDir: string;
  preset?: string;
  version?: string;
}

export const DEFAULT_CONFIG: KitConfig = {
  runtimeDir: '.ai-workflow',
  stateSchemaVersion: 2,
  monitorPort: 4173,
  stallThresholdSeconds: 120,
  semanticLagThresholdSeconds: 300,
  autoGenericRun: true,
  enforceGates: true,
  analysisReportDir: 'docs/analysis',
  mutationTools: [
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
    'apply_patch',
    'str_replace_editor',
    'create_file',
  ],
  mutationToolPatterns: [
    '^mcp__.*(write|edit|create|patch|append|move|rename|delete|remove|mkdir|put|upload)',
  ],
  commandTools: ['Bash', 'PowerShell', 'Shell', 'Monitor', 'Terminal', 'run_command'],
  readOnlyCommands: [
    'git',
    'ls',
    'dir',
    'pwd',
    'cat',
    'type',
    'head',
    'tail',
    'wc',
    'grep',
    'rg',
    'ripgrep',
    'fd',
    'find',
    'file',
    'stat',
    'diff',
    'tree',
    'which',
    'where',
    'echo',
    'true',
    'sort',
    'uniq',
    'cut',
    // `awk` and `env` are absent on purpose: awk has system(), and `env VAR=x cmd`
    // launches an unvalidated program. Both look like text utilities.
    'jq',
    'basename',
    'dirname',
    'realpath',
    'date',
    'printenv',
    'Get-ChildItem',
    'Get-Content',
    'Get-Location',
    'Select-String',
    'Measure-Object',
    'Test-Path',
    'Get-Command',
    'Get-Item',
    'Resolve-Path',
    'cw',
  ],
  readOnlyGitSubcommands: [
    'status',
    'diff',
    'log',
    'show',
    'blame',
    'branch',
    'rev-parse',
    'ls-files',
    'ls-tree',
    'describe',
    'cat-file',
    'shortlog',
    'grep',
    'symbolic-ref',
    'merge-base',
    'name-rev',
  ],
  allowTestCommandsBehindGate: true,
  // Entry points only. `node`, `npx`, `python`, `perl` and friends are absent on
  // purpose: they execute arbitrary code, which is a file write in one hop.
  testCommands: [
    'npm',
    'pnpm',
    'yarn',
    'pytest',
    'vitest',
    'jest',
    'mocha',
    'tsc',
    'go',
    'cargo',
    'mvn',
    'gradle',
    'make',
    'dotnet',
    'bazel',
  ],
};
