#!/usr/bin/env node
// End-to-end verification: install the kit into a copy of the demo project,
// drive a full feature-change run through the `cw` CLI and the hook script,
// and confirm the monitor server reports what actually happened.
//
// Run with: npm run e2e

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const demoSource = join(repoRoot, 'examples', 'demo-project');
const cwBin = join(repoRoot, 'packages', 'installer', 'bin', 'cw.mjs');
const kitBin = join(repoRoot, 'packages', 'installer', 'bin', 'claude-workflow-kit.mjs');

const project = mkdtempSync(join(tmpdir(), 'cwk-e2e-'));
let monitor;
let failed = false;

const steps = [];
function step(name, fn) {
  steps.push([name, fn]);
}

function run(bin, args, options = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: project,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${bin} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function cw(...args) {
  return run(cwBin, ['--project', project, ...args]);
}

function hook(payload) {
  return run(join(project, '.claude', 'hooks', 'cw-hook.mjs'), [], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
  });
}

function state() {
  const runId = readFileSync(join(project, '.ai-workflow', 'current-run'), 'utf8').trim();
  return JSON.parse(readFileSync(join(project, '.ai-workflow', 'runs', runId, 'state.json'), 'utf8'));
}

// --- 1. install ------------------------------------------------------------

step('install into a clean project copy', () => {
  cpSync(demoSource, project, { recursive: true });
  const result = run(kitBin, ['init', '--project', project]);
  assert.match(result.stdout, /Installed preset "senior-dev"/);

  assert.ok(existsSync(join(project, '.claude', 'skills', 'feature-change', 'SKILL.md')));
  assert.ok(existsSync(join(project, '.claude', 'hooks', 'cw-hook.mjs')));
  assert.ok(existsSync(join(project, '.ai-workflow', 'config.json')));

  const claudeMd = readFileSync(join(project, 'CLAUDE.md'), 'utf8');
  assert.ok(claudeMd.includes('This line exists to prove the installer merges'), 'user content survived');
  assert.ok(claudeMd.includes('NO BUSINESS DECISION = NO CODING.'), 'managed block injected');
});

// --- 2. semantic run -------------------------------------------------------

step('start a feature-change run', () => {
  cw('run', 'start', 'feature-change', '--label', 'edit history standalone communication');
  const run = state();
  assert.equal(run.workflow, 'feature-change');
  assert.equal(run.currentNode, 'prompt');
});

step('evidence phase', () => {
  cw('phase', 'enter', 'evidence');
  writeFileSync(
    join(project, '.ai-workflow', 'runs', state().runId, 'evidence.md'),
    '# Evidence\n\nC-001: document says aggregate, code stores per entity.\n',
  );
  cw('artifact', 'evidence.md');
  cw('phase', 'complete');
  assert.equal(state().nodes.evidence.status, 'COMPLETED');
  assert.deepEqual(state().artifacts, ['evidence.md']);
});

step('the business gate blocks implementation', () => {
  cw('phase', 'enter', 'business');
  const blocked = run(cwBin, ['--project', project, 'phase', 'enter', 'implementation'], {
    allowFailure: true,
  });
  assert.equal(blocked.status, 1, 'entering implementation before BUSINESS_READY must fail');
  assert.match(blocked.stderr, /no edge business -> implementation/);
});

step('waiting for the user parks the run without ending it', () => {
  cw('gate', 'wait', 'BUSINESS_READY', '--message', 'aggregate or per-entity ownership?');
  const run = state();
  assert.equal(run.status, 'WAITING_USER');
  assert.equal(run.currentNode, 'await-business');
  assert.equal(run.nodes['await-business'].status, 'WAITING_USER');
});

step('a follow-up prompt continues the same run', () => {
  const before = state().runId;
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'per entity, please' });
  const after = state();
  assert.equal(after.runId, before, 'no new run was created');
  assert.equal(after.runtime.claude, 'ACTIVE');
  assert.equal(after.status, 'WAITING_USER', 'a hook must not change the semantic phase');
});

step('runtime hooks report tool and subagent activity', () => {
  hook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Grep' });
  assert.equal(state().runtime.claude, 'TOOL_RUNNING');
  assert.equal(state().runtime.tool, 'Grep');

  hook({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Grep' });
  assert.equal(state().runtime.claude, 'ACTIVE');

  hook({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', subagent_type: 'independent-reviewer' });
  assert.equal(state().runtime.claude, 'SUBAGENT_RUNNING');
  assert.equal(state().agents.a1.status, 'RUNNING');

  hook({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1' });
  assert.equal(state().agents.a1.status, 'STOPPED');

  assert.ok(!existsSync(join(project, '.ai-workflow', 'hook-errors.log')), 'no hook errors');
});

step('passing the gate releases the run', () => {
  cw('phase', 'enter', 'business');
  cw('gate', 'pass', 'BUSINESS_READY');
  const run = state();
  assert.equal(run.gates.BUSINESS_READY, 'PASSED');
  assert.equal(run.status, 'RUNNING');
});

step('run the remaining phases including a review loop', () => {
  for (const node of ['readiness', 'conventions', 'implementation', 'validation', 'e2e', 'review']) {
    cw('phase', 'enter', node);
    cw('phase', 'complete');
  }
  // Reviewer found something: legal back edge to implementation.
  cw('phase', 'enter', 'implementation');
  cw('phase', 'complete');
  cw('phase', 'enter', 'validation');
  cw('phase', 'complete');
  cw('phase', 'enter', 'e2e');
  cw('phase', 'complete');
  cw('phase', 'enter', 'review');
  cw('phase', 'complete');
  cw('phase', 'enter', 'assessment');
  cw('phase', 'complete');
  cw('phase', 'enter', 'report');
  cw('phase', 'complete');

  assert.equal(state().nodes.implementation.visits, 2, 'review loop re-entered implementation');
});

step('completing the run clears the active pointer', () => {
  const runId = state().runId;
  cw('run', 'complete');
  const run = JSON.parse(
    readFileSync(join(project, '.ai-workflow', 'runs', runId, 'state.json'), 'utf8'),
  );
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.currentNode, 'done');
  assert.ok(!existsSync(join(project, '.ai-workflow', 'current-run')));
});

// --- 3. monitor ------------------------------------------------------------

step('the monitor server reports the run', async () => {
  const { startMonitor } = await import(
    pathToFileURL(join(repoRoot, 'packages', 'monitor-server', 'dist', 'index.js')).href
  );
  monitor = startMonitor({ projectRoot: project, port: 4899, pollMs: 200 });

  const health = await fetch('http://127.0.0.1:4899/api/health').then((r) => r.json());
  assert.equal(health.ok, true);

  const snapshot = await fetch('http://127.0.0.1:4899/api/state').then((r) => r.json());
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].derivedStatus, 'COMPLETED');
  assert.ok(snapshot.workflows.some((w) => w.id === 'feature-change'));

  const detail = await fetch(
    `http://127.0.0.1:4899/api/runs/${snapshot.runs[0].runId}`,
  ).then((r) => r.json());
  assert.ok(detail.events.length > 20, `expected a full event log, got ${detail.events.length}`);
  assert.equal(detail.events[0].type, 'RUN_STARTED');
  assert.ok(detail.events.some((e) => e.type === 'GATE_WAIT'));
  assert.ok(detail.events.some((e) => e.type === 'GATE_PASS'));
  assert.ok(detail.events.some((e) => e.type === 'TOOL_START'));
  assert.deepEqual(detail.artifacts, ['evidence.md']);

  const artifact = await fetch(
    `http://127.0.0.1:4899/api/runs/${snapshot.runs[0].runId}/artifacts/evidence.md`,
  ).then((r) => r.text());
  assert.match(artifact, /C-001/);
});

step('the SSE stream pushes a new run', async () => {
  const res = await fetch('http://127.0.0.1:4899/api/stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  const readFrame = async () => {
    let buffer = '';
    while (!buffer.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed');
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer;
  };

  const first = await readFrame();
  assert.match(first, /event: snapshot/);

  cw('run', 'start', 'bug-fix', '--label', 'cancel button does nothing');
  const pushed = await readFrame();
  const payload = JSON.parse(pushed.slice(pushed.indexOf('data: ') + 6).split('\n')[0]);
  assert.equal(payload.runs.length, 2);
  assert.ok(payload.runs.some((r) => r.workflow === 'bug-fix'));

  await reader.cancel();
});

// --- 4. doctor and uninstall ----------------------------------------------

step('doctor passes on a live install', () => {
  const result = run(kitBin, ['doctor', '--project', project, '--json']);
  const checks = JSON.parse(result.stdout);
  const failures = checks.filter((c) => c.status === 'fail');
  assert.deepEqual(failures, [], `doctor reported failures: ${JSON.stringify(failures)}`);
});

step('uninstall leaves the project clean', () => {
  run(kitBin, ['uninstall', '--project', project]);
  assert.ok(!existsSync(join(project, '.claude', 'skills', 'feature-change', 'SKILL.md')));
  const claudeMd = readFileSync(join(project, 'CLAUDE.md'), 'utf8');
  assert.ok(claudeMd.includes('This line exists to prove the installer merges'));
  assert.ok(!claudeMd.includes('CW:START'));
});

// --- driver ----------------------------------------------------------------

for (const [name, fn] of steps) {
  try {
    await fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failed = true;
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
    break;
  }
}

if (monitor) await monitor.close();
rmSync(project, { recursive: true, force: true });

process.stdout.write(failed ? '\nE2E FAILED\n' : '\nE2E PASSED\n');
process.exit(failed ? 1 : 0);
