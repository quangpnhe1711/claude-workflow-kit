/**
 * `cw app` — the multi-project app.
 *
 * The app server deliberately knows nothing about the installer: it accepts
 * `install` / `doctor` / `listPresets` as injected functions so the published
 * CLI can own provisioning without the two packages depending on each other in
 * a circle. This file is that injection point, and the only place where the two
 * halves meet.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  createAppServer,
  DEFAULT_APP_PORT,
  Workspace,
  type AppHandle,
  type ProvisioningHooks,
} from '@claude-workflow-kit/app-server';
import { resolveUiDir } from '@claude-workflow-kit/monitor-server';
import { doctor } from './doctor.js';
import { install } from './install.js';
import { kitVersion, listPresets } from './paths.js';

export function provisioningHooks(): ProvisioningHooks {
  return {
    install: (request) =>
      install({
        projectRoot: request.projectRoot,
        ...(request.preset ? { preset: request.preset } : {}),
        ...(request.runtimeDir ? { runtimeDir: request.runtimeDir } : {}),
        ...(typeof request.monitorPort === 'number' ? { monitorPort: request.monitorPort } : {}),
        ...(typeof request.hooks === 'boolean' ? { hooks: request.hooks } : {}),
        ...(typeof request.claudeMd === 'boolean' ? { claudeMd: request.claudeMd } : {}),
        mode: request.mode ?? 'init',
        ...(request.dryRun ? { dryRun: true } : {}),
      }),
    doctor: (request) =>
      doctor({
        projectRoot: request.projectRoot,
        ...(request.runtimeDir ? { runtimeDir: request.runtimeDir } : {}),
        ...(request.monitorUrl ? { monitorUrl: request.monitorUrl } : {}),
      }),
    listPresets,
    kitVersion,
  };
}

export interface AppCliOptions {
  port?: number;
  host?: string;
  uiDir?: string;
  /** Register these directories before serving. */
  add?: string[];
  workspaceFile?: string;
}

export function startApp(options: AppCliOptions = {}): AppHandle {
  const workspace = options.workspaceFile ? new Workspace(options.workspaceFile) : new Workspace();
  for (const dir of options.add ?? []) workspace.add({ path: resolve(dir) });

  const uiDir = options.uiDir ?? resolveUiDir();
  return createAppServer({
    port: options.port ?? DEFAULT_APP_PORT,
    ...(options.host ? { host: options.host } : {}),
    ...(uiDir ? { uiDir } : {}),
    workspace,
    provisioning: provisioningHooks(),
  });
}

/** Best-effort "open my browser". A failure here is never fatal to the app. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? (['cmd', ['/c', 'start', '', url]] as const)
      : process.platform === 'darwin'
        ? (['open', [url]] as const)
        : (['xdg-open', [url]] as const);
  try {
    const child = spawn(command, [...args], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // the URL is printed anyway
  }
}
