import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkflowRuntime } from '../runtime.js';
import { applyHook } from '../hooks.js';
import { runCli } from '../cli.js';

function sandbox(): { dir: string; runtime: WorkflowRuntime; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
  const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
  runtime.ensureRuntimeDir();
  return { dir, runtime, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a run persists state, events and the current-run pointer', () => {
  const { dir, runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change', { label: 'edit history' });
    assert.match(run.runId, /^fc-\d{8}-\d{3}$/);
    assert.ok(existsSync(join(dir, '.ai-workflow', 'runs', run.runId, 'state.json')));
    assert.ok(existsSync(join(dir, '.ai-workflow', 'runs', run.runId, 'events.jsonl')));
    assert.equal(runtime.currentRunId(), run.runId);

    runtime.enterPhase('evidence');
    runtime.completePhase();
    runtime.enterPhase('business');
    runtime.waitGate('BUSINESS_READY', { message: 'aggregate vs per-entity?' });

    const parked = runtime.run(run.runId);
    assert.equal(parked.status, 'WAITING_USER');

    const types = runtime.events(run.runId).map((e) => e.type);
    assert.deepEqual(types, [
      'RUN_STARTED',
      'NODE_ENTER',
      'NODE_COMPLETE',
      'NODE_ENTER',
      'GATE_WAIT',
    ]);
  } finally {
    cleanup();
  }
});

test('a follow-up prompt continues the same run instead of starting a new one', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    runtime.enterPhase('evidence');
    runtime.enterPhase('business');
    runtime.waitGate('BUSINESS_READY');

    applyHook(runtime, { hook_event_name: 'UserPromptSubmit', prompt: 'per-entity please' });

    assert.deepEqual(runtime.runIds(), [run.runId]);
    assert.equal(runtime.run(run.runId).runtime.claude, 'ACTIVE');
    assert.equal(runtime.run(run.runId).status, 'WAITING_USER');
  } finally {
    cleanup();
  }
});

test('a prompt with no active run opens a generic run', () => {
  const { runtime, cleanup } = sandbox();
  try {
    applyHook(runtime, { hook_event_name: 'UserPromptSubmit', prompt: 'what does this repo do' });
    const ids = runtime.runIds();
    assert.equal(ids.length, 1);
    const run = runtime.run(ids[0]!);
    assert.equal(run.workflow, 'generic');
    assert.equal(run.currentNode, 'working');
  } finally {
    cleanup();
  }
});

test('a tool hook alone never opens a run', () => {
  const { runtime, cleanup } = sandbox();
  try {
    applyHook(runtime, { hook_event_name: 'PreToolUse', tool_name: 'Grep' });
    assert.deepEqual(runtime.runIds(), []);
  } finally {
    cleanup();
  }
});

test('completing a run clears the current-run pointer', () => {
  const { runtime, cleanup } = sandbox();
  try {
    runtime.startRun('generic');
    runtime.completeRun();
    assert.equal(runtime.currentRunId(), undefined);
  } finally {
    cleanup();
  }
});

test('artifacts written into the run directory are picked up', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    writeFileSync(join(runtime.paths.runDir(run.runId), 'evidence.md'), '# evidence\n');
    runtime.artifact('evidence.md');
    assert.deepEqual(runtime.run(run.runId).artifacts, ['evidence.md']);
  } finally {
    cleanup();
  }
});

test('the CLI drives a full run end to end', async () => {
  const { dir, cleanup } = sandbox();
  const base = ['--project', dir, '--runtime', '.ai-workflow'];
  try {
    assert.equal(await runCli([...base, 'run', 'start', 'bug-fix']), 0);
    assert.equal(await runCli([...base, 'phase', 'enter', 'root-cause']), 0);
    assert.equal(await runCli([...base, 'gate', 'pass', 'ROOT_CAUSE_READY']), 0);
    assert.equal(await runCli([...base, 'phase', 'enter', 'business']), 0);
    assert.equal(await runCli([...base, 'gate', 'pass', 'BUSINESS_READY']), 0);
    assert.equal(await runCli([...base, 'phase', 'enter', 'readiness']), 0);
    assert.equal(await runCli([...base, 'run', 'complete']), 0);

    const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
    const run = runtime.run(runtime.runIds()[0]!);
    assert.equal(run.status, 'COMPLETED');
    assert.equal(run.gates['ROOT_CAUSE_READY'], 'PASSED');
  } finally {
    cleanup();
  }
});
