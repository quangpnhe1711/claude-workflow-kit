/**
 * Analytics across every registered project.
 *
 * Per-project analytics already exist (`/api/projects/:id/analytics`); this is
 * the question a single-project monitor cannot answer — how much work is in
 * flight, and where. Rates are recomputed from the summed counts rather than
 * averaged across projects, so a repository with three runs cannot weigh as much
 * as one with three hundred.
 *
 * A project that cannot be read contributes its error and no numbers. Nothing
 * here substitutes a zero for a measurement that is missing.
 */
import { buildAnalytics } from '@claude-workflow-kit/monitor-server';
import type { RuntimeRegistry } from './runtimes.js';
import { inspectProject, type ProjectEntry } from './workspace.js';

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
    /** Null unless at least one project could measure usage. */
    totalTokens: number | null;
    estimatedCost: number | null;
  };
}

export function workspaceAnalytics(
  registry: RuntimeRegistry,
  entries: ProjectEntry[],
): WorkspaceAnalytics {
  const rows: ProjectAnalyticsRow[] = [];

  for (const entry of entries) {
    const base = { id: entry.id, name: entry.name };
    if (!inspectProject(entry).installed) {
      rows.push({
        ...base,
        totalRuns: 0,
        active: 0,
        blocked: 0,
        completed: 0,
        failed: 0,
        abandoned: 0,
        successRate: null,
        averageDurationMs: null,
        totalTokens: null,
        estimatedCost: null,
        error: 'the kit is not installed here',
      });
      continue;
    }
    try {
      const analytics = buildAnalytics(registry.runtime(entry.id));
      rows.push({
        ...base,
        totalRuns: analytics.totalRuns,
        active: analytics.active,
        blocked: analytics.blocked,
        completed: analytics.completed,
        failed: analytics.failed,
        abandoned: analytics.abandoned,
        successRate: analytics.successRate,
        averageDurationMs: analytics.averageDurationMs,
        totalTokens: analytics.usage.available ? analytics.usage.totalTokens : null,
        estimatedCost: analytics.usage.available ? analytics.usage.estimatedCost : null,
      });
    } catch (error) {
      rows.push({
        ...base,
        totalRuns: 0,
        active: 0,
        blocked: 0,
        completed: 0,
        failed: 0,
        abandoned: 0,
        successRate: null,
        averageDurationMs: null,
        totalTokens: null,
        estimatedCost: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const sum = (pick: (row: ProjectAnalyticsRow) => number) => rows.reduce((n, row) => n + pick(row), 0);
  const measured = (pick: (row: ProjectAnalyticsRow) => number | null) => {
    const values = rows.map(pick).filter((v): v is number => v !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };

  const completed = sum((r) => r.completed);
  const failed = sum((r) => r.failed);
  const abandoned = sum((r) => r.abandoned);
  const settled = completed + failed + abandoned;

  return {
    generatedAt: new Date().toISOString(),
    projects: rows,
    totals: {
      projects: entries.length,
      installed: rows.filter((row) => !row.error).length,
      totalRuns: sum((r) => r.totalRuns),
      active: sum((r) => r.active),
      blocked: sum((r) => r.blocked),
      completed,
      failed,
      abandoned,
      successRate: settled ? completed / settled : null,
      totalTokens: measured((r) => r.totalTokens),
      estimatedCost: measured((r) => r.estimatedCost),
    },
  };
}
