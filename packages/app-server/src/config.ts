/**
 * Reading and editing a project's `.ai-workflow/config.json` from the app.
 *
 * Only a whitelist is writable. The rest of `KitConfig` — `runtimeUrl`,
 * `mutationTools`, `mutationToolPatterns`, `commandTools`, `readOnlyCommands`,
 * `stateSchemaVersion` — decides what the PreToolUse policy treats as a write,
 * and a browser form that can widen or empty those lists is a browser form that
 * can switch off gate enforcement by accident. Those stay the installer's and
 * the repository's business.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG, RuntimePaths, type KitConfig } from '@claude-workflow-kit/workflow-core';
import { HttpError } from '@claude-workflow-kit/monitor-server';
import type { ProjectEntry } from './workspace.js';

export const EDITABLE_CONFIG_KEYS = [
  'monitorPort',
  'stallThresholdSeconds',
  'semanticLagThresholdSeconds',
  'autoGenericRun',
  'enforceGates',
  'analysisReportDir',
] as const;

export type EditableConfigKey = (typeof EDITABLE_CONFIG_KEYS)[number];

export interface ConfigView {
  /** The effective config, defaults merged in. */
  config: KitConfig;
  editable: readonly EditableConfigKey[];
  file: string;
  exists: boolean;
}

export function readProjectConfig(entry: ProjectEntry): ConfigView {
  const paths = new RuntimePaths(entry.path, entry.runtimeDir);
  const exists = existsSync(paths.configFile);
  return {
    config: exists ? readRaw(paths) : { ...DEFAULT_CONFIG },
    editable: EDITABLE_CONFIG_KEYS,
    file: paths.configFile,
    exists,
  };
}

function readRaw(paths: RuntimePaths): KitConfig {
  const raw = JSON.parse(readFileSync(paths.configFile, 'utf8')) as Partial<KitConfig>;
  return { ...DEFAULT_CONFIG, ...raw };
}

function positiveInt(value: unknown, key: string, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > max) {
    throw new HttpError(`"${key}" must be a whole number between 1 and ${max}`);
  }
  return n;
}

function bool(value: unknown, key: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new HttpError(`"${key}" must be true or false`);
}

/**
 * Validate one submitted patch. Unknown and read-only keys are rejected by name
 * rather than dropped: a settings form that silently discards half a save is
 * worse than one that refuses it.
 */
export function validateConfigPatch(patch: Record<string, unknown>): Partial<KitConfig> {
  const out: Partial<KitConfig> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(EDITABLE_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new HttpError(
        `"${key}" is not editable from the app (editable: ${EDITABLE_CONFIG_KEYS.join(', ')})`,
      );
    }
    switch (key as EditableConfigKey) {
      case 'monitorPort':
        out.monitorPort = positiveInt(value, key, 65535);
        break;
      case 'stallThresholdSeconds':
        out.stallThresholdSeconds = positiveInt(value, key, 86_400);
        break;
      case 'semanticLagThresholdSeconds':
        out.semanticLagThresholdSeconds = positiveInt(value, key, 86_400);
        break;
      case 'autoGenericRun':
        out.autoGenericRun = bool(value, key);
        break;
      case 'enforceGates':
        out.enforceGates = bool(value, key);
        break;
      case 'analysisReportDir': {
        const text = String(value ?? '').trim();
        if (!text || text.includes('..')) throw new HttpError(`"${key}" must be a relative path inside the project`);
        out.analysisReportDir = text;
        break;
      }
    }
  }
  return out;
}

/**
 * Merge the patch into the file on disk. The unmanaged keys are read back and
 * rewritten verbatim, so editing the stall threshold cannot rewrite a project's
 * customized mutation tool list into the shipped defaults.
 */
export function writeProjectConfig(entry: ProjectEntry, patch: Partial<KitConfig>): ConfigView {
  const paths = new RuntimePaths(entry.path, entry.runtimeDir);
  if (!existsSync(paths.configFile)) {
    throw new HttpError(`the kit is not installed in ${entry.path}; run install first`, 409);
  }
  const onDisk = JSON.parse(readFileSync(paths.configFile, 'utf8')) as Partial<KitConfig>;
  const merged = { ...onDisk, ...patch };
  mkdirSync(dirname(paths.configFile), { recursive: true });
  const temp = `${paths.configFile}.tmp`;
  writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  renameSync(temp, paths.configFile);
  return readProjectConfig(entry);
}
