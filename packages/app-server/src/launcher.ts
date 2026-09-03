/**
 * Starting a Claude Code task from the app.
 *
 * This is the one place in the kit that *starts* work rather than recording it,
 * so it is deliberately narrow:
 *
 * - The prompt is written to the child's **stdin**, never to argv. Every
 *   argument we pass is a literal from this file, which is what makes
 *   `shell: true` (unavoidable on Windows, where `claude` is a `.cmd` shim)
 *   safe rather than an injection point.
 * - The default permission mode is `plan` — read-only. Anything that can edit
 *   the repository has to be asked for explicitly, with `confirmUnsafe`.
 * - Nothing here writes workflow state. The spawned session drives `cw` through
 *   the installed skills and hooks exactly as a terminal session would, so the
 *   run that appears in the monitor is a real run, not one the app invented.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { RuntimePaths } from '@claude-workflow-kit/workflow-core';
import { HttpError } from '@claude-workflow-kit/monitor-server';
import type { ProjectEntry } from './workspace.js';

/**
 * Claude Code's `--permission-mode`. `plan` cannot edit; `acceptEdits` writes
 * files without asking; `bypassPermissions` also runs commands without asking.
 */
export type LaunchMode = 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';

export const LAUNCH_MODES: readonly LaunchMode[] = ['plan', 'default', 'acceptEdits', 'bypassPermissions'];

/** Modes that can change the repository without a human seeing each step. */
export const UNSAFE_MODES: readonly LaunchMode[] = ['acceptEdits', 'bypassPermissions'];

export type TaskStatus = 'RUNNING' | 'DONE' | 'FAILED' | 'STOPPED' | 'UNKNOWN';

export interface TaskRecord {
  id: string;
  projectId: string;
  prompt: string;
  mode: LaunchMode;
  status: TaskStatus;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string;
  /** The workflow run this session worked in — opened or continued — once it has. */
  runId?: string;
  /** Why the task failed to start, or why its outcome is unknown. */
  error?: string;
}

export interface StartTaskRequest {
  prompt: string;
  mode?: LaunchMode;
  /** Required for `acceptEdits` and `bypassPermissions`. */
  confirmUnsafe?: boolean;
}

export interface TaskOutputPage {
  taskId: string;
  /** Byte offset the next page should start from. */
  cursor: number;
  size: number;
  text: string;
  done: boolean;
}

const MAX_PROMPT_BYTES = 32 * 1024;
const OUTPUT_PAGE_BYTES = 64 * 1024;

function appDir(entry: ProjectEntry): string {
  return join(new RuntimePaths(entry.path, entry.runtimeDir).runtimeDir, 'app');
}

function tasksFile(entry: ProjectEntry): string {
  return join(appDir(entry), 'tasks.json');
}

function taskOutputFile(entry: ProjectEntry, taskId: string): string {
  return join(appDir(entry), 'tasks', `${taskId}.jsonl`);
}

function taskErrorFile(entry: ProjectEntry, taskId: string): string {
  return join(appDir(entry), 'tasks', `${taskId}.err.log`);
}

function nextTaskId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const salt = Math.random().toString(36).slice(2, 6);
  return `task-${stamp}-${salt}`;
}

/** The binary to run. `CW_CLAUDE_BIN` lets tests stand in a fake, and lets a
 *  user point at a Claude Code that is not on PATH. */
export function claudeBin(): string {
  return process.env['CW_CLAUDE_BIN']?.trim() || 'claude';
}

/** Is a Claude Code binary resolvable at all? Used by the app's readiness check. */
export function claudeAvailable(): { ok: boolean; bin: string; detail: string } {
  const bin = claudeBin();
  const probe = spawnSync(bin, ['--version'], {
    shell: process.platform === 'win32',
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (probe.error) return { ok: false, bin, detail: probe.error.message };
  if (probe.status !== 0) {
    return { ok: false, bin, detail: (probe.stderr || probe.stdout || `exit ${probe.status}`).trim() };
  }
  return { ok: true, bin, detail: (probe.stdout || '').trim() };
}

export class TaskLauncher {
  /** Live children, by task id. Only tasks this process started appear here. */
  private readonly children = new Map<string, ChildProcess>();

  /** List a project's tasks, newest first. */
  list(entry: ProjectEntry): TaskRecord[] {
    return readTasks(entry)
      .slice()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(entry: ProjectEntry, taskId: string): TaskRecord {
    const task = readTasks(entry).find((t) => t.id === taskId);
    if (!task) throw new HttpError(`unknown task "${taskId}"`, 404);
    return task;
  }

  /**
   * Reconcile records left behind by a previous `cw app`. A task this process
   * did not start cannot be waited on, so its outcome is reported as UNKNOWN
   * rather than guessed from a pid that may since have been reused.
   */
  reconcile(entry: ProjectEntry): void {
    const tasks = readTasks(entry);
    let changed = false;
    for (const task of tasks) {
      if (task.status !== 'RUNNING' || this.children.has(task.id)) continue;
      task.status = 'UNKNOWN';
      task.endedAt ??= new Date().toISOString();
      task.error ??= 'the app restarted while this task was running; its outcome was not observed';
      changed = true;
    }
    if (changed) writeTasks(entry, tasks);
  }

  start(entry: ProjectEntry, request: StartTaskRequest): TaskRecord {
    const prompt = request.prompt?.trim();
    if (!prompt) throw new HttpError('"prompt" is required');
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw new HttpError(`the prompt is longer than ${MAX_PROMPT_BYTES} bytes`, 413);
    }
    const mode: LaunchMode = request.mode ?? 'plan';
    if (!LAUNCH_MODES.includes(mode)) {
      throw new HttpError(`unknown mode "${mode}" (known: ${LAUNCH_MODES.join(', ')})`);
    }
    if (UNSAFE_MODES.includes(mode) && !request.confirmUnsafe) {
      throw new HttpError(
        `mode "${mode}" lets the session change this repository without asking; resend with "confirmUnsafe": true`,
        403,
      );
    }
    if (!existsSync(entry.path)) {
      throw new HttpError(`project directory ${entry.path} no longer exists`, 409);
    }

    const now = new Date();
    const id = nextTaskId(now);
    mkdirSync(join(appDir(entry), 'tasks'), { recursive: true });
    writeFileSync(taskOutputFile(entry, id), '', 'utf8');

    const record: TaskRecord = {
      id,
      projectId: entry.id,
      prompt,
      mode,
      status: 'RUNNING',
      startedAt: now.toISOString(),
    };

    // Every argument below is a literal. The prompt goes in over stdin, which is
    // what keeps `shell: true` from being a command-injection hole on Windows.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', mode];
    let child: ChildProcess;
    try {
      child = spawn(claudeBin(), args, {
        cwd: entry.path,
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      record.status = 'FAILED';
      record.endedAt = new Date().toISOString();
      record.error = error instanceof Error ? error.message : String(error);
      upsertTask(entry, record);
      return record;
    }

    if (typeof child.pid === 'number') record.pid = child.pid;
    upsertTask(entry, record);
    this.children.set(id, child);

    const out = createWriteStream(taskOutputFile(entry, id), { flags: 'a' });
    child.stdout?.pipe(out);
    child.stderr?.on('data', (chunk: Buffer) => {
      try {
        appendFileSync(taskErrorFile(entry, id), chunk);
      } catch {
        // a task whose stderr cannot be written still runs; the log is a courtesy
      }
    });

    child.stdin?.on('error', () => {
      // The child may exit before the prompt is fully written (bad flags, no
      // auth). The exit handler reports that; an EPIPE here must not crash the app.
    });
    child.stdin?.end(`${prompt}\n`, 'utf8');

    child.on('error', (error) => {
      this.children.delete(id);
      tryPatchTask(entry, id, (task) => {
        task.status = 'FAILED';
        task.endedAt = new Date().toISOString();
        task.error = error.message;
      });
    });

    child.on('close', (code, signal) => {
      this.children.delete(id);
      tryPatchTask(entry, id, (task) => {
        if (task.status === 'STOPPED') {
          task.endedAt ??= new Date().toISOString();
          return;
        }
        task.status = code === 0 ? 'DONE' : 'FAILED';
        task.endedAt = new Date().toISOString();
        task.exitCode = code;
        if (signal) task.signal = signal;
        if (code !== 0) task.error ??= tailErrors(entry, id);
      });
    });

    // The session reaches its run a moment after it starts; link them when it does.
    this.linkRun(entry, id, record.startedAt);
    return record;
  }

  /**
   * Attach the run this session worked in — the one it opened, or the one it
   * continued. `.ai-workflow/current-run` alone is not enough: it can still be
   * pointing at a run from last week, and adopting that would claim the session
   * produced work it never touched. So a run is linked only once its own
   * `lastActivityAt` has moved to at or after the moment the task started, which
   * is true exactly when this session actually did something in it.
   *
   * Polled briefly rather than watched: the link is a convenience for the UI, and
   * a task with no run (a question that opened nothing) must not keep a timer alive.
   */
  private linkRun(entry: ProjectEntry, taskId: string, startedAt: string): void {
    const paths = new RuntimePaths(entry.path, entry.runtimeDir);
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      let runId: string | undefined;
      try {
        if (existsSync(paths.currentRunFile)) {
          const candidate = readFileSync(paths.currentRunFile, 'utf8').trim();
          if (candidate && touchedSince(paths, candidate, startedAt)) runId = candidate;
        }
      } catch {
        runId = undefined;
      }
      const stillRunning = this.children.has(taskId);
      if (runId) tryPatchTask(entry, taskId, (task) => void (task.runId ??= runId));
      if (runId || attempts >= 30 || !stillRunning) clearInterval(timer);
    }, 1000);
    timer.unref?.();
  }

  /**
   * Stop a task. On Windows the shell wrapper is the direct child, so killing it
   * alone would orphan the real session — `taskkill /T` takes the tree.
   */
  stop(entry: ProjectEntry, taskId: string): TaskRecord {
    const task = this.get(entry, taskId);
    if (task.status !== 'RUNNING') return task;
    const child = this.children.get(taskId);
    if (!child) {
      return patchTask(entry, taskId, (t) => {
        t.status = 'UNKNOWN';
        t.endedAt = new Date().toISOString();
        t.error ??= 'this task was not started by the running app; stop it from its own terminal';
      });
    }
    const updated = patchTask(entry, taskId, (t) => {
      t.status = 'STOPPED';
      t.endedAt = new Date().toISOString();
    });
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
    return updated;
  }

  /** One page of the raw stream-json output, from a byte cursor. */
  output(entry: ProjectEntry, taskId: string, after = 0, limit = OUTPUT_PAGE_BYTES): TaskOutputPage {
    const task = this.get(entry, taskId);
    const file = taskOutputFile(entry, taskId);
    const size = existsSync(file) ? statSync(file).size : 0;
    const start = Math.max(0, Math.min(after, size));
    const length = Math.max(0, Math.min(limit, size - start));
    let text = '';
    if (length > 0) {
      const fd = openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, start);
        text = buffer.toString('utf8');
      } finally {
        closeSync(fd);
      }
    }
    return {
      taskId,
      cursor: start + length,
      size,
      text,
      done: task.status !== 'RUNNING' && start + length >= size,
    };
  }

  /** Kill everything this process started. Called when the app shuts down. */
  stopAll(): void {
    for (const [, child] of this.children) {
      if (process.platform === 'win32' && typeof child.pid === 'number') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    }
    this.children.clear();
  }
}

/**
 * Has this run seen any activity since `since`? Read straight from `state.json`
 * rather than through the runtime, because this runs on a timer and must never
 * be the thing that throws.
 */
function touchedSince(paths: RuntimePaths, runId: string, since: string): boolean {
  try {
    const raw = readFileSync(paths.stateFile(runId), 'utf8');
    const state = JSON.parse(raw) as { lastActivityAt?: string; startedAt?: string };
    const stamp = state.lastActivityAt ?? state.startedAt;
    return Boolean(stamp && stamp >= since);
  } catch {
    return false;
  }
}

function tailErrors(entry: ProjectEntry, taskId: string): string | undefined {
  const file = taskErrorFile(entry, taskId);
  if (!existsSync(file)) return undefined;
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text ? text.slice(-500) : undefined;
  } catch {
    return undefined;
  }
}

function readTasks(entry: ProjectEntry): TaskRecord[] {
  const file = tasksFile(entry);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as TaskRecord[]).filter((t) => t && typeof t.id === 'string') : [];
  } catch {
    return [];
  }
}

function writeTasks(entry: ProjectEntry, tasks: TaskRecord[]): void {
  const file = tasksFile(entry);
  mkdirSync(appDir(entry), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

function upsertTask(entry: ProjectEntry, record: TaskRecord): void {
  const tasks = readTasks(entry).filter((t) => t.id !== record.id);
  tasks.push(record);
  writeTasks(entry, tasks);
}

/** Read-modify-write one task. Re-read each time: the file is the truth. */
function patchTask(entry: ProjectEntry, taskId: string, apply: (task: TaskRecord) => void): TaskRecord {
  const task = tryPatchTask(entry, taskId, apply);
  if (!task) throw new HttpError(`unknown task "${taskId}"`, 404);
  return task;
}

/**
 * The same write, for the child-process callbacks. A task record can legitimately
 * be gone by the time a session exits — the log was pruned, the project was
 * unregistered — and a throw from inside an exit handler or an interval takes
 * the whole app down with it. Absence is not an error here.
 */
function tryPatchTask(
  entry: ProjectEntry,
  taskId: string,
  apply: (task: TaskRecord) => void,
): TaskRecord | undefined {
  try {
    const tasks = readTasks(entry);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return undefined;
    apply(task);
    writeTasks(entry, tasks);
    return task;
  } catch {
    return undefined;
  }
}
