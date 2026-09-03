/**
 * The one-line-per-project view the app's switcher reads.
 *
 * It lives here rather than in the app package because the single-project
 * monitor serves the same UI bundle, and that bundle asks for a project list
 * whether it is talking to `cw app` or `cw monitor`. One definition means the
 * monitor's "workspace of one" and the app's real workspace cannot drift into
 * two shapes the UI has to tell apart.
 *
 * It is built from the derived run index and never from `state.json`: the app
 * recomputes this for every registered project on each tick, so the cost must
 * scale with the number of projects, not the size of anyone's run archive.
 */
import { isTerminalRun, type WorkflowRuntime } from '@claude-workflow-kit/workflow-core';

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  runtimeDir: string;
  /** The directory exists and can be opened. */
  available: boolean;
  /** The kit is installed there (`config.json` present). */
  installed: boolean;
  preset?: string;
  monitorPort?: number;
  activeRuns: number;
  waitingRuns: number;
  pendingCheckpoints: number;
  totalRuns: number;
  currentRunId?: string;
  lastActivityAt?: string;
  /** Why the summary is empty, when it is. Surfaced, never swallowed. */
  error?: string;
}

/** Identity of a project, before anything has been counted. */
export type ProjectIdentity = Pick<
  ProjectSummary,
  'id' | 'name' | 'path' | 'runtimeDir' | 'available' | 'installed' | 'preset' | 'monitorPort'
>;

export function emptySummary(identity: ProjectIdentity, error?: string): ProjectSummary {
  return {
    ...identity,
    activeRuns: 0,
    waitingRuns: 0,
    pendingCheckpoints: 0,
    totalRuns: 0,
    ...(error ? { error } : {}),
  };
}

/** Fold the run index into counts. A runtime that cannot be read says why. */
export function summariseRuntime(runtime: WorkflowRuntime, identity: ProjectIdentity): ProjectSummary {
  const summary = emptySummary(identity);
  try {
    const index = runtime.syncIndex();
    let lastActivityAt: string | undefined;
    for (const row of index) {
      if (!isTerminalRun(row.status)) {
        if (row.status === 'WAITING_USER') summary.waitingRuns += 1;
        else summary.activeRuns += 1;
      }
      summary.pendingCheckpoints += row.pendingCheckpoints;
      if (!lastActivityAt || row.lastActivityAt > lastActivityAt) lastActivityAt = row.lastActivityAt;
    }
    summary.totalRuns = index.length;
    if (lastActivityAt) summary.lastActivityAt = lastActivityAt;
    const current = runtime.currentRunId();
    if (current) summary.currentRunId = current;
    return summary;
  } catch (error) {
    return emptySummary(identity, error instanceof Error ? error.message : String(error));
  }
}

/** Cheap equality for the SSE tick: resend the workspace frame only on change. */
export function summarySignature(summaries: ProjectSummary[]): string {
  return summaries
    .map((s) =>
      [
        s.id,
        s.available ? 1 : 0,
        s.installed ? 1 : 0,
        s.activeRuns,
        s.waitingRuns,
        s.pendingCheckpoints,
        s.totalRuns,
        s.currentRunId ?? '',
        s.lastActivityAt ?? '',
        s.error ?? '',
      ].join(':'),
    )
    .join('|');
}
