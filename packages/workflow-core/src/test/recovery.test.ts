import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../cli.js';
import { applyHook } from '../hooks.js';
import { WorkflowRuntime } from '../runtime.js';
import { TransitionError } from '../state-machine.js';
import { RunStateCorruptError, validateRunState } from '../store.js';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-recovery-'));
  const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
  runtime.ensureRuntimeDir();
  return { dir, runtime, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

const evidence = (runtime: WorkflowRuntime, runId: string, name: string) =>
  writeFileSync(join(runtime.paths.runDir(runId), name), `# ${name}\n`, 'utf8');

// ---- RS-01: structural validation at the storage boundary ------------------

test('valid JSON that is not a run state is corrupt, not a run', () => {
  assert.equal(validateRunState({ runId: 'x' }), '"workflow" must be a non-empty string');
  const base = {
    runId: 'fc-1',
    workflow: 'feature-change',
    status: 'RUNNING',
    currentNode: 'prompt',
    startedAt: '2026-08-03T10:00:00.000Z',
    nodes: { prompt: { status: 'COMPLETED', visits: 1 } },
    gates: { BUSINESS_READY: 'OPEN' },
    runtime: { claude: 'UNKNOWN' },
    agents: {},
  };
  assert.equal(validateRunState(base), undefined);
  assert.match(validateRunState({ ...base, status: 'ALMOST_DONE' }) ?? '', /unknown run status/);
  assert.match(validateRunState({ ...base, nodes: [] }) ?? '', /"nodes" must be an object/);
  assert.match(
    validateRunState({ ...base, nodes: { prompt: { status: 'WEIRD', visits: 1 } } }) ?? '',
    /unknown status "WEIRD"/,
  );
  assert.match(
    validateRunState({ ...base, nodes: { prompt: { status: 'ACTIVE' } } }) ?? '',
    /non-numeric visits/,
  );
  assert.match(validateRunState({ ...base, gates: { BUSINESS_READY: 'MAYBE' } }) ?? '', /unknown status "MAYBE"/);
  assert.match(validateRunState({ ...base, runtime: {} }) ?? '', /runtime\.claude/);
  assert.match(validateRunState({ ...base, currentNode: 'nowhere' }) ?? '', /no entry in "nodes"/);
});

test('a structurally invalid run reads as CORRUPT from every entry point', async () => {
  const { dir, runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    // Parseable JSON, plausible shape, still not a run.
    writeFileSync(
      runtime.paths.stateFile(run.runId),
      JSON.stringify({ runId: run.runId, workflow: 'feature-change', status: 'RUNNING' }),
      'utf8',
    );

    assert.throws(() => runtime.run(run.runId), RunStateCorruptError);
    assert.deepEqual(runtime.unreadableRunIds(), [run.runId]);
    assert.equal(await runCli(['--project', dir, 'status']), 2, 'status: distinct CORRUPT exit code');
    assert.equal(await runCli(['--project', dir, 'run', 'list']), 1, 'run list: non-zero');

    // The monitor sees the same thing: an unreadable run, surfaced not hidden.
    assert.deepEqual(runtime.activeRuns(), [], 'a corrupt run is not reported as a working run');

    // And it never blocks the user's editor.
    assert.equal(
      applyHook(runtime, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Edit' }).mutation?.decision,
      'allow',
    );
  } finally {
    cleanup();
  }
});

// ---- RS-02: a corrupt current run is not silently replaced ------------------

test('a new run is refused while the corrupt run is still the current one', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    writeFileSync(runtime.paths.stateFile(run.runId), '{ "runId": broken', 'utf8');

    assert.throws(() => runtime.startRun('bug-fix'), (error: unknown) => {
      assert.ok(error instanceof TransitionError);
      assert.match(error.message, /CORRUPT/);
      assert.match(error.message, /quarantine-current/);
      return true;
    });
    assert.equal(runtime.runIds().length, 1, 'no second run was created');
  } finally {
    cleanup();
  }
});

test('quarantine preserves the evidence, clears the pointer and audits the reason', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    evidence(runtime, run.runId, 'evidence.md');
    const broken = '{ "runId": broken';
    writeFileSync(runtime.paths.stateFile(run.runId), broken, 'utf8');

    const result = runtime.quarantineCurrentRun('corrupt state');
    assert.equal(result.runId, run.runId);
    // The corrupt file is evidence of what happened: it is never deleted.
    assert.equal(readFileSync(runtime.paths.stateFile(run.runId), 'utf8'), broken);
    assert.ok(existsSync(join(runtime.paths.runDir(run.runId), 'evidence.md')));
    assert.ok(existsSync(result.marker));
    assert.equal(runtime.currentRunId(), undefined);
    assert.deepEqual(runtime.quarantinedRunIds(), [run.runId]);
    assert.deepEqual(runtime.unreadableRunIds(), [], 'a quarantined run is no longer an open problem');

    const audit = readFileSync(runtime.paths.quarantineLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(audit[0].runId, run.runId);
    assert.equal(audit[0].reason, 'corrupt state');

    // Only now may a new run start.
    const next = runtime.startRun('bug-fix');
    assert.equal(runtime.currentRunId(), next.runId);
  } finally {
    cleanup();
  }
});

// ---- SS-01: semantic ownership ---------------------------------------------

test('a second session may not mutate the repository behind another session gate', () => {
  const { runtime, cleanup } = sandbox();
  try {
    runtime.startRun('feature-change', { label: 'owned by A' });
    applyHook(runtime, { hook_event_name: 'PreToolUse', session_id: 'A', tool_name: 'Grep' });

    const denied = applyHook(runtime, {
      hook_event_name: 'PreToolUse',
      session_id: 'B',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/orders.js' },
    });
    assert.equal(denied.mutation?.decision, 'deny', 'the gate belongs to the project, not to session A');
    assert.match(denied.mutation?.reason ?? '', /BUSINESS_READY/);
  } finally {
    cleanup();
  }
});

test('a non-owner session cannot run a semantic cw command', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    runtime.enterPhase('evidence');
    evidence(runtime, run.runId, 'evidence.md');
    runtime.enterPhase('business');
    evidence(runtime, run.runId, 'business-decision.md');
    runtime.passGate('BUSINESS_READY');
    applyHook(runtime, { hook_event_name: 'PreToolUse', session_id: 'A', tool_name: 'Grep' });
    assert.equal(runtime.run(run.runId).ownerSessionId, 'A');

    const pre = (session: string, command: string) =>
      applyHook(runtime, {
        hook_event_name: 'PreToolUse',
        session_id: session,
        tool_name: 'Bash',
        tool_input: { command },
      }).mutation;

    const denied = pre('B', 'cw run complete');
    assert.equal(denied?.decision, 'deny');
    assert.match(denied?.reason ?? '', /owned by Claude session A/);
    assert.match(denied?.reason ?? '', /cw run claim/);

    assert.equal(pre('B', 'cw status')?.decision, 'allow', 'reporting stays open');
    assert.equal(pre('A', 'cw phase enter validation')?.decision, 'allow', 'the owner is not blocked');
  } finally {
    cleanup();
  }
});

test('ownership transfers only through an explicit, audited claim', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    applyHook(runtime, { hook_event_name: 'PreToolUse', session_id: 'A', tool_name: 'Grep' });

    const asB = new WorkflowRuntime({
      projectRoot: runtime.paths.projectRoot,
      runtimeDir: '.ai-workflow',
      sessionId: 'B',
    });
    assert.throws(() => asB.enterPhase('evidence'), /owned by Claude session A/);
    assert.throws(() => asB.claimRun({}), /already owned by session A/);

    const claimed = asB.claimRun({ force: true, reason: 'session A crashed' });
    assert.equal(claimed.ownerSessionId, 'B');
    assert.ok(asB.events(run.runId).some((e) => e.type === 'RUN_CLAIMED'));
    asB.enterPhase('evidence');

    const transferred = asB.transferRun({ to: 'C', reason: 'handing back' });
    assert.equal(transferred.ownerSessionId, 'C');
    assert.ok(asB.events(run.runId).some((e) => e.type === 'RUN_TRANSFERRED'));
    assert.throws(() => asB.enterPhase('business'), /owned by Claude session C/);
  } finally {
    cleanup();
  }
});

// ---- MON-03: a failed run has no live node --------------------------------

test('a FAILED run leaves no ACTIVE or WAITING_USER node behind', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const first = runtime.startRun('feature-change');
    runtime.enterPhase('evidence');
    const failed = runtime.failRun({ message: 'evidence contradicts itself' });
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.nodes['evidence']?.status, 'FAILED');
    assert.ok(
      !Object.values(failed.nodes).some((n) => n.status === 'ACTIVE' || n.status === 'WAITING_USER'),
      'nothing may still look live under a FAILED header',
    );

    // The same holds when the run dies while parked on the user.
    runtime.abandonRun({ runId: first.runId, message: 'cleanup' });
    const second = runtime.startRun('feature-change');
    runtime.enterPhase('evidence');
    evidence(runtime, second.runId, 'evidence.md');
    runtime.enterPhase('business');
    runtime.waitGate('BUSINESS_READY', { message: 'ask the user' });
    const gateFailed = runtime.failGate('BUSINESS_READY', { message: 'user withdrew the requirement' });
    assert.equal(gateFailed.status, 'FAILED');
    assert.ok(
      !Object.values(gateFailed.nodes).some((n) => n.status === 'ACTIVE' || n.status === 'WAITING_USER'),
    );
  } finally {
    cleanup();
  }
});

// ---- HOOK-01: policy health ------------------------------------------------

test('policy health records both a working policy and a failed one', () => {
  const { runtime, cleanup } = sandbox();
  try {
    assert.equal(runtime.policyHealth(), undefined, 'nothing claimed before anything ran');

    runtime.startRun('feature-change');
    applyHook(runtime, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read' });
    assert.equal(runtime.policyHealth()?.status, 'OK');
    assert.ok(runtime.policyHealth()?.lastOkAt);

    runtime.recordPolicyEvaluation(false, new Error('cannot import runtimeUrl'));
    const degraded = runtime.policyHealth();
    assert.equal(degraded?.status, 'DEGRADED');
    assert.equal(degraded?.errorCount, 1);
    assert.match(degraded?.lastError ?? '', /cannot import runtimeUrl/);
    assert.ok(degraded?.lastOkAt, 'the last good evaluation is still on record');
  } finally {
    cleanup();
  }
});

test('enforceGates=false is reported as DISABLED, not as healthy enforcement', () => {
  const { dir, runtime, cleanup } = sandbox();
  try {
    writeFileSync(
      runtime.paths.configFile,
      JSON.stringify({ runtimeDir: '.ai-workflow', enforceGates: false }),
      'utf8',
    );
    const relaxed = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
    relaxed.startRun('feature-change');
    applyHook(relaxed, {
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/a.js' },
    });
    assert.equal(relaxed.policyHealth()?.status, 'DISABLED');
  } finally {
    cleanup();
  }
});
