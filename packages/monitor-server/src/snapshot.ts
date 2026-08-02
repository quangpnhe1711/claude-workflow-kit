import {
  WorkflowRuntime,
  derivedRunStatus,
  type RunState,
  type WorkflowDefinition,
  type WorkflowEvent,
} from '@claude-workflow-kit/workflow-core';

export interface MonitorSnapshot {
  projectRoot: string;
  runtimeDir: string;
  stallThresholdSeconds: number;
  currentRunId: string | null;
  workflows: WorkflowDefinition[];
  runs: Array<RunState & { derivedStatus: string }>;
  generatedAt: string;
}

export interface RunDetail {
  run: RunState & { derivedStatus: string };
  workflow: WorkflowDefinition;
  events: WorkflowEvent[];
  artifacts: string[];
}

export function buildSnapshot(runtime: WorkflowRuntime): MonitorSnapshot {
  const now = new Date().toISOString();
  const threshold = runtime.config.stallThresholdSeconds;
  const runs = runtime
    .runIds()
    .map((id) => {
      try {
        return runtime.run(id);
      } catch {
        return undefined;
      }
    })
    .filter((r): r is RunState => Boolean(r))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((run) => ({ ...run, derivedStatus: derivedRunStatus(run, threshold, now) }));

  return {
    projectRoot: runtime.paths.projectRoot,
    runtimeDir: runtime.paths.runtimeDir,
    stallThresholdSeconds: threshold,
    currentRunId: runtime.currentRunId() ?? null,
    workflows: [...runtime.workflows().values()],
    runs,
    generatedAt: now,
  };
}

export function buildRunDetail(runtime: WorkflowRuntime, runId: string): RunDetail {
  const run = runtime.run(runId);
  const now = new Date().toISOString();
  return {
    run: { ...run, derivedStatus: derivedRunStatus(run, runtime.config.stallThresholdSeconds, now) },
    workflow: runtime.workflow(run.workflow),
    events: runtime.events(runId, 500),
    artifacts: runtime.artifacts(runId),
  };
}

/**
 * Cheap change signature. The server polls this instead of watching the
 * filesystem: one mechanism, and it works the same on every platform.
 */
export function snapshotSignature(snapshot: MonitorSnapshot): string {
  return [
    snapshot.currentRunId ?? '-',
    ...snapshot.runs.map((r) => `${r.runId}:${r.updatedAt}:${r.status}:${r.currentNode}:${r.runtime.claude}`),
  ].join('|');
}
