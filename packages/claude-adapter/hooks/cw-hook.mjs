#!/usr/bin/env node
// claude-workflow-kit — Claude Code lifecycle hook.
//
// Two jobs, both narrow:
//  1. Feed Claude runtime activity (active / tool / subagent / stopped) into the
//     current workflow run. It never decides a business phase; skills do that
//     explicitly through `cw`.
//  2. On PreToolUse, deny file-mutating tools while the active controlled run
//     still has an unpassed gate. This is what makes "NO BUSINESS DECISION =
//     NO CODING" a rule rather than a request.
//
// Contract: this must never break a Claude Code session. Any failure is logged
// to <runtimeDir>/hook-errors.log and the process still exits 0 with no output,
// which Claude Code reads as "no opinion" — a broken kit can never block work.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/**
 * A hook that dies exits 0 with no output, which Claude Code reads as "no
 * opinion" — i.e. as an allow. That is the right failure mode and exactly why it
 * must not be silent: mark the policy DEGRADED so doctor and the monitor say so.
 */
function markDegraded(runtimeDir, event, error) {
  if (event !== 'PreToolUse') return;
  try {
    const file = join(runtimeDir, 'policy-health.json');
    let previous = {};
    try {
      previous = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      previous = {};
    }
    const now = new Date().toISOString();
    const health = {
      status: 'DEGRADED',
      enforceGates: previous.enforceGates ?? true,
      errorCount: (previous.errorCount ?? 0) + 1,
      updatedAt: now,
      lastErrorAt: now,
      lastError: String(error?.stack ?? error).slice(0, 500),
    };
    if (previous.lastOkAt) health.lastOkAt = previous.lastOkAt;
    mkdirSync(runtimeDir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(health, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch {
    // nothing left to do
  }
}

/**
 * `--runtime <dir>` is chosen at install time and every process that has no flags
 * has to find it: this hook, `cw` from a skill, doctor, the monitor. The installer
 * records the name in `.claude/cw-runtime`.
 */
function resolveRuntimeDirName() {
  const pointer = join(projectRoot, '.claude', 'cw-runtime');
  if (existsSync(pointer)) {
    try {
      const name = readFileSync(pointer, 'utf8').trim();
      if (name) return name;
    } catch {
      // fall through to the default
    }
  }
  return '.ai-workflow';
}

let runtimeDirName = resolveRuntimeDirName();
let runtimeDir = resolve(projectRoot, runtimeDirName);
let hookEvent;

try {
  const raw = readStdin().trim();
  const payload = raw ? JSON.parse(raw) : {};
  if (process.argv[2] && !payload.hook_event_name) payload.hook_event_name = process.argv[2];
  hookEvent = payload.hook_event_name;

  const bootstrapConfig = loadConfig(runtimeDir);
  if (bootstrapConfig.runtimeDir) {
    runtimeDirName = bootstrapConfig.runtimeDir;
    runtimeDir = resolve(projectRoot, runtimeDirName);
  }
  const config = loadConfig(runtimeDir);

  if (!config.runtimeUrl) throw new Error('config.runtimeUrl missing; run: claude-workflow-kit doctor');

  const core = await import(
    config.runtimeUrl.startsWith('file:') ? config.runtimeUrl : pathToFileURL(config.runtimeUrl).href
  );
  const runtime = new core.WorkflowRuntime({
    projectRoot,
    runtimeDir: config.runtimeDir ?? runtimeDirName,
  });
  const result = core.applyHook(runtime, payload);

  if (result?.mutation?.decision === 'deny') {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.mutation.reason,
        },
      })}\n`,
    );
  }
} catch (error) {
  logFailure(runtimeDir, error);
  markDegraded(runtimeDir, hookEvent, error);
}

process.exit(0);
