import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { DEFAULT_CONFIG, resolveRuntimeDirName, type KitConfig } from '@claude-workflow-kit/workflow-core';
import {
  backup,
  mergeClaudeMd,
  mergeSettings,
  readJsonFile,
  removeKitHooks,
  stripClaudeMdBlock,
  type SettingsLike,
} from './merge.js';
import {
  hookSourceFile,
  kitVersion,
  loadPreset,
  settingsTemplateFile,
  workflowCoreEntryUrl,
  type Preset,
} from './paths.js';

export interface InstallOptions {
  projectRoot: string;
  preset?: string;
  runtimeDir?: string;
  monitorPort?: number;
  hooks?: boolean;
  claudeMd?: boolean;
  /** update = refresh managed content only, keep existing config values. */
  mode?: 'init' | 'update';
  dryRun?: boolean;
}

export interface InstallManifest {
  version: string;
  preset: string;
  installedAt: string;
  files: string[];
}

export interface InstallResult {
  written: string[];
  skipped: string[];
  backups: string[];
  manifest: InstallManifest;
  config: KitConfig;
  projectRoot: string;
}

function write(result: InstallResult, file: string, content: string, dryRun: boolean): void {
  result.written.push(file);
  if (dryRun) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function copy(result: InstallResult, from: string, to: string, dryRun: boolean): void {
  result.written.push(to);
  if (dryRun) return;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

const RUNTIME_README = `# claude-workflow-kit runtime

Everything here is runtime data for this project. The toolkit itself lives in
the \`claude-workflow-kit\` package, not in this directory.

- \`config.json\` — runtime settings (monitor port, stall threshold, paths).
- \`conventions/\` — persisted repository conventions, reused across tasks.
- \`runs/<run-id>/\` — one controlled workflow run: \`state.json\`,
  \`events.jsonl\` and the evidence artifacts the workflow produced.
- \`current-run\` — id of the active run, so a follow-up prompt continues it.
- \`workflows/\` — optional project-specific workflow definitions that override
  the built-in ones by id.

- \`sessions.json\` — Claude session id -> run id, so two sessions in one repo
  never write to each other's run.

State is owned by the \`cw\` CLI. Do not hand-edit \`state.json\`.

Commit \`conventions/\` — that is shared repository knowledge. Everything else
here is machine-local and is gitignored by the installed \`.gitignore\`;
\`config.json\` in particular holds an absolute \`runtimeUrl\` for this machine.
`;

const RUNS_GITIGNORE = `# run evidence is local working state by default; delete this file to commit it
*
!.gitignore
`;

// Machine-local files. `config.json` carries an absolute `runtimeUrl` resolved
// on this machine, so committing it breaks every other clone.
const RUNTIME_GITIGNORE = `current-run
sessions.json
hook-errors.log
installed.json
config.json
`;

export function install(options: InstallOptions): InstallResult {
  const projectRoot = resolve(options.projectRoot);
  const mode = options.mode ?? 'init';
  const dryRun = options.dryRun ?? false;
  const preset: Preset = loadPreset(options.preset ?? 'senior-dev');

  // `update` must not silently relocate a project installed with --runtime <dir>.
  const runtimeDirName = resolveRuntimeDirName(projectRoot, options.runtimeDir);
  const existingConfig = readJsonFile<KitConfig>(join(projectRoot, runtimeDirName, 'config.json'));
  const runtimeDir = join(projectRoot, runtimeDirName);
  const claudeDir = join(projectRoot, '.claude');

  const config: KitConfig = {
    ...DEFAULT_CONFIG,
    ...(mode === 'update' ? existingConfig ?? {} : {}),
    runtimeDir: runtimeDirName,
    runtimeUrl: workflowCoreEntryUrl(),
    preset: preset.id,
    version: kitVersion(),
    ...(options.monitorPort ? { monitorPort: options.monitorPort } : {}),
  };

  const result: InstallResult = {
    written: [],
    skipped: [],
    backups: [],
    manifest: { version: kitVersion(), preset: preset.id, installedAt: new Date().toISOString(), files: [] },
    config,
    projectRoot,
  };

  // --- runtime directory ---
  if (!dryRun) {
    mkdirSync(join(runtimeDir, 'runs'), { recursive: true });
    mkdirSync(join(runtimeDir, 'conventions'), { recursive: true });
  }
  write(result, join(runtimeDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, dryRun);
  write(result, join(runtimeDir, 'README.md'), RUNTIME_README, dryRun);
  if (!existsSync(join(runtimeDir, 'runs', '.gitignore'))) {
    write(result, join(runtimeDir, 'runs', '.gitignore'), RUNS_GITIGNORE, dryRun);
  }
  if (!existsSync(join(runtimeDir, '.gitignore'))) {
    write(result, join(runtimeDir, '.gitignore'), RUNTIME_GITIGNORE, dryRun);
  }

  // --- skills and agents ---
  for (const skill of preset.skills) {
    const from = join(preset.dir, 'skills', skill, 'SKILL.md');
    if (!existsSync(from)) {
      result.skipped.push(`skill ${skill} (missing in preset)`);
      continue;
    }
    const to = join(claudeDir, 'skills', skill, 'SKILL.md');
    copy(result, from, to, dryRun);
    result.manifest.files.push(relative(projectRoot, to).replace(/\\/g, '/'));
  }

  for (const agent of preset.agents) {
    const from = join(preset.dir, 'agents', `${agent}.md`);
    if (!existsSync(from)) {
      result.skipped.push(`agent ${agent} (missing in preset)`);
      continue;
    }
    const to = join(claudeDir, 'agents', `${agent}.md`);
    copy(result, from, to, dryRun);
    result.manifest.files.push(relative(projectRoot, to).replace(/\\/g, '/'));
  }

  // --- hooks ---
  if (options.hooks !== false) {
    const to = join(claudeDir, 'hooks', 'cw-hook.mjs');
    copy(result, hookSourceFile(), to, dryRun);
    result.manifest.files.push(relative(projectRoot, to).replace(/\\/g, '/'));

    // The hook, `cw` from a skill, doctor and the monitor all start with no
    // flags. A non-default `--runtime <dir>` has to be discoverable, or the hook
    // silently finds no config and every gate stops being enforced.
    const pointer = join(claudeDir, 'cw-runtime');
    write(result, pointer, `${runtimeDirName}\n`, dryRun);
    result.manifest.files.push(relative(projectRoot, pointer).replace(/\\/g, '/'));

    const settingsFile = join(claudeDir, 'settings.json');
    const template = JSON.parse(readFileSync(settingsTemplateFile(), 'utf8')) as SettingsLike;
    const current = readJsonFile<SettingsLike>(settingsFile);
    if (!dryRun) {
      const saved = backup(settingsFile);
      if (saved) result.backups.push(saved);
    }
    write(result, settingsFile, `${JSON.stringify(mergeSettings(current, template), null, 2)}\n`, dryRun);
  }

  // --- CLAUDE.md managed block ---
  if (options.claudeMd !== false) {
    const claudeMdFile = join(projectRoot, 'CLAUDE.md');
    const block = readFileSync(join(preset.dir, preset.claudeMd), 'utf8');
    const existing = existsSync(claudeMdFile) ? readFileSync(claudeMdFile, 'utf8') : undefined;
    if (!dryRun && existing) {
      const saved = backup(claudeMdFile);
      if (saved) result.backups.push(saved);
    }
    write(result, claudeMdFile, mergeClaudeMd(existing, block), dryRun);
  }

  write(
    result,
    join(runtimeDir, 'installed.json'),
    `${JSON.stringify(result.manifest, null, 2)}\n`,
    dryRun,
  );

  return result;
}

export interface UninstallOptions {
  projectRoot: string;
  runtimeDir?: string;
  /** Also delete the runtime directory, including run evidence. */
  purge?: boolean;
  dryRun?: boolean;
}

export interface UninstallResult {
  removed: string[];
  kept: string[];
}

export function uninstall(options: UninstallOptions): UninstallResult {
  const projectRoot = resolve(options.projectRoot);
  const dryRun = options.dryRun ?? false;
  const runtimeDirName = resolveRuntimeDirName(projectRoot, options.runtimeDir);
  const runtimeDir = join(projectRoot, runtimeDirName);
  const removed: string[] = [];
  const kept: string[] = [];

  const manifest = readJsonFile<InstallManifest>(join(runtimeDir, 'installed.json'));
  for (const relPath of manifest?.files ?? []) {
    const file = join(projectRoot, relPath);
    if (!existsSync(file)) continue;
    removed.push(file);
    if (!dryRun) {
      rmSync(file, { force: true });
      const parent = dirname(file);
      // Skill directories hold exactly one file; drop the empty shell too.
      try {
        rmSync(parent, { recursive: false });
      } catch {
        // not empty — leave it
      }
    }
  }

  const settingsFile = join(projectRoot, '.claude', 'settings.json');
  const settings = readJsonFile<SettingsLike>(settingsFile);
  if (settings) {
    if (!dryRun) backup(settingsFile);
    const cleaned = removeKitHooks(settings);
    removed.push(`${settingsFile} (kit hooks)`);
    if (!dryRun) writeFileSync(settingsFile, `${JSON.stringify(cleaned, null, 2)}\n`, 'utf8');
  }

  const claudeMdFile = join(projectRoot, 'CLAUDE.md');
  if (existsSync(claudeMdFile)) {
    const content = readFileSync(claudeMdFile, 'utf8');
    const stripped = stripClaudeMdBlock(content);
    if (stripped !== content) {
      if (!dryRun) {
        backup(claudeMdFile);
        writeFileSync(claudeMdFile, stripped, 'utf8');
      }
      removed.push(`${claudeMdFile} (managed block)`);
    }
  }

  if (options.purge) {
    removed.push(runtimeDir);
    if (!dryRun) rmSync(runtimeDir, { recursive: true, force: true });
  } else if (existsSync(runtimeDir)) {
    kept.push(`${runtimeDir} (run evidence and conventions; use --purge to delete)`);
  }

  return { removed, kept };
}
