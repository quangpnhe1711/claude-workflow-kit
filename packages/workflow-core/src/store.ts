import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_CONFIG, type KitConfig, type RunState, type WorkflowEvent } from './types.js';

export class RunNotFoundError extends Error {}

/** Filesystem layout of the project-local runtime directory. */
export class RuntimePaths {
  readonly projectRoot: string;
  readonly runtimeDir: string;

  constructor(projectRoot: string, runtimeDir: string) {
    this.projectRoot = resolve(projectRoot);
    this.runtimeDir = resolve(this.projectRoot, runtimeDir);
  }

  get configFile() {
    return join(this.runtimeDir, 'config.json');
  }
  get runsDir() {
    return join(this.runtimeDir, 'runs');
  }
  get conventionsDir() {
    return join(this.runtimeDir, 'conventions');
  }
  get currentRunFile() {
    return join(this.runtimeDir, 'current-run');
  }
  get hookErrorLog() {
    return join(this.runtimeDir, 'hook-errors.log');
  }
  runDir(runId: string) {
    return join(this.runsDir, runId);
  }
  stateFile(runId: string) {
    return join(this.runDir(runId), 'state.json');
  }
  eventsFile(runId: string) {
    return join(this.runDir(runId), 'events.jsonl');
  }
}

/**
 * Walk up from `start` looking for an existing runtime directory, then fall
 * back to a directory that looks like a project root, then to `start`.
 */
export function findProjectRoot(start = process.cwd(), runtimeDir = DEFAULT_CONFIG.runtimeDir): string {
  let dir = resolve(start);
  const markers = ['.git', 'CLAUDE.md', '.claude', 'package.json'];
  let fallback: string | undefined;
  for (;;) {
    if (existsSync(join(dir, runtimeDir))) return dir;
    if (!fallback && markers.some((m) => existsSync(join(dir, m)))) fallback = dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return fallback ?? resolve(start);
}

export function readConfig(paths: RuntimePaths): KitConfig {
  if (!existsSync(paths.configFile)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(paths.configFile, 'utf8')) as Partial<KitConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(paths: RuntimePaths, config: KitConfig): void {
  mkdirSync(paths.runtimeDir, { recursive: true });
  writeJsonAtomic(paths.configFile, config);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export function listRunIds(paths: RuntimePaths): string[] {
  if (!existsSync(paths.runsDir)) return [];
  return readdirSync(paths.runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(paths.runsDir, d.name, 'state.json')))
    .map((d) => d.name)
    .sort();
}

export function readRun(paths: RuntimePaths, runId: string): RunState {
  const file = paths.stateFile(runId);
  if (!existsSync(file)) throw new RunNotFoundError(`run "${runId}" not found at ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as RunState;
}

export function tryReadRun(paths: RuntimePaths, runId: string): RunState | undefined {
  try {
    return readRun(paths, runId);
  } catch {
    return undefined;
  }
}

export function writeRun(paths: RuntimePaths, run: RunState): void {
  mkdirSync(paths.runDir(run.runId), { recursive: true });
  writeJsonAtomic(paths.stateFile(run.runId), run);
}

export function appendEvent(paths: RuntimePaths, event: WorkflowEvent): void {
  mkdirSync(paths.runDir(event.runId), { recursive: true });
  appendFileSync(paths.eventsFile(event.runId), `${JSON.stringify(event)}\n`, 'utf8');
}

export function readEvents(paths: RuntimePaths, runId: string, limit?: number): WorkflowEvent[] {
  const file = paths.eventsFile(runId);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const slice = limit ? lines.slice(-limit) : lines;
  const events: WorkflowEvent[] = [];
  for (const line of slice) {
    try {
      events.push(JSON.parse(line) as WorkflowEvent);
    } catch {
      // A partially written last line is expected while a run is live.
    }
  }
  return events;
}

export function readCurrentRunId(paths: RuntimePaths): string | undefined {
  if (!existsSync(paths.currentRunFile)) return undefined;
  const id = readFileSync(paths.currentRunFile, 'utf8').trim();
  return id || undefined;
}

export function writeCurrentRunId(paths: RuntimePaths, runId: string | undefined): void {
  mkdirSync(paths.runtimeDir, { recursive: true });
  if (!runId) {
    rmSync(paths.currentRunFile, { force: true });
    return;
  }
  writeFileSync(paths.currentRunFile, `${runId}\n`, 'utf8');
}

/** Artifacts present in a run directory, excluding the machine-owned files. */
export function listArtifacts(paths: RuntimePaths, runId: string): string[] {
  const dir = paths.runDir(runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f !== 'state.json' && f !== 'events.jsonl' && !f.endsWith('.tmp'))
    .sort();
}

export function runMtimeMs(paths: RuntimePaths, runId: string): number {
  try {
    return statSync(paths.stateFile(runId)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * `fc-20260802-001` — workflow prefix, date, per-day counter. Stable, sortable
 * and readable in a directory listing.
 */
export function nextRunId(paths: RuntimePaths, workflowId: string, now: Date): string {
  const prefix = workflowId
    .split(/[-_]/)
    .map((part) => part[0] ?? '')
    .join('')
    .toLowerCase() || 'wf';
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const base = `${prefix}-${date}`;
  const existing = listRunIds(paths).filter((id) => id.startsWith(`${base}-`));
  let n = existing.length + 1;
  let candidate = `${base}-${String(n).padStart(3, '0')}`;
  while (existsSync(paths.runDir(candidate))) {
    n += 1;
    candidate = `${base}-${String(n).padStart(3, '0')}`;
  }
  return candidate;
}
