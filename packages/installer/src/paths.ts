import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export interface Preset {
  id: string;
  label: string;
  description: string;
  workflows: string[];
  skills: string[];
  agents: string[];
  claudeMd: string;
  dir: string;
}

export function adapterDir(): string {
  return dirname(require.resolve('@claude-workflow-kit/claude-adapter/package.json'));
}

export function workflowCoreEntry(): string {
  const pkg = require.resolve('@claude-workflow-kit/workflow-core/package.json');
  return join(dirname(pkg), 'dist', 'index.js');
}

export function workflowCoreEntryUrl(): string {
  return pathToFileURL(workflowCoreEntry()).href;
}

export function kitVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(installerRoot(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function installerRoot(): string {
  // dist/paths.js -> package root
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

export function listPresets(): string[] {
  const dir = join(adapterDir(), 'presets');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function loadPreset(id: string): Preset {
  const dir = join(adapterDir(), 'presets', id);
  const manifest = join(dir, 'preset.json');
  if (!existsSync(manifest)) {
    throw new Error(`unknown preset "${id}" (available: ${listPresets().join(', ') || 'none'})`);
  }
  const raw = JSON.parse(readFileSync(manifest, 'utf8')) as Omit<Preset, 'dir'>;
  return { ...raw, dir };
}

export function hookSourceFile(): string {
  return join(adapterDir(), 'hooks', 'cw-hook.mjs');
}

export function settingsTemplateFile(): string {
  return join(adapterDir(), 'settings.template.json');
}
