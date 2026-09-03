import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { MISSION_STATES } from './mission.js';
import {
  DEFAULT_CONFIG,
  type InvalidArtifact,
  type KitConfig,
  type PolicyHealth,
  type RunState,
  type WorkflowEvent,
} from './types.js';

export class RunNotFoundError extends Error {}

/**
 * `state.json` exists but cannot be read as a run. Kept distinct from
 * RunNotFoundError: "no run" and "broken run" need opposite recoveries, and
 * reporting the second as the first is what makes a workflow silently fork.
 */
export class RunStateCorruptError extends Error {
  readonly runId: string;
  readonly file: string;
  constructor(runId: string, file: string, cause: unknown) {
    super(`run "${runId}" state is corrupt at ${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.runId = runId;
    this.file = file;
  }
}

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
  /**
   * Scoped repository knowledge. It lives beside the skills that read it rather
   * than in the runtime directory: it is committed repository documentation, not
   * machine-local run state.
   */
  get instructionsDir() {
    return join(this.projectRoot, '.claude', 'instructions');
  }
  get currentRunFile() {
    return join(this.runtimeDir, 'current-run');
  }
  get sessionsFile() {
    return join(this.runtimeDir, 'sessions.json');
  }
  get hookErrorLog() {
    return join(this.runtimeDir, 'hook-errors.log');
  }
  get policyHealthFile() {
    return join(this.runtimeDir, 'policy-health.json');
  }
  get quarantineLog() {
    return join(this.runtimeDir, 'quarantine.jsonl');
  }
  runDir(runId: string) {
    return join(this.runsDir, runId);
  }
  quarantineMarker(runId: string) {
    return join(this.runDir(runId), 'QUARANTINED');
  }
  stateFile(runId: string) {
    return join(this.runDir(runId), 'state.json');
  }
  eventsFile(runId: string) {
    return join(this.runDir(runId), 'events.jsonl');
  }
  /** Derived per-run summary. Cache only: safe to delete, rebuilt on demand. */
  rollupFile(runId: string) {
    return join(this.runDir(runId), 'rollup.json');
  }
  /** Derived read model for history. Safe to delete; `cw index rebuild` restores it. */
  get indexDir() {
    return join(this.runtimeDir, 'index');
  }
  get runIndexFile() {
    return join(this.indexDir, 'runs.jsonl');
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
    // A project installed with `--runtime <dir>` records the name it chose.
    const pointed = readRuntimePointer(dir);
    if (pointed && existsSync(join(dir, pointed))) return dir;
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

/** Backfill fields added after a run was first written. */
function normaliseRun(run: RunState): RunState {
  if (!run.lastSemanticAt) run.lastSemanticAt = run.updatedAt ?? run.startedAt;
  if (!Array.isArray(run.artifacts)) run.artifacts = [];
  // A mission written by an older kit may lack collections added later. Reading
  // them as empty is correct; leaving them undefined makes every consumer guard.
  if (run.mission) {
    const mission = run.mission;
    mission.confidence ??= {};
    mission.evidence ??= {};
    mission.risks ??= [];
    mission.decisions ??= [];
    mission.tasks ??= [];
    mission.checkpoints ??= [];
    mission.deliverables ??= [];
    mission.scopeChanges ??= [];
    mission.acceptances ??= [];
  }
  return run;
}

const RUN_STATUSES = ['RUNNING', 'WAITING_USER', 'COMPLETED', 'FAILED', 'ABANDONED'];
const NODE_STATUSES = ['PENDING', 'ACTIVE', 'WAITING_USER', 'COMPLETED', 'FAILED', 'SKIPPED'];
const GATE_STATUSES = ['OPEN', 'WAITING', 'PASSED', 'FAILED'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Parseable JSON is not a run. A state file with a missing `nodes` map or an
 * invented status is corrupt in exactly the way that matters — every consumer
 * downstream would read it as a working run and quietly do the wrong thing — so
 * the check lives at the storage boundary where nothing can skip it.
 */
export function validateRunState(parsed: unknown): string | undefined {
  if (!isPlainObject(parsed)) return 'not an object';
  for (const key of ['runId', 'workflow', 'status', 'currentNode', 'startedAt'] as const) {
    if (typeof parsed[key] !== 'string' || !(parsed[key] as string).length) {
      return `"${key}" must be a non-empty string`;
    }
  }
  if (!RUN_STATUSES.includes(parsed['status'] as string)) return `unknown run status "${String(parsed['status'])}"`;
  if (!isPlainObject(parsed['nodes'])) return '"nodes" must be an object';
  for (const [id, state] of Object.entries(parsed['nodes'] as Record<string, unknown>)) {
    if (!isPlainObject(state)) return `node "${id}" is not an object`;
    if (!NODE_STATUSES.includes(state['status'] as string)) {
      return `node "${id}" has unknown status "${String(state['status'])}"`;
    }
    if (typeof state['visits'] !== 'number' || !Number.isFinite(state['visits'])) {
      return `node "${id}" has a non-numeric visits count`;
    }
  }
  if (!isPlainObject(parsed['gates'])) return '"gates" must be an object';
  for (const [gate, status] of Object.entries(parsed['gates'] as Record<string, unknown>)) {
    if (!GATE_STATUSES.includes(status as string)) {
      return `gate "${gate}" has unknown status "${String(status)}"`;
    }
  }
  if (!isPlainObject(parsed['runtime'])) return '"runtime" must be an object';
  if (typeof (parsed['runtime'] as Record<string, unknown>)['claude'] !== 'string') {
    return '"runtime.claude" must be a string';
  }
  if (!isPlainObject(parsed['agents'])) return '"agents" must be an object';
  if (!(parsed['nodes'] as Record<string, unknown>)[parsed['currentNode'] as string]) {
    return `currentNode "${String(parsed['currentNode'])}" has no entry in "nodes"`;
  }
  const mission = parsed['mission'];
  if (mission !== undefined) {
    if (!isPlainObject(mission)) return '"mission" must be an object';
    if (!MISSION_STATES.includes(mission['state'] as never)) {
      return `unknown mission state "${String(mission['state'])}"`;
    }
    // A mission whose collections are not collections would read as an empty
    // board — the one failure mode that looks like a healthy run.
    for (const key of ['risks', 'decisions', 'tasks', 'checkpoints', 'deliverables'] as const) {
      if (mission[key] !== undefined && !Array.isArray(mission[key])) {
        return `"mission.${key}" must be an array`;
      }
    }
    for (const key of ['confidence', 'evidence'] as const) {
      if (mission[key] !== undefined && !isPlainObject(mission[key])) {
        return `"mission.${key}" must be an object`;
      }
    }
  }
  return undefined;
}

export function readRun(paths: RuntimePaths, runId: string): RunState {
  const file = paths.stateFile(runId);
  if (!existsSync(file)) throw new RunNotFoundError(`run "${runId}" not found at ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new RunStateCorruptError(runId, file, error);
  }
  const invalid = validateRunState(parsed);
  if (invalid) throw new RunStateCorruptError(runId, file, new Error(invalid));
  return normaliseRun(parsed as RunState);
}

/** A run explicitly retired by `cw run quarantine-current`. */
export function isQuarantined(paths: RuntimePaths, runId: string): boolean {
  return existsSync(paths.quarantineMarker(runId));
}

/**
 * Retire an unreadable run without ever deserialising it. The corrupt files stay
 * exactly where they are — they are the only evidence of what happened — and the
 * audit record goes somewhere that is guaranteed writable.
 */
export function quarantineRun(paths: RuntimePaths, runId: string, reason: string): { marker: string } {
  const dir = paths.runDir(runId);
  if (!existsSync(dir)) throw new RunNotFoundError(`run "${runId}" not found at ${dir}`);
  const at = new Date().toISOString();
  writeFileSync(paths.quarantineMarker(runId), `${at} ${reason}\n`, 'utf8');
  mkdirSync(paths.runtimeDir, { recursive: true });
  appendFileSync(
    paths.quarantineLog,
    `${JSON.stringify({ ts: at, runId, reason, stateFile: paths.stateFile(runId) })}\n`,
    'utf8',
  );
  return { marker: paths.quarantineMarker(runId) };
}

/**
 * Missing run -> undefined. A corrupt run still throws: the caller has to
 * decide, and silently treating it as "no run" loses the run.
 */
export function tryReadRun(paths: RuntimePaths, runId: string): RunState | undefined {
  try {
    return readRun(paths, runId);
  } catch (error) {
    if (error instanceof RunStateCorruptError) throw error;
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

function parseEventLines(lines: string[]): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as WorkflowEvent);
    } catch {
      // A partially written last line is expected while a run is live.
    }
  }
  return events;
}

/** Bytes of the event log. The cursor space for pagination, and the cache key. */
export function eventsSize(paths: RuntimePaths, runId: string): number {
  try {
    return statSync(paths.eventsFile(runId)).size;
  } catch {
    return 0;
  }
}

const TAIL_CHUNK = 64 * 1024;

/**
 * Read a window of the event log without loading the file.
 *
 * `events.jsonl` is append-only and unbounded, so the byte offset of a line is a
 * stable cursor: the bytes before it never change. Reading the tail costs one
 * chunk regardless of how long the run has been going.
 */
function readWindow(file: string, start: number, end: number): string {
  const length = Math.max(0, end - start);
  if (!length) return '';
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function readEvents(paths: RuntimePaths, runId: string, limit?: number): WorkflowEvent[] {
  const file = paths.eventsFile(runId);
  if (!existsSync(file)) return [];
  if (limit === undefined) return parseEventLines(readFileSync(file, 'utf8').split('\n'));

  // Tail: grow the window backwards until it holds enough whole lines.
  const size = statSync(file).size;
  let start = Math.max(0, size - TAIL_CHUNK);
  for (;;) {
    const text = readWindow(file, start, size);
    const lines = text.split('\n');
    // A window that does not begin at byte 0 starts mid-line; drop that fragment.
    if (start > 0) lines.shift();
    const complete = lines.filter(Boolean);
    if (complete.length >= limit || start === 0) return parseEventLines(complete.slice(-limit));
    start = Math.max(0, start - TAIL_CHUNK);
  }
}

export interface EventPage {
  events: WorkflowEvent[];
  /** Byte offset to pass as `after` for the next page. */
  cursor: number;
  /** Current size of the log; `cursor === size` means the caller is caught up. */
  size: number;
  hasMore: boolean;
}

/**
 * Forward pagination from a byte cursor. `after: 0` starts at the beginning;
 * the returned cursor is where the next page begins.
 */
export function readEventPage(
  paths: RuntimePaths,
  runId: string,
  opts: { after?: number; limit?: number } = {},
): EventPage {
  const file = paths.eventsFile(runId);
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  if (!existsSync(file)) return { events: [], cursor: 0, size: 0, hasMore: false };
  const size = statSync(file).size;
  let cursor = Math.max(0, Math.min(opts.after ?? 0, size));
  const lines: string[] = [];
  let carry = '';

  while (lines.length < limit && cursor < size) {
    const end = Math.min(cursor + TAIL_CHUNK, size);
    const text = carry + readWindow(file, cursor, end);
    const consumedFrom = cursor - carry.length;
    const parts = text.split('\n');
    // The last part is either a partial line or an empty string after the final
    // newline; either way it belongs to the next read.
    carry = parts.pop() ?? '';
    let offset = consumedFrom;
    for (const part of parts) {
      offset += Buffer.byteLength(part, 'utf8') + 1;
      if (!part) continue;
      lines.push(part);
      if (lines.length >= limit) {
        return {
          events: parseEventLines(lines),
          cursor: offset,
          size,
          hasMore: offset < size,
        };
      }
    }
    cursor = end;
  }

  return {
    events: parseEventLines(lines),
    // A trailing partial line is not consumed: the next call re-reads it whole.
    cursor: size - Buffer.byteLength(carry, 'utf8'),
    size,
    hasMore: false,
  };
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

/**
 * sessionId -> runId. The global `current-run` pointer stays (the CLI has no
 * session context), but a hook resolves its own session first, so two Claude
 * sessions in one repo cannot write to each other's run.
 */
export type SessionMap = Record<string, { runId: string; updatedAt: string }>;

export function readSessions(paths: RuntimePaths): SessionMap {
  if (!existsSync(paths.sessionsFile)) return {};
  try {
    const raw = JSON.parse(readFileSync(paths.sessionsFile, 'utf8')) as SessionMap;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    // A broken session index only costs correlation, never the run itself.
    return {};
  }
}

export function writeSessions(paths: RuntimePaths, sessions: SessionMap): void {
  mkdirSync(paths.runtimeDir, { recursive: true });
  writeJsonAtomic(paths.sessionsFile, sessions);
}

const MACHINE_OWNED = ['state.json', 'events.jsonl', 'QUARANTINED'];

export interface ArtifactScan {
  /** Regular, non-empty files: the only ones that count as evidence. */
  valid: string[];
  /** Entries that exist but cannot serve as evidence, with the reason. */
  invalid: InvalidArtifact[];
}

/**
 * Evidence has to be a readable file with something in it. A directory named
 * `business-decision.md` and a zero-byte file both satisfied the old
 * "is the name in the listing" test, which is how a gate could be passed with no
 * evidence behind it at all.
 */
export function scanArtifacts(paths: RuntimePaths, runId: string): ArtifactScan {
  const dir = paths.runDir(runId);
  const scan: ArtifactScan = { valid: [], invalid: [] };
  if (!existsSync(dir)) return scan;
  for (const name of readdirSync(dir).sort()) {
    if (MACHINE_OWNED.includes(name) || name.endsWith('.tmp')) continue;
    let stat;
    try {
      stat = statSync(join(dir, name));
    } catch (error) {
      scan.invalid.push({ name, reason: `unreadable: ${(error as Error).message}` });
      continue;
    }
    if (stat.isDirectory()) {
      scan.invalid.push({ name, reason: 'is a directory, not an evidence file' });
      continue;
    }
    if (!stat.isFile()) {
      scan.invalid.push({ name, reason: 'is not a regular file' });
      continue;
    }
    if (stat.size === 0) {
      scan.invalid.push({ name, reason: 'is empty' });
      continue;
    }
    let content = '';
    try {
      content = readFileSync(join(dir, name), 'utf8');
    } catch (error) {
      scan.invalid.push({ name, reason: `unreadable: ${(error as Error).message}` });
      continue;
    }
    if (!content.trim().length) {
      scan.invalid.push({ name, reason: 'contains only whitespace' });
      continue;
    }
    scan.valid.push(name);
  }
  return scan;
}

/** Artifacts in a run directory that satisfy the evidence contract. */
export function listArtifacts(paths: RuntimePaths, runId: string): string[] {
  return scanArtifacts(paths, runId).valid;
}

// ---- policy health ---------------------------------------------------------

/**
 * A PreToolUse hook that crashes exits 0 with no output, which Claude Code reads
 * as "no opinion" — indistinguishable from an allow. That is the correct failure
 * mode (a broken kit must not block work) and precisely why the failure has to be
 * recorded somewhere the user can see it.
 */
export function readPolicyHealth(paths: RuntimePaths): PolicyHealth | undefined {
  if (!existsSync(paths.policyHealthFile)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(paths.policyHealthFile, 'utf8')) as PolicyHealth;
    return raw && typeof raw === 'object' && typeof raw.status === 'string' ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function recordPolicyHealth(
  paths: RuntimePaths,
  update: { ok: boolean; enforceGates: boolean; error?: string; now?: string },
): PolicyHealth {
  const previous = readPolicyHealth(paths);
  const now = update.now ?? new Date().toISOString();
  const health: PolicyHealth = {
    status: update.ok ? (update.enforceGates ? 'OK' : 'DISABLED') : 'DEGRADED',
    enforceGates: update.enforceGates,
    errorCount: (previous?.errorCount ?? 0) + (update.ok ? 0 : 1),
    updatedAt: now,
  };
  if (update.ok) health.lastOkAt = now;
  else if (previous?.lastOkAt) health.lastOkAt = previous.lastOkAt;
  if (update.ok) {
    if (previous?.lastErrorAt) health.lastErrorAt = previous.lastErrorAt;
    if (previous?.lastError) health.lastError = previous.lastError;
  } else {
    health.lastErrorAt = now;
    health.lastError = (update.error ?? 'unknown policy failure').slice(0, 500);
  }
  try {
    mkdirSync(paths.runtimeDir, { recursive: true });
    writeJsonAtomic(paths.policyHealthFile, health);
  } catch {
    // Health reporting must never be the thing that breaks the hook.
  }
  return health;
}

// ---- runtime directory pointer --------------------------------------------

/**
 * `--runtime <dir>` has to be discoverable by processes that get no flags: the
 * Claude Code hook, `cw` invoked from a skill, doctor, the monitor. The installer
 * writes the chosen name next to the hook it installs.
 */
export function runtimePointerFile(projectRoot: string): string {
  return join(resolve(projectRoot), '.claude', 'cw-runtime');
}

export function readRuntimePointer(projectRoot: string): string | undefined {
  const file = runtimePointerFile(projectRoot);
  if (!existsSync(file)) return undefined;
  try {
    const value = readFileSync(file, 'utf8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function writeRuntimePointer(projectRoot: string, runtimeDir: string): void {
  const file = runtimePointerFile(projectRoot);
  mkdirSync(join(resolve(projectRoot), '.claude'), { recursive: true });
  writeFileSync(file, `${runtimeDir}\n`, 'utf8');
}

/** Explicit flag wins, then the installed pointer, then the default. */
export function resolveRuntimeDirName(projectRoot: string, explicit?: string): string {
  return explicit ?? readRuntimePointer(projectRoot) ?? DEFAULT_CONFIG.runtimeDir;
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
