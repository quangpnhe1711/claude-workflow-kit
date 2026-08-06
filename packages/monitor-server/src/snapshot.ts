import {
  WorkflowRuntime,
  buildMissionBoard,
  derivedRunStatus,
  derivedSemanticStatus,
  implementationReadiness,
  missionHealthReport,
  missionProgress,
  pendingCheckpoints,
  type MissionBoardView,
  type PolicyHealth,
  type RunState,
  type WorkflowDefinition,
  type WorkflowEvent,
} from '@claude-workflow-kit/workflow-core';

/**
 * Mission summary carried on every run in the list, so the Mission Board can be
 * rendered without a per-run round trip. The full board comes with the detail.
 */
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

export type RunView = RunState & {
  derivedStatus: string;
  derivedSemantic: string;
  missionSummary?: MissionSummary;
};

export interface MonitorSnapshot {
  projectRoot: string;
  runtimeDir: string;
  stallThresholdSeconds: number;
  semanticLagThresholdSeconds: number;
  currentRunId: string | null;
  workflows: WorkflowDefinition[];
  runs: RunView[];
  /** Runs whose state.json could not be read. Surfaced, never hidden. */
  unreadableRuns: string[];
  /** Unreadable runs that were retired on purpose. */
  quarantinedRuns: string[];
  /**
   * Is the PreToolUse policy actually running? A hook that fails open looks
   * exactly like an allow, so the monitor has to say DEGRADED out loud.
   */
  policyHealth: (PolicyHealth & { status: string }) | null;
  generatedAt: string;
}

export interface RunDetail {
  run: RunView;
  workflow: WorkflowDefinition;
  events: WorkflowEvent[];
  artifacts: string[];
  /** Mission Board for this run, or null when the run never classified. */
  board: MissionBoardView | null;
}

function missionSummary(run: RunState): MissionSummary | undefined {
  const mission = run.mission;
  if (!mission) return undefined;
  const health = missionHealthReport(mission);
  const progress = missionProgress(mission);
  const board = mission.classification;
  const summary: MissionSummary = {
    state: mission.state,
    health: health.health,
    healthReason: health.reasons[0] ?? '',
    progressPercent: progress.percent,
    progressBasis: progress.basis,
    completedTasks: progress.completedTasks,
    totalTasks: progress.totalTasks,
    pendingCheckpoints: pendingCheckpoints(mission).length,
    openRisks: mission.risks.filter((r) => r.status === 'OPEN').length,
    blockers: implementationReadiness(mission).blockers,
  };
  if (board) {
    summary.workflowClass = board.workflowClass;
    summary.taskType = board.taskType;
    summary.complexity = board.complexity;
    summary.riskLevel = board.riskLevel;
  }
  return summary;
}

function view(run: RunState, stall: number, lag: number, now: string): RunView {
  const summary = missionSummary(run);
  return {
    ...run,
    derivedStatus: derivedRunStatus(run, stall, now),
    derivedSemantic: derivedSemanticStatus(run, lag, now),
    ...(summary ? { missionSummary: summary } : {}),
  };
}

export function buildSnapshot(runtime: WorkflowRuntime): MonitorSnapshot {
  const now = new Date().toISOString();
  const threshold = runtime.config.stallThresholdSeconds;
  const lag = runtime.config.semanticLagThresholdSeconds;
  const unreadableRuns: string[] = [];
  const runs = runtime
    .runIds()
    .map((id) => {
      try {
        return runtime.run(id);
      } catch {
        unreadableRuns.push(id);
        return undefined;
      }
    })
    .filter((r): r is RunState => Boolean(r))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((run) => view(run, threshold, lag, now));

  const quarantinedRuns = runtime.quarantinedRunIds();
  return {
    projectRoot: runtime.paths.projectRoot,
    runtimeDir: runtime.paths.runtimeDir,
    stallThresholdSeconds: threshold,
    semanticLagThresholdSeconds: lag,
    currentRunId: runtime.currentRunId() ?? null,
    workflows: [...runtime.workflows().values()],
    runs,
    unreadableRuns: unreadableRuns.filter((id) => !quarantinedRuns.includes(id)),
    quarantinedRuns,
    policyHealth: runtime.policyHealth() ?? null,
    generatedAt: now,
  };
}

export function buildRunDetail(runtime: WorkflowRuntime, runId: string): RunDetail {
  const run = runtime.run(runId);
  const now = new Date().toISOString();
  const workflow = runtime.workflow(run.workflow);
  const runView = view(
    run,
    runtime.config.stallThresholdSeconds,
    runtime.config.semanticLagThresholdSeconds,
    now,
  );
  return {
    run: runView,
    workflow,
    events: runtime.events(runId, 500),
    artifacts: runtime.artifacts(runId),
    board: run.mission
      ? buildMissionBoard(run, workflow, { runStatus: runView.derivedStatus })
      : null,
  };
}

/**
 * Cheap change signature. The server polls this instead of watching the
 * filesystem: one mechanism, and it works the same on every platform.
 *
 * The *derived* values are part of it on purpose. POSSIBLY_STALLED and
 * SEMANTIC_LAG are functions of elapsed time, so they flip without any new event
 * — keeping them out of the signature meant a run went stale on the server and
 * the browser never heard about it.
 */
export function snapshotSignature(snapshot: MonitorSnapshot): string {
  return [
    snapshot.currentRunId ?? '-',
    `policy:${snapshot.policyHealth?.status ?? '-'}:${snapshot.policyHealth?.updatedAt ?? '-'}`,
    `unreadable:${snapshot.unreadableRuns.join(',')}`,
    `quarantined:${snapshot.quarantinedRuns.join(',')}`,
    ...snapshot.runs.map(
      (r) =>
        `${r.runId}:${r.updatedAt}:${r.status}:${r.currentNode}:${r.runtime.claude}:` +
        `${r.derivedStatus}:${r.derivedSemantic}:${r.artifacts.length}:${r.invalidArtifacts?.length ?? 0}:` +
        // Mission state changes without any phase transition — an answered
        // checkpoint or a pause is exactly what the browser must hear about.
        `${r.mission?.updatedAt ?? '-'}:${r.missionSummary?.state ?? '-'}:${r.missionSummary?.health ?? '-'}:` +
        `${r.missionSummary?.pendingCheckpoints ?? 0}:${r.missionSummary?.progressPercent ?? 0}`,
    ),
  ].join('|');
}
