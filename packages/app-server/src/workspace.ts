/**
 * The workspace registry — the app's list of projects.
 *
 * It lives outside every repository (`~/.claude-workflow-kit/workspace.json`)
 * because the app is opened once and works across projects, while
 * `.ai-workflow/` belongs to one repository and is committed with it. A registry
 * inside a repo would either follow the wrong project or leak one developer's
 * machine layout into everyone's history.
 *
 * Registering is idempotent by resolved path: the id is derived from the path,
 * so adding the same directory twice updates the entry instead of forking it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DEFAULT_CONFIG, readConfig, RuntimePaths } from '@claude-workflow-kit/workflow-core';

export const WORKSPACE_VERSION = 1;

export interface ProjectEntry {
  /** `<slug>-<hash8>`; stable for a given absolute path. */
  id: string;
  name: string;
  /** Absolute, resolved project root. */
  path: string;
  /** Runtime directory name relative to `path`, e.g. `.ai-workflow`. */
  runtimeDir: string;
  addedAt: string;
  lastOpenedAt?: string;
}

export interface WorkspaceFile {
  version: number;
  lastProjectId?: string;
  projects: ProjectEntry[];
}

/** NFD combining marks: strips Vietnamese diacritics out of the id slug. */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
const BACKSLASHES = new RegExp('\\\\', 'g');

function slug(text: string): string {
  const flat = text.normalize('NFD').replace(COMBINING_MARKS, '');
  return (
    flat
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'project'
  );
}

/**
 * Windows paths differ only by case and separator, so the hash is taken from a
 * normalized form. Two spellings of one directory must not become two projects.
 */
export function projectIdFor(projectPath: string): string {
  const absolute = resolve(projectPath);
  const normalized = absolute.replace(BACKSLASHES, '/').replace(/\/+$/, '');
  const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
  return `${slug(basename(normalized) || 'project')}-${hash}`;
}

/** `CW_HOME` exists so tests (and portable installs) never touch the real home. */
export function workspaceHome(): string {
  const override = process.env['CW_HOME'];
  return override ? resolve(override) : join(homedir(), '.claude-workflow-kit');
}

export function workspaceFile(): string {
  return join(workspaceHome(), 'workspace.json');
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

export class Workspace {
  readonly file: string;
  private data: WorkspaceFile;

  constructor(file = workspaceFile()) {
    this.file = file;
    this.data = Workspace.read(file);
  }

  /**
   * A registry that cannot be parsed is treated as empty rather than fatal: the
   * app must still open so the user can re-add their projects. The unreadable
   * file is kept beside the new one instead of being deleted.
   */
  private static read(file: string): WorkspaceFile {
    if (!existsSync(file)) return { version: WORKSPACE_VERSION, projects: [] };
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<WorkspaceFile>;
      const projects = Array.isArray(raw.projects) ? raw.projects.filter(isProjectEntry) : [];
      return {
        version: WORKSPACE_VERSION,
        projects,
        ...(raw.lastProjectId ? { lastProjectId: raw.lastProjectId } : {}),
      };
    } catch {
      try {
        renameSync(file, `${file}.corrupt`);
      } catch {
        // best effort; an unreadable registry must not stop the app from booting
      }
      return { version: WORKSPACE_VERSION, projects: [] };
    }
  }

  /** Re-read from disk. Another `cw app` (or `--add`) may have written it. */
  reload(): void {
    this.data = Workspace.read(this.file);
  }

  private save(): void {
    writeJsonAtomic(this.file, this.data);
  }

  list(): ProjectEntry[] {
    return this.data.projects.slice();
  }

  get lastProjectId(): string | undefined {
    return this.data.lastProjectId;
  }

  find(id: string): ProjectEntry | undefined {
    return this.data.projects.find((p) => p.id === id);
  }

  findByPath(projectPath: string): ProjectEntry | undefined {
    return this.find(projectIdFor(projectPath));
  }

  /**
   * Register a directory, or refresh the entry that already covers it. The
   * runtime directory is read from the project itself when not stated, so a
   * project installed with `--runtime <dir>` is registered with the name it
   * actually uses.
   */
  add(input: { path: string; name?: string; runtimeDir?: string }): ProjectEntry {
    const absolute = resolve(input.path);
    if (!existsSync(absolute)) throw new Error(`no such directory: ${absolute}`);
    const id = projectIdFor(absolute);
    const existing = this.find(id);
    const entry: ProjectEntry = {
      id,
      name: input.name?.trim() || existing?.name || basename(absolute) || id,
      path: absolute,
      runtimeDir: input.runtimeDir ?? existing?.runtimeDir ?? detectRuntimeDir(absolute),
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      ...(existing?.lastOpenedAt ? { lastOpenedAt: existing.lastOpenedAt } : {}),
    };
    this.data.projects = [...this.data.projects.filter((p) => p.id !== id), entry];
    this.data.lastProjectId ??= id;
    this.save();
    return entry;
  }

  /** Unregister. Never touches the project's files — the kit stays installed. */
  remove(id: string): boolean {
    const before = this.data.projects.length;
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    if (this.data.projects.length === before) return false;
    if (this.data.lastProjectId === id) {
      const next = this.data.projects[0]?.id;
      if (next) this.data.lastProjectId = next;
      else delete this.data.lastProjectId;
    }
    this.save();
    return true;
  }

  rename(id: string, name: string): ProjectEntry {
    const entry = this.find(id);
    if (!entry) throw new Error(`unknown project "${id}"`);
    entry.name = name.trim() || entry.name;
    this.save();
    return entry;
  }

  touch(id: string): void {
    const entry = this.find(id);
    if (!entry) return;
    entry.lastOpenedAt = new Date().toISOString();
    this.data.lastProjectId = id;
    this.save();
  }
}

function isProjectEntry(value: unknown): value is ProjectEntry {
  const entry = value as Partial<ProjectEntry> | null;
  return Boolean(entry && typeof entry.id === 'string' && typeof entry.path === 'string');
}

/**
 * `.claude/cw-runtime` records a non-default runtime directory name. Reading it
 * here (rather than assuming `.ai-workflow`) is what lets the app open a project
 * that was installed with `--runtime`.
 */
export function detectRuntimeDir(projectRoot: string): string {
  const pointer = join(projectRoot, '.claude', 'cw-runtime');
  if (existsSync(pointer)) {
    const name = readFileSync(pointer, 'utf8').trim();
    if (name) return name;
  }
  return DEFAULT_CONFIG.runtimeDir;
}

export interface ProjectInspection {
  installed: boolean;
  runtimeDir: string;
  preset?: string;
  monitorPort?: number;
}

/** Whether the kit is actually installed in this project, and with what. */
export function inspectProject(entry: ProjectEntry): ProjectInspection {
  const paths = new RuntimePaths(entry.path, entry.runtimeDir);
  if (!existsSync(paths.runtimeDir)) return { installed: false, runtimeDir: entry.runtimeDir };
  const config = readConfig(paths);
  return {
    installed: existsSync(paths.configFile),
    runtimeDir: entry.runtimeDir,
    ...(config.preset ? { preset: config.preset } : {}),
    monitorPort: config.monitorPort,
  };
}
