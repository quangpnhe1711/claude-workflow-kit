#!/usr/bin/env node
// claude-workflow-kit — Claude Code lifecycle hook.
//
// Feeds Claude runtime activity (active / tool / subagent / stopped) into the
// current workflow run. It never decides a business phase; skills do that
// explicitly through `cw`.
//
// Contract: this must never break a Claude Code session. Any failure is logged
// to <runtimeDir>/hook-errors.log and the process still exits 0.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hookDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = process.env.CLAUDE_PROJECT_DIR
  ? resolve(process.env.CLAUDE_PROJECT_DIR)
  : resolve(hookDir, '..', '..');

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function loadConfig(runtimeDir) {
  const file = join(runtimeDir, 'config.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function logFailure(runtimeDir, error) {
  try {
    appendFileSync(
      join(runtimeDir, 'hook-errors.log'),
      `${new Date().toISOString()} ${error?.stack ?? error}\n`,
      'utf8',
    );
  } catch {
    // nothing left to do
  }
}

let runtimeDir = join(projectRoot, '.ai-workflow');

try {
  const raw = readStdin().trim();
  const payload = raw ? JSON.parse(raw) : {};
  if (process.argv[2] && !payload.hook_event_name) payload.hook_event_name = process.argv[2];

  const bootstrapConfig = loadConfig(runtimeDir);
  if (bootstrapConfig.runtimeDir) runtimeDir = resolve(projectRoot, bootstrapConfig.runtimeDir);
  const config = loadConfig(runtimeDir);

  if (!config.runtimeUrl) throw new Error('config.runtimeUrl missing; run: claude-workflow-kit doctor');

  const core = await import(
    config.runtimeUrl.startsWith('file:') ? config.runtimeUrl : pathToFileURL(config.runtimeUrl).href
  );
  const runtime = new core.WorkflowRuntime({
    projectRoot,
    runtimeDir: config.runtimeDir ?? '.ai-workflow',
  });
  core.applyHook(runtime, payload);
} catch (error) {
  logFailure(runtimeDir, error);
}

process.exit(0);
