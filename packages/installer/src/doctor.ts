import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_CONFIG,
  WorkflowRuntime,
  derivedRunStatus,
  derivedSemanticStatus,
  loadWorkflows,
  readRuntimePointer,
  resolveRuntimeDirName,
  type KitConfig,
  type RunState,
} from '@claude-workflow-kit/workflow-core';
import { isKitHookCommand, readJsonFile, type SettingsLike } from './merge.js';
import { kitVersion, loadPreset } from './paths.js';

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
  // Honour the same pointer the hook reads, so `--runtime <dir>` installs are
  // diagnosed as installed rather than as missing.
  const runtimeDirName = resolveRuntimeDirName(projectRoot, options.runtimeDir);
  const runtimeDir = join(projectRoot, runtimeDirName);
  if (runtimeDirName !== DEFAULT_CONFIG.runtimeDir) {
    const pointer = readRuntimePointer(projectRoot);
    add(
      'runtime pointer',
      pointer === runtimeDirName ? 'ok' : 'fail',
      pointer === runtimeDirName
        ? `.claude/cw-runtime -> ${pointer}`
        : `runtime dir is "${runtimeDirName}" but .claude/cw-runtime says "${pointer ?? '(missing)'}" — ` +
          `hooks would look in the wrong place. Run: claude-workflow-kit update --runtime ${runtimeDirName}`,
    );
  }
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
    const stateSchemaVersion = config.stateSchemaVersion ?? 1;
    add(
      'state schema',
      stateSchemaVersion >= 2 ? 'ok' : 'warn',
      stateSchemaVersion >= 2
        ? `v${stateSchemaVersion}; legacy run fields remain optional`
        : `legacy v${stateSchemaVersion}; runs still load safely — run claude-workflow-kit update to record additive handoff capability`,
    );
    add(
      'framework version',
      config.version === kitVersion() ? 'ok' : 'warn',
      config.version === kitVersion()
        ? kitVersion()
        : `installed=${config.version ?? '(legacy)'} package=${kitVersion()} — run claude-workflow-kit update; additive files are installed and custom conflicts are preserved`,
    );
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
      const customizedSkills = preset.skills.filter((skill) => {
        const installed = join(projectRoot, '.claude', 'skills', skill, 'SKILL.md');
        const packaged = join(preset.dir, 'skills', skill, 'SKILL.md');
        return existsSync(installed) && existsSync(packaged) && readFileSync(installed, 'utf8') !== readFileSync(packaged, 'utf8');
      });
      add(
        'skill customizations',
        customizedSkills.length ? 'warn' : 'ok',
        customizedSkills.length
          ? `preserved project/legacy versions: ${customizedSkills.join(', ')}; compare with packaged files before adopting new routing behavior`
          : 'installed skills match the framework package',
      );

      const missingTemplates = (preset.templates ?? []).filter(
        (t) => !existsSync(join(runtimeDir, 'templates', t)),
      );
      add(
        'report templates',
        missingTemplates.length ? 'warn' : 'ok',
        missingTemplates.length
          ? `${(preset.templates ?? []).length - missingTemplates.length}/${(preset.templates ?? []).length} installed; missing: ${missingTemplates.join(', ')}`
          : `${(preset.templates ?? []).length} installed`,
      );

      const analysisTemplates = [
        'business-analysis.md',
        'impact-analysis.md',
        'solution-options.md',
        'recommended-solution.md',
        'implementation-plan.md',
        'test-strategy.md',
      ];
      const missingAnalysisTemplates = analysisTemplates.filter(
        (name) => !existsSync(join(runtimeDir, 'templates', name)),
      );
      add(
        'analysis artifact templates',
        missingAnalysisTemplates.length ? 'warn' : 'ok',
        missingAnalysisTemplates.length
          ? `missing: ${missingAnalysisTemplates.join(', ')} — run claude-workflow-kit update; existing templates will be preserved`
          : 'six-file solution-analysis contract available',
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

  const installedManifest = readJsonFile<{
    files?: string[];
    fileHashes?: Record<string, string>;
  }>(join(runtimeDir, 'installed.json'));
  if (installedManifest) {
    const hashes = installedManifest.fileHashes ?? {};
    const modified = Object.entries(hashes).flatMap(([rel, expected]) => {
      const file = join(projectRoot, rel);
      if (!existsSync(file)) return [];
      const current = createHash('sha256').update(readFileSync(file)).digest('hex');
      return current === expected ? [] : [rel];
    });
    const legacyOwnership = (installedManifest.files?.length ?? 0) > 0 && !installedManifest.fileHashes;
    add(
      'managed file ownership',
      modified.length || legacyOwnership ? 'warn' : 'ok',
      modified.length
        ? `customized files preserved on update: ${modified.join(', ')}; merge packaged changes manually if wanted`
        : legacyOwnership
          ? 'legacy manifest has no hashes; update preserves ambiguous existing files and installs only missing components'
          : 'framework-owned files are hash tracked; project customizations are preserved',
    );
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
    const analysis = defs.get('solution-analysis');
    add(
      'solution-analysis workflow',
      analysis ? 'ok' : 'warn',
      analysis
        ? `${analysis.nodes.length} nodes; analysis-only approval flow available`
        : 'missing — update the workflow-core package; no existing workflow needs to be removed',
    );
    const feature = defs.get('feature-change');
    const handoffReady = Boolean(
      feature?.nodes.some((node) => node.id === 'freshness') &&
      feature?.edges.some((edge) => edge.from === 'prompt' && edge.to === 'freshness'),
    );
    add(
      'analysis handoff config',
      handoffReady ? 'ok' : 'warn',
      handoffReady
        ? 'feature-change accepts sourceAnalysisRunId through freshness'
        : 'feature-change override lacks the additive freshness branch; preserve it and merge the packaged node/edge before handoff',
    );
  } catch (error) {
    add('workflow definitions', 'fail', (error as Error).message);
  }

  // --- runs ---
  try {
    const runtime = new WorkflowRuntime({ projectRoot, runtimeDir: runtimeDirName });
    const ids = runtime.runIds();
    const loaded: RunState[] = [];
    const unreadable: string[] = [];
    for (const id of ids) {
      try {
        loaded.push(runtime.run(id));
      } catch {
        unreadable.push(id);
      }
    }
    const stalled = loaded.filter(
      (r) => derivedRunStatus(r, runtime.config.stallThresholdSeconds) === 'POSSIBLY_STALLED',
    );
    const quarantined = runtime.quarantinedRunIds();
    const broken = unreadable.filter((id) => !quarantined.includes(id));
    const notes: string[] = [`${ids.length} runs`];
    if (stalled.length) notes.push(`${stalled.length} possibly stalled: ${stalled.map((r) => r.runId).join(', ')}`);
    if (broken.length) {
      notes.push(
        `${broken.length} CORRUPT: ${broken.join(', ')} ` +
          `(retire with: cw run quarantine-current --reason "corrupt state")`,
      );
    }
    if (quarantined.length) notes.push(`${quarantined.length} quarantined: ${quarantined.join(', ')}`);
    add('runs', broken.length ? 'fail' : stalled.length ? 'warn' : 'ok', notes.join('; '));

    const incompleteHandoffs = loaded.filter(
      (run) => run.sourceAnalysisRunId && !run.analysisHandoff,
    );
    add(
      'run state compatibility',
      incompleteHandoffs.length ? 'warn' : 'ok',
      incompleteHandoffs.length
        ? `${incompleteHandoffs.length} linked feature run(s) lack optional handoff metadata: ${incompleteHandoffs.map((run) => run.runId).join(', ')}`
        : `${loaded.length} run(s) loaded; legacy runs require no schema rewrite`,
    );

    // HOOK-01: a policy that failed open must not look like a policy that allowed.
    const health = runtime.policyHealth();
    if (!health) {
      add(
        'gate policy',
        'warn',
        'no PreToolUse evaluation recorded yet — enforcement is unproven in this project',
      );
    } else {
      add(
        'gate policy',
        health.status === 'DEGRADED' ? 'fail' : health.status === 'DISABLED' ? 'warn' : 'ok',
        health.status === 'OK'
          ? `OK, enforceGates=${health.enforceGates}, last evaluated ${health.lastOkAt}`
          : health.status === 'DISABLED'
            ? 'enforceGates=false in config.json: gates are advisory in this project'
            : `DEGRADED — the hook failed and is failing open (${health.errorCount} error(s), last ` +
              `${health.lastErrorAt}): ${health.lastError?.split('\n')[0] ?? 'unknown'}`,
      );
    }

    // The failure mode of a model-emitted state machine: Claude is working but
    // the diagram is frozen. Reported, never guessed away.
    const lagging = loaded.filter(
      (r) => derivedSemanticStatus(r, runtime.config.semanticLagThresholdSeconds) === 'SEMANTIC_LAG',
    );
    add(
      'semantic progress',
      lagging.length ? 'warn' : 'ok',
      lagging.length
        ? `${lagging.length} run(s) active with no phase transition for >${runtime.config.semanticLagThresholdSeconds}s: ` +
          lagging.map((r) => `${r.runId}@${r.currentNode}`).join(', ')
        : 'phases track runtime activity',
    );

    // --- convention cache ---
    const conventions = runtime.conventions();
    add(
      'conventions',
      conventions.refreshNeeded.length ? 'warn' : 'ok',
      conventions.refreshNeeded.length
        ? `refresh needed: ${conventions.refreshNeeded.join(', ')} (cw conventions status)`
        : `${conventions.areas.length} areas cached and verified`,
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
