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
  return { dir, runtime, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
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
    writeFileSync(join(runtime.paths.runDir(run.runId), 'evidence.md'), '# evidence\n');
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
    writeFileSync(join(runtime.paths.runDir(run.runId), 'evidence.md'), '# evidence\n');
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

test('an unrelated prompt opens a generic run, not a controlled workflow', () => {
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

test('a routed workflow promotes the prompt hook run instead of conflicting with it', async () => {
  const { dir, runtime, cleanup } = sandbox();
  try {
    applyHook(runtime, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-a',
      prompt: 'fix the bounded notification label',
    });
    const genericId = runtime.currentRunId()!;
    assert.equal(runtime.run(genericId).workflow, 'generic');

    assert.equal(
      await runCli([
        '--project', dir,
        '--runtime', '.ai-workflow',
        '--session', 'session-a',
        'run', 'start', 'quick-fix',
        '--label', 'notification label',
      ]),
      0,
    );

    const promoted = runtime.run(genericId);
    assert.equal(promoted.workflow, 'quick-fix');
    assert.equal(runtime.currentRunId(), genericId);
    assert.deepEqual(runtime.runIds(), [genericId]);
    assert.equal(runtime.events(genericId).filter((event) => event.type === 'RUN_STARTED').length, 1);
    assert.equal(runtime.events(genericId).filter((event) => event.type === 'RUN_ROUTED').length, 1);
    assert.equal(runtime.events(genericId).filter((event) => event.type === 'RUN_ESCALATED').length, 0);
  } finally {
    cleanup();
  }
});

test('the CLI escalates an active task in place and requires a concrete reason', async () => {
  const { dir, runtime, cleanup } = sandbox();
  try {
    const quick = runtime.startRun('quick-fix', { label: 'scope grows during triage' });
    await assert.rejects(
      async () => runCli([
        '--project', dir,
        '--runtime', '.ai-workflow',
        'run', 'escalate', 'standard-change',
      ]),
      /requires --reason/,
    );
    assert.equal(
      await runCli([
        '--project', dir,
        '--runtime', '.ai-workflow',
        'run', 'escalate', 'standard-change',
        '--reason', 'the behavior crosses a bounded API boundary',
      ]),
      0,
    );
    assert.equal(runtime.currentRunId(), quick.runId);
    assert.equal(runtime.run(quick.runId).workflow, 'standard-change');
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
    runtime.enterPhase('working');
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
    const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
    const runId = runtime.currentRunId()!;
    const evidence = (name: string) =>
      writeFileSync(join(runtime.paths.runDir(runId), name), `# ${name}\n`, 'utf8');

    assert.equal(await runCli([...base, 'phase', 'enter', 'root-cause']), 0);
    evidence('root-cause.md');
    assert.equal(await runCli([...base, 'gate', 'pass', 'ROOT_CAUSE_READY']), 0);
    assert.equal(await runCli([...base, 'phase', 'enter', 'business']), 0);
    evidence('business-decision.md');
    assert.equal(await runCli([...base, 'gate', 'pass', 'BUSINESS_READY']), 0);
    assert.equal(await runCli([...base, 'phase', 'enter', 'readiness']), 0);

    // A half-run workflow cannot be declared COMPLETED (HG-04).
    await assert.rejects(async () => runCli([...base, 'run', 'complete']), /cannot be completed/);

    for (const name of [
      'implementation-plan.md',
      'impact-risk-scope.md',
      'test-strategy.md',
      'validation.md',
      'review.md',
      'assessment.md',
      'final-report.md',
    ]) {
      evidence(name);
    }
    for (const node of [
      'conventions',
      'implementation',
      'validation',
      'e2e',
      'review',
      'assessment',
      'report',
    ]) {
      assert.equal(await runCli([...base, 'phase', 'enter', node]), 0, node);
      assert.equal(await runCli([...base, 'phase', 'complete']), 0, node);
    }
    assert.equal(await runCli([...base, 'run', 'complete']), 0);

    const run = runtime.run(runId);
    assert.equal(run.status, 'COMPLETED');
    assert.equal(run.gates['ROOT_CAUSE_READY'], 'PASSED');
  } finally {
    cleanup();
  }
});

for (const workflowId of ['feature-change', 'bug-fix'] as const) {
  test(`${workflowId} can skip unjustified E2E with an audited reason and still complete`, () => {
    const { runtime, cleanup } = sandbox();
    try {
      const run = runtime.startRun(workflowId, { label: 'risk-based E2E decision' });
      const evidence = (name: string) =>
        writeFileSync(join(runtime.paths.runDir(run.runId), name), `# ${name}\n`, 'utf8');
      for (const name of [
        ...(workflowId === 'bug-fix' ? ['root-cause.md'] : ['evidence.md']),
        'business-decision.md',
        'implementation-plan.md',
        'impact-risk-scope.md',
        'test-strategy.md',
        'validation.md',
        'review.md',
        'assessment.md',
        'final-report.md',
      ]) evidence(name);

      if (workflowId === 'bug-fix') {
        runtime.enterPhase('root-cause');
        runtime.passGate('ROOT_CAUSE_READY');
      } else {
        runtime.enterPhase('evidence');
      }
      runtime.enterPhase('business');
      runtime.passGate('BUSINESS_READY');
      for (const phase of ['readiness', 'conventions', 'implementation', 'validation']) {
        runtime.enterPhase(phase);
      }

      runtime.skipPhase('e2e', {
        message: 'targeted and integration checks cover the changed boundary; no remaining E2E gap',
      });
      runtime.enterPhase('review');
      runtime.enterPhase('assessment');
      runtime.enterPhase('report');
      runtime.completePhase();
      const completed = runtime.completeRun();

      assert.equal(completed.status, 'COMPLETED');
      assert.equal(completed.nodes['e2e']?.status, 'SKIPPED');
      assert.ok(
        completed.transitions?.some((transition) =>
          transition.from === 'validation' && transition.to === 'review'),
      );
      const skipped = runtime.events(run.runId).find((event) =>
        event.type === 'NODE_SKIP' && event.node === 'e2e',
      );
      assert.match(skipped?.message ?? '', /no remaining E2E gap/);
    } finally {
      cleanup();
    }
  });
}

test('the CLI refuses a gate pass with no evidence and reports a non-zero exit', async () => {
  const { dir, cleanup } = sandbox();
  const base = ['--project', dir, '--runtime', '.ai-workflow'];
  try {
    assert.equal(await runCli([...base, 'run', 'start', 'feature-change']), 0);
    assert.equal(await runCli([...base, 'phase', 'enter', 'evidence']), 0);
    const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
    writeFileSync(join(runtime.paths.runDir(runtime.currentRunId()!), 'evidence.md'), '# e\n');
    assert.equal(await runCli([...base, 'phase', 'enter', 'business']), 0);
    // No business-decision.md on disk: the gate must not open.
    await assert.rejects(async () => {
      await runCli([...base, 'gate', 'pass', 'BUSINESS_READY']);
    }, /business-decision\.md/);
  } finally {
    cleanup();
  }
});

test('conventions status is available from the CLI', async () => {
  const { dir, cleanup } = sandbox();
  try {
    assert.equal(await runCli(['--project', dir, '--runtime', '.ai-workflow', 'conventions', 'status']), 0);
  } finally {
    cleanup();
  }
});
