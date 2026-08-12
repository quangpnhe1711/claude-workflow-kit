/**
 * Derived history index — one compact line per run.
 *
 * The live monitor used to read every `state.json` on every tick, which is fine
 * for five runs and wrong for five hundred. History now answers from this index;
 * only the run a user actually opens gets its full state and events loaded.
 *
 * It is a cache with a staleness check, not a store: every field is recomputed
 * from `state.json`, and `cw index rebuild` throws it away and regenerates it.
 * Nothing in the workflow engine reads it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { missionHealthReport, missionProgress, pendingCheckpoints } from './mission.js';
import type { RunRollup } from './rollup.js';
import type { RuntimePaths } from './store.js';
import type { RunState, RunStatus, WorkflowDefinition } from './types.js';

export interface RunIndexEntry {
  runId: string;
  workflow: string;
  label?: string;
  status: RunStatus;
  currentNode: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  lastActivityAt: string;
  durationMs: number | null;
  /** Skills that actually ran, from the phases this run entered. */
  skills: string[];
  missionState?: string;
  workflowClass?: string;
  taskType?: string;
  health?: string;
  pendingCheckpoints: number;
  progressPercent: number;
  /** Filled once a run is terminal and its rollup is frozen; null while live. */
  filesChanged: number | null;
  toolCalls: number | null;
  usageAvailable: boolean;
  totalTokens: number | null;
  estimatedCost: number | null;
  /** `state.json` mtime when this entry was built — the staleness check. */
  stateMtimeMs: number;
}

/** Build one entry. Pure: state (+ optional definition and rollup) in, row out. */
export function indexEntry(
  run: RunState,
  opts: { definition?: WorkflowDefinition; rollup?: RunRollup; stateMtimeMs?: number } = {},
): RunIndexEntry {
  const skills = (opts.definition?.nodes ?? [])
    .filter((node) => node.skill && (run.nodes[node.id]?.visits ?? 0) > 0)
    .map((node) => node.skill!)
    .filter((skill, i, all) => all.indexOf(skill) === i);

  const entry: RunIndexEntry = {
    runId: run.runId,
    workflow: run.workflow,
    status: run.status,
    currentNode: run.currentNode,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    lastActivityAt: run.lastActivityAt,
    durationMs: run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null,
    skills,
    pendingCheckpoints: 0,
    progressPercent: 0,
    filesChanged: opts.rollup ? opts.rollup.files.changed : null,
    toolCalls: opts.rollup ? opts.rollup.tools.calls : null,
    usageAvailable: opts.rollup?.usage.available ?? false,
    totalTokens: opts.rollup?.usage.totalTokens ?? null,
    estimatedCost: opts.rollup?.usage.estimatedCost ?? null,
    stateMtimeMs: opts.stateMtimeMs ?? 0,
  };
  if (run.label) entry.label = run.label;
  if (run.finishedAt) entry.finishedAt = run.finishedAt;

  const mission = run.mission;
  if (mission) {
    entry.missionState = mission.state;
    entry.health = missionHealthReport(mission).health;
    entry.progressPercent = missionProgress(mission).percent;
    entry.pendingCheckpoints = pendingCheckpoints(mission).length;
    if (mission.classification) {
      entry.workflowClass = mission.classification.workflowClass;
      entry.taskType = mission.classification.taskType;
    }
  }
  return entry;
}

export function readRunIndex(paths: RuntimePaths): RunIndexEntry[] {
  const file = paths.runIndexFile;
  if (!existsSync(file)) return [];
  const out: RunIndexEntry[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as RunIndexEntry;
      if (entry && typeof entry.runId === 'string') out.push(entry);
    } catch {
      // A damaged line costs one row of history, never the index.
    }
  }
  return out;
}

export function writeRunIndex(paths: RuntimePaths, entries: RunIndexEntry[]): void {
  mkdirSync(paths.indexDir, { recursive: true });
  const sorted = [...entries].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const body = sorted.map((entry) => JSON.stringify(entry)).join('\n');
  // Same tmp+rename discipline as state.json: a half-written index is an index
  // that reports runs which do not exist.
  const file = paths.runIndexFile;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
  renameSync(tmp, file);
}

export interface IndexSyncDeps {
  runIds: () => string[];
  readRun: (runId: string) => RunState | undefined;
  definition: (workflowId: string) => WorkflowDefinition | undefined;
  /** Rollup for a terminal run, or undefined to leave its counts unavailable. */
  rollup?: (run: RunState) => RunRollup | undefined;
}

export interface IndexSyncResult {
  entries: RunIndexEntry[];
  changed: boolean;
  scanned: number;
  refreshed: number;
}

/**
 * Refresh the index in place. A run whose `state.json` mtime has not moved since
 * it was indexed is not re-read, so the steady-state cost is one `stat` per run.
 */
export function syncRunIndex(
  paths: RuntimePaths,
  deps: IndexSyncDeps,
  opts: { force?: boolean } = {},
): IndexSyncResult {
  const previous = new Map(opts.force ? [] : readRunIndex(paths).map((e) => [e.runId, e]));
  const ids = deps.runIds();
  const entries: RunIndexEntry[] = [];
  let changed = opts.force === true;
  let refreshed = 0;

  for (const runId of ids) {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(paths.stateFile(runId)).mtimeMs;
    } catch {
      continue;
    }
    const cached = previous.get(runId);
    if (cached && cached.stateMtimeMs === mtimeMs) {
      entries.push(cached);
      previous.delete(runId);
      continue;
    }
    const run = deps.readRun(runId);
    // An unreadable run is reported by the snapshot's corrupt list; it must not
    // silently vanish from history, but there is nothing to index.
    if (!run) continue;
    const definition = deps.definition(run.workflow);
    const rollup = deps.rollup?.(run);
    const built: Parameters<typeof indexEntry>[1] = { stateMtimeMs: mtimeMs };
    if (definition) built.definition = definition;
    if (rollup) built.rollup = rollup;
    entries.push(indexEntry(run, built));
    changed = true;
    refreshed += 1;
    previous.delete(runId);
  }

  // Anything left in `previous` is a run whose directory is gone.
  if (previous.size) changed = true;
  if (changed) writeRunIndex(paths, entries);
  return { entries, changed, scanned: ids.length, refreshed };
}

// ---- queries ---------------------------------------------------------------

export interface RunQuery {
  status?: string[];
  workflow?: string;
  skill?: string;
  /** Case-insensitive match against run id and label. */
  q?: string;
  since?: string;
  until?: string;
  sort?: 'started' | 'duration' | 'updated';
  order?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

export interface RunPage {
  runs: RunIndexEntry[];
  total: number;
  offset: number;
  limit: number;
}

export function queryRuns(entries: RunIndexEntry[], query: RunQuery = {}): RunPage {
  const text = query.q?.trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    if (query.status?.length && !query.status.includes(entry.status)) return false;
    if (query.workflow && entry.workflow !== query.workflow) return false;
    if (query.skill && !entry.skills.includes(query.skill)) return false;
    if (query.since && entry.startedAt < query.since) return false;
    if (query.until && entry.startedAt > query.until) return false;
    if (text && !`${entry.runId} ${entry.label ?? ''}`.toLowerCase().includes(text)) return false;
    return true;
  });

  const order = query.order === 'asc' ? 1 : -1;
  const sorted = [...filtered].sort((a, b) => {
    if (query.sort === 'duration') return ((a.durationMs ?? 0) - (b.durationMs ?? 0)) * order;
    if (query.sort === 'updated') return a.updatedAt.localeCompare(b.updatedAt) * order;
    return a.startedAt.localeCompare(b.startedAt) * order;
  });

  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.max(1, Math.min(query.limit ?? 25, 200));
  return { runs: sorted.slice(offset, offset + limit), total: sorted.length, offset, limit };
}
