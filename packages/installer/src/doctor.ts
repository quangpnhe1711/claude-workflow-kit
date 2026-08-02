import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_CONFIG,
  WorkflowRuntime,
  derivedRunStatus,
  loadWorkflows,
  type KitConfig,
} from '@claude-workflow-kit/workflow-core';
import { isKitHookCommand, readJsonFile, type SettingsLike } from './merge.js';
import { loadPreset } from './paths.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorOptions {
  projectRoot: string;
  runtimeDir?: string;
  /** Probe this monitor URL; defaults to the configured port on localhost. */
  monitorUrl?: string;
}

export async function doctor(options: DoctorOptions): Promise<Check[]> {
  const projectRoot = resolve(options.projectRoot);
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });

  // --- node ---
  const major = Number(process.versions.node.split('.')[0]);
  add(
    'node',
    major >= 18 ? 'ok' : 'fail',
    `${process.version}${major >= 18 ? '' : ' (>=18.17 required)'}`,
  );

  // --- runtime dir + config ---
  const runtimeDirName = options.runtimeDir ?? DEFAULT_CONFIG.runtimeDir;
  const runtimeDir = join(projectRoot, runtimeDirName);
  const config = readJsonFile<KitConfig>(join(runtimeDir, 'config.json'));
  if (!existsSync(runtimeDir)) {
    add('runtime directory', 'fail', `${runtimeDir} missing — run: claude-workflow-kit init`);
  } else {
    add('runtime directory', 'ok', runtimeDir);
  }
  if (!config) {
    add('config.json', 'fail', 'missing or unreadable — run: claude-workflow-kit init');
  } else {
    add('config.json', 'ok', `port=${config.monitorPort} stall=${config.stallThresholdSeconds}s preset=${config.preset ?? '?'}`);
  }

  // --- hook wiring ---
  const hookFile = join(projectRoot, '.claude', 'hooks', 'cw-hook.mjs');
  add(
    'hook script',
    existsSync(hookFile) ? 'ok' : 'warn',
    existsSync(hookFile) ? hookFile : 'not installed — runtime activity will not be reported',
  );

  const settings = readJsonFile<SettingsLike>(join(projectRoot, '.claude', 'settings.json'));
  const wiredEvents = Object.entries((settings?.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>) ?? {})
    .filter(([, matchers]) => matchers.some((m) => (m.hooks ?? []).some((h) => isKitHookCommand(h.command))))
    .map(([event]) => event);
  add(
    'settings.json hooks',
    wiredEvents.length ? 'ok' : 'warn',
    wiredEvents.length ? `${wiredEvents.length} events: ${wiredEvents.join(', ')}` : 'no kit hooks configured',
  );

  // --- runtimeUrl importable (this is what the hook depends on) ---
  if (config?.runtimeUrl) {
    try {
      const url = config.runtimeUrl.startsWith('file:')
        ? config.runtimeUrl
        : pathToFileURL(config.runtimeUrl).href;
      const core = (await import(url)) as Record<string, unknown>;
      add(
        'runtimeUrl',
        typeof core['WorkflowRuntime'] === 'function' ? 'ok' : 'fail',
        typeof core['WorkflowRuntime'] === 'function' ? config.runtimeUrl : 'loaded but missing WorkflowRuntime export',
      );
    } catch (error) {
      add('runtimeUrl', 'fail', `cannot import ${config.runtimeUrl}: ${(error as Error).message}`);
    }
  } else {
    add('runtimeUrl', 'fail', 'not recorded in config.json — run: claude-workflow-kit update');
  }

  // --- skills and agents from the preset ---
  if (config?.preset) {
    try {
      const preset = loadPreset(config.preset);
      const missingSkills = preset.skills.filter(
        (s) => !existsSync(join(projectRoot, '.claude', 'skills', s, 'SKILL.md')),
      );
      add(
        'skills',
        missingSkills.length ? 'warn' : 'ok',
        missingSkills.length
          ? `${preset.skills.length - missingSkills.length}/${preset.skills.length} installed; missing: ${missingSkills.join(', ')}`
          : `${preset.skills.length} installed`,
      );

      const missingAgents = preset.agents.filter(
        (a) => !existsSync(join(projectRoot, '.claude', 'agents', `${a}.md`)),
      );
      add(
        'agents',
        missingAgents.length ? 'warn' : 'ok',
        missingAgents.length ? `missing: ${missingAgents.join(', ')}` : `${preset.agents.length} installed`,
      );
    } catch (error) {
      add('preset', 'fail', (error as Error).message);
    }
  }

  // --- CLAUDE.md managed block ---
  const claudeMd = join(projectRoot, 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    add('CLAUDE.md', 'warn', 'not present');
  } else {
    const content = readFileSync(claudeMd, 'utf8');
    add(
      'CLAUDE.md',
      content.includes('<!-- CW:START -->') ? 'ok' : 'warn',
      content.includes('<!-- CW:START -->') ? 'managed block present' : 'managed block missing — run: claude-workflow-kit update',
    );
  }

  // --- workflow definitions ---
  try {
    const defs = loadWorkflows(runtimeDir);
    add('workflow definitions', defs.size ? 'ok' : 'fail', [...defs.keys()].join(', ') || 'none found');
  } catch (error) {
    add('workflow definitions', 'fail', (error as Error).message);
  }

  // --- runs ---
  try {
    const runtime = new WorkflowRuntime({ projectRoot, runtimeDir: runtimeDirName });
    const ids = runtime.runIds();
    const stalled = ids
      .map((id) => runtime.run(id))
      .filter((r) => derivedRunStatus(r, runtime.config.stallThresholdSeconds) === 'POSSIBLY_STALLED');
    add(
      'runs',
      stalled.length ? 'warn' : 'ok',
      stalled.length
        ? `${ids.length} runs, ${stalled.length} possibly stalled: ${stalled.map((r) => r.runId).join(', ')}`
        : `${ids.length} runs`,
    );
  } catch (error) {
    add('runs', 'warn', (error as Error).message);
  }

  // --- hook errors ---
  const hookLog = join(runtimeDir, 'hook-errors.log');
  if (existsSync(hookLog)) {
    const lines = readFileSync(hookLog, 'utf8').split('\n').filter(Boolean);
    add('hook errors', lines.length ? 'warn' : 'ok', lines.length ? `${lines.length} logged; last: ${lines.at(-1)?.slice(0, 160)}` : 'none');
  } else {
    add('hook errors', 'ok', 'none');
  }

  // --- monitor ---
  const port = config?.monitorPort ?? DEFAULT_CONFIG.monitorPort;
  const monitorUrl = options.monitorUrl ?? `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${monitorUrl}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    add('monitor', res.ok ? 'ok' : 'warn', `${monitorUrl} -> ${res.status}`);
  } catch {
    add('monitor', 'warn', `not running at ${monitorUrl} (start it with: cw monitor)`);
  }

  return checks;
}

export function formatChecks(checks: Check[]): string {
  const icon: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✕' };
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `${icon[c.status]} ${c.name.padEnd(width)}  ${c.detail}`).join('\n');
}
