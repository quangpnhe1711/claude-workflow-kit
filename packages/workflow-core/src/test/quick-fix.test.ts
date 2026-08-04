/**
 * The short workflow. Its whole value is that it is cheap, so the things worth
 * testing are the ones that would quietly make it expensive again (a gate, a
 * required artifact, a waiting node) or unsafe (escalating into a full workflow
 * without actually handing the gate back).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadWorkflow, loadWorkflows } from '../loader.js';
import { WorkflowRuntime } from '../runtime.js';
import { artifactsOf, gatesOf } from '../state-machine.js';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-quickfix-'));
  const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
  runtime.ensureRuntimeDir();
  return {
    dir,
    runtime,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

const edit = (runtime: WorkflowRuntime, file = 'src/app.tsx') =>
  runtime.checkMutation({ toolName: 'Edit', toolInput: { file_path: file }, sessionId: 's1' });

test('quick-fix is registered and stays short', () => {
  assert.ok(loadWorkflows().has('quick-fix'), 'quick-fix must be a built-in workflow');

  const def = loadWorkflow('quick-fix');
  assert.deepEqual(
    def.nodes.map((n) => n.id),
    ['prompt', 'triage', 'fix', 'validate', 'done'],
    'triage -> fix -> validate is the whole flow',
  );

  // No gates, so nothing can park on the user and nothing blocks an edit.
  assert.deepEqual(gatesOf(def), []);
  assert.equal(def.nodes.filter((n) => n.kind === 'waiting').length, 0);

  // No declared artifacts: a small fix must not owe the runtime any documents.
  for (const node of def.nodes) {
    assert.deepEqual(artifactsOf(node), [], `${node.id} must not declare an artifact`);
  }

  // The one loop it needs: focused validation failure goes back to the fix.
  assert.ok(def.edges.some((e) => e.from === 'validate' && e.to === 'fix'));
  assert.ok(def.edges.some((e) => e.from === 'validate' && e.to === 'done'));
});

// A. "Cho MNG hiển thị nút Tạo Action. Backend đã có quyền."
test('a normal quick fix runs triage -> fix -> validate -> done with no artifacts', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const opened = runtime.startRun('quick-fix', { label: 'MNG sees Create Action' });
    assert.equal(opened.workflow, 'quick-fix');
    assert.deepEqual(opened.gates, {}, 'no BUSINESS_READY, no ROOT_CAUSE_READY');

    // The behavioural difference from the full workflows: editing source is
    // allowed immediately, because there is no gate to earn first.
    assert.equal(edit(runtime).decision, 'allow');

    for (const phase of ['triage', 'fix', 'validate']) {
      runtime.enterPhase(phase);
      const mid = runtime.completePhase();
      assert.notEqual(mid.status, 'WAITING_USER', `${phase} must never wait on the user`);
    }

    const done = runtime.completeRun();
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.currentNode, 'done');
    assert.deepEqual(done.artifacts, [], 'completion must not require evidence files');
    assert.equal(runtime.events(done.runId).some((e) => e.type === 'GATE_WAIT'), false);
  } finally {
    cleanup();
  }
});

// B. Focused validation failure loops back to the fix without any ceremony.
test('a focused validation failure re-enters fix', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('quick-fix', { label: 'duplicate import' });
    for (const phase of ['triage', 'fix', 'validate']) {
      runtime.enterPhase(phase);
      runtime.completePhase();
    }
    const again = runtime.enterPhase('fix');
    assert.equal(again.currentNode, 'fix');
    assert.equal(again.nodes['fix']?.visits, 2);
    runtime.completePhase();
    runtime.enterPhase('validate');
    runtime.completePhase();
    assert.equal(runtime.completeRun().status, 'COMPLETED');
    assert.equal(runtime.run(run.runId).status, 'COMPLETED');
  } finally {
    cleanup();
  }
});

// C. "Cho phép sửa Liên lạc" — triage finds bounded multi-layer impact.
test('escalating to standard-change keeps the same task run without adding a hard gate', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const quick = runtime.startRun('quick-fix', { label: 'edit Liên lạc' });
    runtime.enterPhase('triage');
    // Whatever triage learned is recorded on the run it was learned in.
    runtime.note('two communication types with different ownership; scope unspecified');

    const escalated = runtime.escalateRun('standard-change', {
      reason: 'escalated L1 -> L2: two communication types need bounded impact analysis',
    });
    assert.equal(escalated.runId, quick.runId, 'escalation preserves one task / one run');
    assert.equal(escalated.workflow, 'standard-change');
    assert.deepEqual(escalated.gates, {});
    assert.equal(escalated.status, 'RUNNING');
    assert.deepEqual(runtime.runIds(), [quick.runId]);
    const event = runtime.events(quick.runId).find((item) => item.type === 'RUN_ESCALATED');
    assert.match(event?.message ?? '', /escalated L1 -> L2/);
    assert.deepEqual(event?.data, { fromWorkflow: 'quick-fix', toWorkflow: 'standard-change' });

    assert.equal(edit(runtime).decision, 'allow', 'L2 stays gate-free');
  } finally {
    cleanup();
  }
});

// D. Root cause still uncertain after the narrow investigation, but risk is bounded.
test('uncertain bounded root cause escalates to standard-change, not the full bug workflow', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const quick = runtime.startRun('quick-fix', { label: 'popup covers Submit' });
    runtime.enterPhase('triage');

    const escalated = runtime.escalateRun('standard-change', {
      reason: 'escalated L1 -> L2: root cause not established from the direct path',
    });
    assert.deepEqual(escalated.gates, {});
    assert.equal(escalated.runId, quick.runId);
    assert.equal(runtime.run(quick.runId).workflow, 'standard-change');

    assert.equal(edit(runtime).decision, 'allow');
  } finally {
    cleanup();
  }
});

test('a concrete L3 defect escalation restores the full root-cause gate', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const quick = runtime.startRun('quick-fix', { label: 'authorization leak' });
    runtime.enterPhase('triage');

    const escalated = runtime.escalateRun('bug-fix', {
      reason: 'escalated L1 -> L3: authorization semantics affect protected data',
    });
    assert.equal(escalated.runId, quick.runId);
    assert.equal(escalated.gates['ROOT_CAUSE_READY'], 'OPEN');
    assert.equal(runtime.run(quick.runId).workflow, 'bug-fix');

    const denied = edit(runtime);
    assert.equal(denied.decision, 'deny');
    assert.match(denied.reason ?? '', /ROOT_CAUSE_READY/);
  } finally {
    cleanup();
  }
});

// A quick fix must not become an escape hatch from a gate that is already open.
test('quick-fix cannot be opened alongside a gated run by accident', () => {
  const { runtime, cleanup } = sandbox();
  try {
    runtime.startRun('feature-change', { label: 'real change' });
    assert.throws(() => runtime.startRun('quick-fix'), /still active/);

    // Even forced, a gated run may only be superseded with a stated reason.
    assert.throws(() => runtime.startRun('quick-fix', { force: true }), /deliberate decision/);

    // And while that gate is open, the hook still refuses source edits.
    assert.equal(edit(runtime).decision, 'deny');
  } finally {
    cleanup();
  }
});

test('a quick-fix run does not block writing an unrelated file either way', () => {
  const { runtime, cleanup } = sandbox();
  try {
    runtime.startRun('quick-fix', { label: 'label text' });
    runtime.enterPhase('triage');
    runtime.completePhase();
    runtime.enterPhase('fix');
    writeFileSync(join(runtime.paths.projectRoot, 'note.txt'), 'x');
    assert.equal(edit(runtime, 'note.txt').decision, 'allow');
    assert.equal(
      runtime.checkMutation({ toolName: 'Bash', toolInput: { command: 'npm run typecheck' } }).decision,
      'allow',
      'focused validation commands must run without ceremony',
    );
  } finally {
    cleanup();
  }
});
