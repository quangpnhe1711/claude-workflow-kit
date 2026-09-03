/**
 * A registered project, summarised for the switcher.
 *
 * The counting lives in `monitor-server` so that `cw monitor` and `cw app`
 * produce the same shape; what belongs here is everything the registry knows and
 * a lone runtime does not — whether the directory still exists, and whether the
 * kit was ever installed in it.
 */
import { existsSync } from 'node:fs';
import { emptySummary, summariseRuntime, type ProjectIdentity } from '@claude-workflow-kit/monitor-server';
import type { RuntimeRegistry } from './runtimes.js';
import { inspectProject, type ProjectEntry } from './workspace.js';

export {
  summarySignature,
  type ProjectSummary,
  type ProjectIdentity,
} from '@claude-workflow-kit/monitor-server';

export function projectSummary(registry: RuntimeRegistry, entry: ProjectEntry) {
  const identity: ProjectIdentity = {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    runtimeDir: entry.runtimeDir,
    available: existsSync(entry.path),
    installed: false,
  };
  if (!identity.available) return emptySummary(identity, 'directory no longer exists');

  const inspection = inspectProject(entry);
  identity.installed = inspection.installed;
  if (inspection.preset) identity.preset = inspection.preset;
  if (inspection.monitorPort) identity.monitorPort = inspection.monitorPort;

  // A project that was registered but never installed has nothing to count, and
  // opening a runtime over it would create the directory as a side effect.
  if (!inspection.installed) return emptySummary(identity);

  try {
    return summariseRuntime(registry.runtime(entry.id), identity);
  } catch (error) {
    return emptySummary(identity, error instanceof Error ? error.message : String(error));
  }
}
