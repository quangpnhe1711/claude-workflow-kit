import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../cli.js';
import { applyHook } from '../hooks.js';
import { WorkflowRuntime } from '../runtime.js';
import { TransitionError } from '../state-machine.js';
import { RunStateCorruptError, readSessions } from '../store.js';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-corr-'));
  const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
  runtime.ensureRuntimeDir();
  return { dir, runtime, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

const prompt = (session: string, text: string) => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: session,
  prompt: text,
});

// ---- F3: session lifecycle ------------------------------------------------

test('SessionStart alone never opens a run', () => {
  const { runtime, cleanup } = sandbox();
  try {
    applyHook(runtime, { hook_event_name: 'SessionStart', session_id: 's1' });
    assert.deepEqual(runtime.runIds(), [], 'starting a session is not doing work');
  } finally {
    cleanup();
  }
});

test('repeated Claude sessions do not accumulate dead generic runs', () => {
  const { runtime, cleanup } = sandbox();
  try {
    for (const session of ['s1', 's2', 's3']) {
      applyHook(runtime, { hook_event_name: 'SessionStart', session_id: session });
      applyHook(runtime, prompt(session, 'explain the notification module'));
      applyHook(runtime, { hook_event_name: 'SessionEnd', session_id: session });
    }
    const runs = runtime.runIds().map((id) => runtime.run(id));
    assert.equal(runs.length, 3, 'one generic run per session that actually did something');
    assert.deepEqual(
      runs.map((r) => r.status),
      ['COMPLETED', 'COMPLETED', 'COMPLETED'],
      'SessionEnd closes a generic run instead of leaving it RUNNING forever',
    );
    assert.equal(runtime.activeRuns().length, 0);
    assert.equal(runtime.currentRunId(), undefined);
  } finally {
    cleanup();
  }
});

// ---- F4: session -> run correlation ---------------------------------------

test('a hook from session B does not mutate session A run', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change', { label: 'owned by A' });
    // A adopts the run on its first hook event.
    applyHook(runtime, { hook_event_name: 'PreToolUse', session_id: 'A', tool_name: 'Grep' });
    assert.equal(runtime.run(run.runId).ownerSessionId, 'A');
    assert.equal(runtime.run(run.runId).runtime.tool, 'Grep');

    applyHook(runtime, { hook_event_name: 'PreToolUse', session_id: 'B', tool_name: 'Bash' });
    const after = runtime.run(run.runId);
    assert.equal(after.runtime.tool, 'Grep', "B's tool must not overwrite A's run");
    assert.equal(after.ownerSessionId, 'A');
    assert.equal(runtime.runIds().length, 1, 'B did not silently fork a run either');

    assert.equal(readSessions(runtime.paths)['A']?.runId, run.runId);
    assert.equal(readSessions(runtime.paths)['B'], undefined);
  } finally {
    cleanup();
  }
});

test('a session keeps its own run after the global pointer moves on', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const first = runtime.startRun('generic', { sessionId: 'A' });
    applyHook(runtime, prompt('A', 'first task'));
    runtime.enterPhase('working', { runId: first.runId });
    runtime.completeRun({ runId: first.runId });

    const second = runtime.startRun('feature-change', { sessionId: 'B', label: 'second' });
    applyHook(runtime, { hook_event_name: 'PreToolUse', session_id: 'B', tool_name: 'Read' });
    assert.equal(runtime.run(second.runId).ownerSessionId, 'B');
    // A's binding was released when its run completed, so A gets its own run.
    assert.equal(runtime.runForSession('A'), undefined);
  } finally {
    cleanup();
  }
});

// ---- F5: duplicate run prevention -----------------------------------------

test('starting a second run while one is active fails with a usable message', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const first = runtime.startRun('feature-change', { label: 'first' });
    runtime.enterPhase('evidence');
    writeFileSync(join(runtime.paths.runDir(first.runId), 'evidence.md'), '# e\n');
    runtime.enterPhase('business');
    runtime.waitGate('BUSINESS_READY', { message: 'aggregate or per entity?' });

    assert.throws(
      () => runtime.startRun('feature-change', { label: 'second' }),
      (error: unknown) => {
        assert.ok(error instanceof TransitionError);
        assert.match(error.message, /still active/);
        assert.match(error.message, /cw run abandon/);
        assert.match(error.message, /--force/);
        return true;
      },
    );

    const parked = runtime.run(first.runId);
    assert.equal(parked.status, 'WAITING_USER', 'the parked run is untouched');
    assert.deepEqual(runtime.runIds(), [first.runId]);
  } finally {
    cleanup();
  }
});

test('--force retires the previous run explicitly instead of orphaning it', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const first = runtime.startRun('feature-change', { label: 'first' });

    // Superseding a run whose gate is still closed is a way past that gate, so
    // it is not available as a bare command.
    assert.throws(
      () => runtime.startRun('bug-fix', { label: 'second', force: true }),
      /still behind unpassed gate\(s\)/,
    );
    assert.equal(runtime.run(first.runId).status, 'RUNNING');

    const second = runtime.startRun('bug-fix', {
      label: 'second',
      force: true,
      reason: 'the feature request was withdrawn',
    });

    const retired = runtime.run(first.runId);
    assert.equal(retired.status, 'ABANDONED');
    assert.match(retired.error ?? '', /superseded/);
    assert.match(retired.error ?? '', /withdrawn/);
    assert.ok(
      runtime.events(first.runId).some((e) => e.type === 'RUN_ABANDONED'),
      'the handover is in the event log',
    );
    assert.equal(runtime.currentRunId(), second.runId);
  } finally {
    cleanup();
  }
});

test('cw run abandon retires the current run and clears the pointer', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    // Leaving an open gate behind is a decision, not a default.
    assert.throws(() => runtime.abandonRun({}), /needs a stated reason/);
    runtime.abandonRun({ message: 'requirements withdrawn' });
    assert.match(
      runtime.events(run.runId).find((e) => e.type === 'RUN_ABANDONED')?.message ?? '',
      /unpassed gate\(s\): BUSINESS_READY/,
    );
    assert.equal(runtime.run(run.runId).status, 'ABANDONED');
    assert.equal(runtime.currentRunId(), undefined);
    // A retired run frees the slot.
    const next = runtime.startRun('bug-fix');
    assert.equal(runtime.currentRunId(), next.runId);
  } finally {
    cleanup();
  }
});

test('a WAITING_USER run resumes in place: the answer does not fork a run', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change', { label: 'edit history' });
    runtime.enterPhase('evidence');
    writeFileSync(join(runtime.paths.runDir(run.runId), 'evidence.md'), '# e\n');
    runtime.enterPhase('business');
    writeFileSync(join(runtime.paths.runDir(run.runId), 'business-decision.md'), '# decision\n');
    runtime.waitGate('BUSINESS_READY', { message: 'aggregate or per entity?' });

    applyHook(runtime, prompt('A', 'per entity, please'));

    assert.deepEqual(runtime.runIds(), [run.runId]);
    const parked = runtime.run(run.runId);
    assert.equal(parked.status, 'WAITING_USER', 'a hook never moves the semantic phase');
    assert.equal(parked.runtime.claude, 'ACTIVE');

    runtime.enterPhase('business');
    runtime.passGate('BUSINESS_READY');
    assert.equal(runtime.run(run.runId).status, 'RUNNING');
    assert.deepEqual(runtime.runIds(), [run.runId], 'still one run');
  } finally {
    cleanup();
  }
});

// ---- F7: corrupt state ----------------------------------------------------

test('a corrupt active run is reported as corrupt, not as "no active run"', async () => {
  const { dir, runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    writeFileSync(runtime.paths.stateFile(run.runId), '{ "runId": broken', 'utf8');

    assert.throws(() => runtime.currentRun(), RunStateCorruptError);
    assert.equal(runtime.currentRunSafe(), undefined, 'the safe accessor still degrades quietly');

    const code = await runCli(['--project', dir, '--runtime', '.ai-workflow', 'status']);
    assert.equal(code, 2, 'distinct non-zero exit code, not 0/"no active run"');

    const listCode = await runCli(['--project', dir, '--runtime', '.ai-workflow', 'run', 'list']);
    assert.equal(listCode, 1, 'run list reports the unreadable run instead of crashing');
  } finally {
    cleanup();
  }
});

test('a corrupt run never blocks a tool call', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    writeFileSync(runtime.paths.stateFile(run.runId), 'not json', 'utf8');
    const result = applyHook(runtime, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Edit' });
    assert.equal(result.mutation?.decision, 'allow', 'a broken kit must never block the user');
  } finally {
    cleanup();
  }
});

test('a truncated state file is distinguished from a missing one', () => {
  const { dir, runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('generic');
    const file = runtime.paths.stateFile(run.runId);
    const good = readFileSync(file, 'utf8');
    writeFileSync(file, good.slice(0, good.length / 2), 'utf8');
    assert.throws(() => runtime.run(run.runId), RunStateCorruptError);
    assert.throws(() => runtime.run('does-not-exist'), /not found/);
  } finally {
    cleanup();
  }
});
