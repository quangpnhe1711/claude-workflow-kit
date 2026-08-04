import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadWorkflow, loadWorkflows } from '../loader.js';
import { WorkflowRuntime } from '../runtime.js';
import { artifactsOf, gatesOf } from '../state-machine.js';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-standard-'));
  const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
  runtime.ensureRuntimeDir();
  return {
    runtime,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

test('standard-change is a bounded gate-free L2 workflow', () => {
  assert.ok(loadWorkflows().has('standard-change'));
  const def = loadWorkflow('standard-change');

  assert.deepEqual(
    def.nodes.map((n) => n.id),
    ['prompt', 'impact', 'await-decision', 'implementation', 'validation', 'done'],
  );
  assert.deepEqual(gatesOf(def), []);
  assert.equal(def.nodes.filter((n) => n.kind === 'waiting').length, 1);
  assert.equal(def.nodes.some((n) => n.id === 'e2e' || n.id === 'review' || n.id === 'assessment'), false);
  for (const node of def.nodes) assert.deepEqual(artifactsOf(node), []);
});

test('standard-change completes impact -> implementation -> validation without ceremony', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('standard-change', { label: 'bounded FE and API change' });
    assert.deepEqual(run.gates, {});
    assert.equal(
      runtime.checkMutation({ toolName: 'Edit', toolInput: { file_path: 'src/app.ts' } }).decision,
      'allow',
    );

    for (const phase of ['impact', 'implementation', 'validation']) {
      runtime.enterPhase(phase);
      runtime.completePhase();
    }
    assert.equal(runtime.completeRun().status, 'COMPLETED');
  } finally {
    cleanup();
  }
});

test('standard-change can wait for one material decision without a hard gate', () => {
  const { runtime, cleanup } = sandbox();
  try {
    runtime.startRun('standard-change');
    runtime.enterPhase('impact');
    runtime.note('Waiting for decision: should archived records remain editable?');
    const waiting = runtime.enterPhase('await-decision');
    assert.equal(waiting.status, 'WAITING_USER');
    assert.deepEqual(waiting.gates, {});
    assert.equal(
      runtime.checkMutation({ toolName: 'Edit', toolInput: { file_path: 'src/app.ts' } }).decision,
      'allow',
      'an L2 clarification is advisory, not a repository-wide hard gate',
    );
    assert.throws(
      () => runtime.completePhase(),
      /waiting node "await-decision" cannot be completed directly/,
    );
    assert.throws(
      () => runtime.skipPhase('await-decision'),
      /waiting node "await-decision" cannot be skipped directly/,
    );
    assert.equal(runtime.run(waiting.runId).status, 'WAITING_USER');
    assert.equal(runtime.run(waiting.runId).nodes['await-decision']?.status, 'WAITING_USER');
    const openDecision = runtime.events(waiting.runId).find((event) =>
      event.type === 'NOTE' && event.message?.startsWith('Waiting for decision:'),
    );
    assert.match(openDecision?.message ?? '', /archived records remain editable/);

    const resumed = runtime.enterPhase('impact');
    assert.equal(resumed.nodes['await-decision']?.status, 'COMPLETED');
    runtime.completePhase();
    runtime.enterPhase('implementation');
    runtime.completePhase();
    runtime.enterPhase('validation');
    runtime.completePhase();
    assert.equal(runtime.completeRun().status, 'COMPLETED');
  } finally {
    cleanup();
  }
});

test('standard-change escalates to an L3 topology in the same run and opens its gates', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const medium = runtime.startRun('standard-change', { label: 'permission adjustment' });
    runtime.enterPhase('impact');
    runtime.note('authorization semantics affect protected records');

    const highRisk = runtime.escalateRun('feature-change', {
      reason: 'authorization semantics affect protected records',
    });
    assert.equal(highRisk.runId, medium.runId);
    assert.equal(highRisk.workflow, 'feature-change');
    assert.deepEqual(highRisk.gates, { BUSINESS_READY: 'OPEN' });
    assert.equal(
      runtime.checkMutation({ toolName: 'Edit', toolInput: { file_path: 'src/access.ts' } }).decision,
      'deny',
    );
    assert.equal(runtime.events(medium.runId).filter((event) => event.type === 'RUN_STARTED').length, 1);
    assert.equal(runtime.events(medium.runId).filter((event) => event.type === 'RUN_ESCALATED').length, 1);
  } finally {
    cleanup();
  }
});

test('standard-change validation can loop only to implementation', () => {
  const { runtime, cleanup } = sandbox();
  try {
    runtime.startRun('standard-change');
    for (const phase of ['impact', 'implementation', 'validation']) {
      runtime.enterPhase(phase);
      runtime.completePhase();
    }
    const again = runtime.enterPhase('implementation');
    assert.equal(again.nodes['implementation']?.visits, 2);
  } finally {
    cleanup();
  }
});
