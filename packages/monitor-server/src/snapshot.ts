import {
  WorkflowRuntime,
  buildMissionBoard,
  derivedRunStatus,
  derivedSemanticStatus,
  implementationReadiness,
  isTerminalRun,
  missionHealthReport,
  missionProgress,
  pendingCheckpoints,
  skillsDir,
  type SkillDoc,
  type MissionBoardView,
  type PolicyHealth,
  type RunIndexEntry,
  type RunRollup,
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
  /**
   * Live rail only: every unfinished run plus the most recent finished ones.
   * History is answered by `/api/runs`, which reads the derived index instead of
   * every `state.json` — this payload is rebuilt every second.
   */
  runs: RunView[];
  /** Runs in the index, so the UI can say "showing 12 of 840". */
  totalRuns: number;
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
  /** Newest events, for the activity feed. Full history: `/api/runs/:id/events`. */
  events: WorkflowEvent[];
  /** Byte size of the event log — the cursor space for paging the timeline. */
  eventBytes: number;
  artifacts: string[];
  /** Mission Board for this run, or null when the run never classified. */
  board: MissionBoardView | null;
  /** Derived counts. Never authoritative; `null` if the fold failed. */
  rollup: RunRollup | null;
}

/** How many finished runs the live snapshot carries alongside the active ones. */
export const RECENT_RUNS_IN_SNAPSHOT = 15;

/** Newest events returned with a run detail before the client starts paging. */
export const DETAIL_EVENT_TAIL = 120;

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

/**
 * The live payload, rebuilt every second.
 *
 * It deliberately does not carry history: an unfinished run is loaded in full
 * (the diagram needs it), while finished runs are represented by the most recent
 * few. Loading every `state.json` each tick is what made the monitor scale with
 * the size of the archive rather than with the work in progress.
 */
export function buildSnapshot(runtime: WorkflowRuntime): MonitorSnapshot {
  const now = new Date().toISOString();
  const threshold = runtime.config.stallThresholdSeconds;
  const lag = runtime.config.semanticLagThresholdSeconds;
  const unreadableRuns: string[] = [];

  // The index says which runs are still live without deserialising any of them.
  const index = runtime.syncIndex();
  const current = runtime.currentRunId() ?? null;
  const wanted = new Set<string>();
  for (const entry of index) {
    if (!isTerminalRun(entry.status)) wanted.add(entry.runId);
  }
  if (current) wanted.add(current);
  for (const entry of index.filter((e) => isTerminalRun(e.status)).slice(0, RECENT_RUNS_IN_SNAPSHOT)) {
    wanted.add(entry.runId);
  }
  // A run the index has not seen yet (just created, or an index that was wiped)
  // must still appear; falling back to the directory listing keeps the live rail
  // correct even with no index at all.
  if (!index.length) for (const id of runtime.runIds()) wanted.add(id);

  const runs = [...wanted]
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
    currentRunId: current,
    workflows: [...runtime.workflows().values()],
    runs,
    totalRuns: Math.max(index.length, runs.length),
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
  let rollup: RunRollup | null = null;
  try {
    rollup = runtime.rollup(runId);
  } catch {
    // A run whose log cannot be folded still has a diagram and a board.
    rollup = null;
  }

  return {
    run: runView,
    workflow,
    events: runtime.events(runId, DETAIL_EVENT_TAIL),
    eventBytes: rollup?.eventBytes ?? 0,
    artifacts: runtime.artifacts(runId),
    board: run.mission
      ? buildMissionBoard(run, workflow, { runStatus: runView.derivedStatus })
      : null,
    rollup,
  };
}

// ---- analytics -------------------------------------------------------------

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
  /** Usage stays unavailable until a real source is wired up. Never zero. */
  usage: { available: boolean; totalTokens: number | null; estimatedCost: number | null };
  generatedAt: string;
}

// ---- skills guide ----------------------------------------------------------

export interface SkillUse {
  workflow: string;
  workflowLabel: string;
  node: string;
  nodeLabel: string;
  gate?: string;
}

export interface SkillGuideEntry extends SkillDoc {
  /** Where this skill runs inside the installed workflows. */
  usedBy: SkillUse[];
  runs: number;
  successRate: number | null;
  averageDurationMs: number | null;
  lastRunAt: string | null;
}

export interface SkillGuide {
  /** Absolute path the skills were read from — the guide is what is installed. */
  skillsDir: string;
  skills: SkillGuideEntry[];
}

function skillUses(runtime: WorkflowRuntime): Map<string, SkillUse[]> {
  const uses = new Map<string, SkillUse[]>();
  for (const workflow of runtime.workflows().values()) {
    for (const node of workflow.nodes) {
      if (!node.skill) continue;
      const use: SkillUse = {
        workflow: workflow.id,
        workflowLabel: workflow.label,
        node: node.id,
        nodeLabel: node.label,
      };
      if (node.gate) use.gate = node.gate;
      uses.set(node.skill, [...(uses.get(node.skill) ?? []), use]);
    }
  }
  return uses;
}

/**
 * The guide the monitor shows: every installed skill, how it is invoked, where
 * it runs, and how it has actually performed. Documentation read from the same
 * files Claude Code reads, so it cannot drift from what is installed.
 */
export function buildSkillGuide(runtime: WorkflowRuntime, opts: { name?: string } = {}): SkillGuide {
  const uses = skillUses(runtime);
  const analytics = buildAnalytics(runtime);
  const docs = opts.name
    ? [runtime.skill(opts.name)].filter((doc): doc is SkillDoc => Boolean(doc))
    : runtime.skills();

  return {
    skillsDir: skillsDir(runtime.paths.projectRoot),
    skills: docs.map((doc) => {
      const stat = analytics.skills.find((s) => s.skill === doc.name);
      return {
        ...doc,
        usedBy: uses.get(doc.name) ?? [],
        runs: stat?.runs ?? 0,
        successRate: stat?.successRate ?? null,
        averageDurationMs: stat?.averageDurationMs ?? null,
        lastRunAt: stat?.lastRunAt ?? null,
      };
    }),
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

/** A rate over runs that actually finished; unfinished runs are not failures. */
function rate(entries: RunIndexEntry[]): number | null {
  const finished = entries.filter((e) => ['COMPLETED', 'FAILED', 'ABANDONED'].includes(e.status));
  if (!finished.length) return null;
  return finished.filter((e) => e.status === 'COMPLETED').length / finished.length;
}

function durations(entries: RunIndexEntry[]): number[] {
  return entries.map((e) => e.durationMs).filter((d): d is number => typeof d === 'number' && d > 0);
}

/**
 * Aggregates over the derived index. Every number traces back to a persisted
 * run; anything the runtime cannot measure (tokens, cost) stays null.
 */
export function buildAnalytics(runtime: WorkflowRuntime): Analytics {
  const entries = runtime.syncIndex();
  const byWorkflow = new Map<string, RunIndexEntry[]>();
  const bySkill = new Map<string, RunIndexEntry[]>();
  for (const entry of entries) {
    byWorkflow.set(entry.workflow, [...(byWorkflow.get(entry.workflow) ?? []), entry]);
    for (const skill of entry.skills) {
      bySkill.set(skill, [...(bySkill.get(skill) ?? []), entry]);
    }
  }

  const usageEntries = entries.filter((e) => e.usageAvailable);
  return {
    totalRuns: entries.length,
    active: entries.filter((e) => !['COMPLETED', 'FAILED', 'ABANDONED'].includes(e.status)).length,
    blocked: entries.filter((e) => e.pendingCheckpoints > 0).length,
    completed: entries.filter((e) => e.status === 'COMPLETED').length,
    failed: entries.filter((e) => e.status === 'FAILED').length,
    abandoned: entries.filter((e) => e.status === 'ABANDONED').length,
    successRate: rate(entries),
    averageDurationMs: average(durations(entries)),
    medianDurationMs: median(durations(entries)),
    workflows: [...byWorkflow.entries()]
      .map(([workflow, list]) => ({
        workflow,
        runs: list.length,
        completed: list.filter((e) => e.status === 'COMPLETED').length,
        failed: list.filter((e) => e.status === 'FAILED').length,
        abandoned: list.filter((e) => e.status === 'ABANDONED').length,
        successRate: rate(list),
        averageDurationMs: average(durations(list)),
        medianDurationMs: median(durations(list)),
      }))
      .sort((a, b) => b.runs - a.runs),
    skills: [...bySkill.entries()]
      .map(([skill, list]) => ({
        skill,
        runs: list.length,
        completed: list.filter((e) => e.status === 'COMPLETED').length,
        successRate: rate(list),
        averageDurationMs: average(durations(list)),
        lastRunAt: list.map((e) => e.startedAt).sort().at(-1) ?? null,
      }))
      .sort((a, b) => b.runs - a.runs),
    usage: {
      available: usageEntries.length > 0,
      totalTokens: usageEntries.length
        ? usageEntries.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0)
        : null,
      estimatedCost: usageEntries.length
        ? usageEntries.reduce((sum, e) => sum + (e.estimatedCost ?? 0), 0)
        : null,
    },
    generatedAt: new Date().toISOString(),
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
