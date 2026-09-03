/**
 * One `WorkflowRuntime` per registered project, created on first use.
 *
 * A runtime reads `config.json` once in its constructor, so a config edited
 * through the app (or by hand) would otherwise be invisible until restart. The
 * cache therefore keys on the config file's mtime+size and rebuilds when that
 * changes — cheap, and it keeps "save settings" honest.
 */
import { existsSync, statSync } from 'node:fs';
import { WorkflowRuntime } from '@claude-workflow-kit/workflow-core';
import { HttpError } from '@claude-workflow-kit/monitor-server';
import { RuntimePaths } from '@claude-workflow-kit/workflow-core';
import type { ProjectEntry, Workspace } from './workspace.js';

/** A project in the registry whose directory no longer exists on disk. */
export class ProjectUnavailableError extends HttpError {}

function configStamp(projectRoot: string, runtimeDir: string): string {
  const file = new RuntimePaths(projectRoot, runtimeDir).configFile;
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'absent';
  }
}

interface CacheEntry {
  runtime: WorkflowRuntime;
  stamp: string;
  path: string;
  runtimeDir: string;
}

export class RuntimeRegistry {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly workspace: Workspace) {}

  /** The entry for `id`, or a 404-shaped error naming what went wrong. */
  project(id: string): ProjectEntry {
    const entry = this.workspace.find(id);
    if (!entry) throw new HttpError(`unknown project "${id}"`, 404);
    return entry;
  }

  /**
   * The runtime for `id`. Throws 409 when the directory has gone away rather
   * than letting `WorkflowRuntime` create a runtime over a missing project —
   * a moved or deleted repo should be reported, not silently re-created.
   */
  runtime(id: string): WorkflowRuntime {
    const entry = this.project(id);
    if (!existsSync(entry.path)) {
      throw new ProjectUnavailableError(
        `project "${entry.name}" is registered at ${entry.path}, which no longer exists`,
        409,
      );
    }
    const stamp = configStamp(entry.path, entry.runtimeDir);
    const cached = this.cache.get(id);
    if (
      cached &&
      cached.stamp === stamp &&
      cached.path === entry.path &&
      cached.runtimeDir === entry.runtimeDir
    ) {
      return cached.runtime;
    }
    const runtime = new WorkflowRuntime({ projectRoot: entry.path, runtimeDir: entry.runtimeDir });
    this.cache.set(id, { runtime, stamp, path: entry.path, runtimeDir: entry.runtimeDir });
    return runtime;
  }

  /** Drop a cached runtime — after an install, a config write, or a removal. */
  invalidate(id: string): void {
    this.cache.delete(id);
  }

  clear(): void {
    this.cache.clear();
  }
}
