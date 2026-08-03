import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../cli.js';
import { inspectConventions } from '../conventions.js';
import { applyHook } from '../hooks.js';
import { loadWorkflow } from '../loader.js';
import { WorkflowRuntime } from '../runtime.js';
import {
  TransitionError,
  artifactsOf,
  checkGatePass,
  derivedSemanticStatus,
  findNode,
  initialRunState,
} from '../state-machine.js';

const T0 = '2026-08-03T10:00:00.000Z';
const at = (offsetSeconds: number) => new Date(Date.parse(T0) + offsetSeconds * 1000).toISOString();

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-gates-'));
  const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
  runtime.ensureRuntimeDir();
  return { dir, runtime, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

// ---- F9: gate pass preconditions ------------------------------------------

test('checkGatePass requires the owning phase and its evidence', () => {
  const def = loadWorkflow('feature-change');
  const run = initialRunState(def, 'fc-test-001', T0);

  const fromStart = checkGatePass(def, run, 'BUSINESS_READY', []);
  assert.equal(fromStart.ok, false);
  assert.match(fromStart.reason ?? '', /decided at "business"/);

  // Standing on the owning phase without ever having entered it is not enough.
  run.currentNode = 'business';
  const neverEntered = checkGatePass(def, run, 'BUSINESS_READY', ['business-decision.md']);
  assert.equal(neverEntered.ok, false);
  assert.match(neverEntered.reason ?? '', /never been entered/);

  run.nodes['business'] = { status: 'ACTIVE', visits: 1 };
  const noEvidence = checkGatePass(def, run, 'BUSINESS_READY', []);
  assert.equal(noEvidence.ok, false);
  assert.match(noEvidence.reason ?? '', /business-decision\.md/);

  assert.equal(checkGatePass(def, run, 'BUSINESS_READY', ['business-decision.md']).ok, true);

  // Standing on the waiting node is not enough: the run must have waited there.
  run.currentNode = 'await-business';
  const teleported = checkGatePass(def, run, 'BUSINESS_READY', ['business-decision.md']);
  assert.equal(teleported.ok, false);
  assert.match(teleported.reason ?? '', /did not reach that waiting node/);

  run.gateProvenance = { BUSINESS_READY: { waitedAtNode: 'await-business' } };
  assert.equal(checkGatePass(def, run, 'BUSINESS_READY', ['business-decision.md']).ok, true);
});

test('a gate cannot be passed from an arbitrary node through the runtime', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    assert.throws(() => runtime.passGate('BUSINESS_READY'), (e: unknown) => {
      assert.ok(e instanceof TransitionError);
      assert.match(e.message, /decided at "business"/);
      assert.match(e.message, /cw gate override/);
      return true;
    });
    assert.equal(runtime.run(run.runId).gates['BUSINESS_READY'], 'OPEN');

    runtime.enterPhase('evidence');
    writeFileSync(join(runtime.paths.runDir(run.runId), 'evidence.md'), '# e\n');
    runtime.enterPhase('business');
    assert.throws(() => runtime.passGate('BUSINESS_READY'), /business-decision\.md/);

    // An empty file is not evidence, and neither is a directory with the right name.
    writeFileSync(join(runtime.paths.runDir(run.runId), 'business-decision.md'), '');
    assert.throws(() => runtime.passGate('BUSINESS_READY'), /business-decision\.md/);

    writeFileSync(join(runtime.paths.runDir(run.runId), 'business-decision.md'), '# d\n');
    runtime.passGate('BUSINESS_READY');
    const passed = runtime.run(run.runId);
    assert.equal(passed.gates['BUSINESS_READY'], 'PASSED');
    assert.equal(passed.gateProvenance?.['BUSINESS_READY']?.decidedAtNode, 'business');
    assert.equal(passed.gateProvenance?.['BUSINESS_READY']?.ownerVisit, 1);
  } finally {
    cleanup();
  }
});

test('a directory named like the artifact does not satisfy the gate', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    runtime.enterPhase('evidence');
    writeFileSync(join(runtime.paths.runDir(run.runId), 'evidence.md'), '# e\n');
    runtime.enterPhase('business');
    mkdirSync(join(runtime.paths.runDir(run.runId), 'business-decision.md'), { recursive: true });

    assert.throws(() => runtime.passGate('BUSINESS_READY'), /business-decision\.md/);
    const state = runtime.note('checking'); // any persisted write refreshes the scan
    assert.ok(!state.artifacts.includes('business-decision.md'));
    assert.match(
      state.invalidArtifacts?.find((a) => a.name === 'business-decision.md')?.reason ?? '',
      /directory/,
    );
  } finally {
    cleanup();
  }
});

test('gate pass has no force; an override is explicit, audited and needs a reason', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    assert.throws(() => runtime.overrideGate('BUSINESS_READY', '  '), /requires --reason/);

    runtime.overrideGate('BUSINESS_READY', 'user decided verbally in the meeting');
    const state = runtime.run(run.runId);
    assert.equal(state.gates['BUSINESS_READY'], 'PASSED');
    assert.equal(
      state.gateProvenance?.['BUSINESS_READY']?.overrideReason,
      'user decided verbally in the meeting',
    );
    assert.ok(runtime.events(run.runId).some((e) => e.type === 'GATE_OVERRIDE'));
  } finally {
    cleanup();
  }
});

test('CW_STRICT=0 relaxes transitions only: it never passes a gate', async () => {
  const { dir, runtime, cleanup } = sandbox();
  const previous = process.env['CW_STRICT'];
  const cli = async (args: string[]): Promise<number> => {
    try {
      return await runCli(['--project', dir, ...args]);
    } catch {
      return 1;
    }
  };
  try {
    process.env['CW_STRICT'] = '0';
    const run = runtime.startRun('feature-change');
    // The CLI is the layer that reads CW_STRICT, so drive it the way a skill does.
    assert.equal(await cli(['gate', 'pass', 'BUSINESS_READY']), 1);
    assert.equal(runtime.run(run.runId).gates['BUSINESS_READY'], 'OPEN');
    // …while an illegal transition is downgraded and audited.
    assert.equal(await cli(['phase', 'enter', 'implementation']), 0);
    assert.ok(runtime.events(run.runId).some((e) => e.type === 'FORCED_TRANSITION'));
    // And a run that skipped its workflow cannot be declared complete.
    assert.equal(await cli(['run', 'complete']), 1);
    assert.notEqual(runtime.run(run.runId).status, 'COMPLETED');
  } finally {
    if (previous === undefined) delete process.env['CW_STRICT'];
    else process.env['CW_STRICT'] = previous;
    cleanup();
  }
});

test('a forced illegal phase transition is recorded as FORCED_TRANSITION', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    runtime.enterPhase('implementation', { force: true });
    assert.ok(
      runtime.events(run.runId).some((e) => e.type === 'FORCED_TRANSITION'),
      'CW_STRICT=0 / --force leaves an audit trail',
    );
  } finally {
    cleanup();
  }
});

// ---- F13: artifact contracts ----------------------------------------------

test('a node may declare several artifacts and they are all tracked', () => {
  const def = loadWorkflow('feature-change');
  assert.deepEqual(artifactsOf(findNode(def, 'readiness')), [
    'implementation-plan.md',
    'impact-risk-scope.md',
    'test-strategy.md',
  ]);
  assert.deepEqual(artifactsOf(findNode(def, 'business')), ['business-decision.md']);
  assert.deepEqual(artifactsOf(findNode(def, 'conventions')), []);
});

test('the artifact contract is enforced on leaving a node, not on request', () => {
  const { runtime, cleanup } = sandbox();
  const write = (runId: string, name: string) =>
    writeFileSync(join(runtime.paths.runDir(runId), name), `# ${name}\n`);
  try {
    const run = runtime.startRun('feature-change');

    // Leaving `evidence` without evidence.md is refused with no extra flag.
    runtime.enterPhase('evidence');
    assert.throws(() => runtime.completePhase(), /evidence\.md/);
    assert.throws(() => runtime.enterPhase('business'), /evidence\.md/);

    write(run.runId, 'evidence.md');
    runtime.completePhase();
    runtime.enterPhase('business');
    write(run.runId, 'business-decision.md');
    runtime.passGate('BUSINESS_READY');
    runtime.enterPhase('readiness');

    assert.deepEqual(runtime.missingArtifacts(runtime.run(run.runId), 'readiness'), [
      'implementation-plan.md',
      'impact-risk-scope.md',
      'test-strategy.md',
    ]);
    // Implementation may not begin while the readiness evidence is missing.
    assert.throws(() => runtime.enterPhase('conventions'), /implementation-plan\.md/);

    // The override exists, demands a reason, and is audited.
    assert.throws(() => runtime.enterPhase('conventions', { allowMissingArtifacts: true }), /--reason/);
    runtime.enterPhase('conventions', { allowMissingArtifacts: true, reason: 'plan lives in the ticket' });
    assert.ok(runtime.events(run.runId).some((e) => e.type === 'ARTIFACT_CONTRACT_OVERRIDE'));

    // Deleting earlier evidence is caught centrally on the next transition.
    for (const name of ['implementation-plan.md', 'impact-risk-scope.md', 'test-strategy.md']) {
      write(run.runId, name);
    }
    rmSync(join(runtime.paths.runDir(run.runId), 'evidence.md'));
    assert.throws(() => runtime.enterPhase('implementation'), /evidence\.md/);
  } finally {
    cleanup();
  }
});

test('a run cannot claim COMPLETED until the workflow actually ran', () => {
  const { runtime, cleanup } = sandbox();
  const write = (runId: string, name: string) =>
    writeFileSync(join(runtime.paths.runDir(runId), name), `# ${name}\n`);
  try {
    const run = runtime.startRun('feature-change');
    assert.throws(() => runtime.completeRun(), (e: unknown) => {
      assert.ok(e instanceof TransitionError);
      assert.match(e.message, /gate\(s\) not passed/);
      assert.match(e.message, /phase\(s\) neither completed nor skipped/);
      assert.match(e.message, /cw run abandon/);
      return true;
    });

    runtime.enterPhase('evidence');
    write(run.runId, 'evidence.md');
    runtime.completePhase();
    runtime.enterPhase('business');
    write(run.runId, 'business-decision.md');
    runtime.waitGate('BUSINESS_READY', { message: 'aggregate or per entity?' });
    // A run waiting on the user is not a finished run.
    assert.throws(() => runtime.completeRun(), /waiting on the user/);

    runtime.passGate('BUSINESS_READY');
    assert.throws(() => runtime.completeRun(), /phase\(s\) neither completed nor skipped/);

    for (const name of [
      'implementation-plan.md',
      'impact-risk-scope.md',
      'test-strategy.md',
      'validation.md',
      'review.md',
      'assessment.md',
      'final-report.md',
    ]) {
      write(run.runId, name);
    }
    for (const node of [
      'readiness',
      'conventions',
      'implementation',
      'validation',
      'e2e',
      'review',
      'assessment',
      'report',
    ]) {
      runtime.enterPhase(node);
      runtime.completePhase();
    }
    const done = runtime.completeRun();
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.currentNode, 'done');

    // ABANDONED is the escape hatch, and it never reads as success.
    const second = runtime.startRun('feature-change', { label: 'second' });
    const abandoned = runtime.abandonRun({ message: 'not needed' });
    assert.equal(abandoned.status, 'ABANDONED');
    assert.equal(abandoned.runId, second.runId);
  } finally {
    cleanup();
  }
});

test('gate wait cannot teleport the run into a waiting node', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    // From the prompt, with the owning phase never entered.
    assert.throws(() => runtime.waitGate('BUSINESS_READY'), /only be parked from its owning phase "business"/);
    assert.equal(runtime.run(run.runId).currentNode, 'prompt');
    assert.equal(runtime.run(run.runId).status, 'RUNNING');

    runtime.enterPhase('evidence');
    writeFileSync(join(runtime.paths.runDir(run.runId), 'evidence.md'), '# e\n');
    // From an unrelated phase it is still refused.
    assert.throws(() => runtime.waitGate('BUSINESS_READY'), /owning phase "business"/);

    runtime.enterPhase('business');
    const waiting = runtime.waitGate('BUSINESS_READY', { message: 'ask the user' });
    assert.equal(waiting.currentNode, 'await-business');
    assert.equal(waiting.gateProvenance?.['BUSINESS_READY']?.waitedAtNode, 'await-business');
    assert.equal(waiting.gateProvenance?.['BUSINESS_READY']?.ownerVisit, 1);
  } finally {
    cleanup();
  }
});

// ---- F6: semantic lag -----------------------------------------------------

test('semantic lag appears only when Claude is active and the phase is frozen', () => {
  const def = loadWorkflow('feature-change');
  const run = initialRunState(def, 'fc-test-002', T0);
  const threshold = 300;

  assert.equal(derivedSemanticStatus(run, threshold, T0), 'OK', 'no runtime events yet');

  run.lastRuntimeAt = at(600);
  run.lastSemanticAt = T0;
  // A runtime that is not working cannot be ahead of the diagram (SEM-01).
  for (const claude of ['IDLE', 'STOPPED', 'FAILED', 'UNKNOWN'] as const) {
    run.runtime.claude = claude;
    assert.equal(derivedSemanticStatus(run, threshold, at(600)), 'OK', claude);
  }
  for (const claude of ['ACTIVE', 'TOOL_RUNNING', 'SUBAGENT_RUNNING'] as const) {
    run.runtime.claude = claude;
    assert.equal(derivedSemanticStatus(run, threshold, at(600)), 'SEMANTIC_LAG', claude);
  }

  run.runtime.claude = 'ACTIVE';
  run.lastSemanticAt = at(590);
  assert.equal(derivedSemanticStatus(run, threshold, at(600)), 'OK', 'a fresh transition clears it');

  // Everything quiet is a stall, not a lag: POSSIBLY_STALLED already says that.
  run.lastRuntimeAt = T0;
  run.lastSemanticAt = T0;
  assert.equal(derivedSemanticStatus(run, threshold, at(6000)), 'OK');

  run.status = 'WAITING_USER';
  run.lastRuntimeAt = at(6000);
  assert.equal(derivedSemanticStatus(run, threshold, at(6000)), 'OK', 'waiting on a human is not lag');
});

test('runtime events move the runtime clock only; transitions move both', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    const semanticAfterStart = runtime.run(run.runId).lastSemanticAt;

    applyHook(runtime, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Grep' });
    const afterTool = runtime.run(run.runId);
    assert.equal(afterTool.lastSemanticAt, semanticAfterStart, 'a tool call is not progress');
    assert.ok(afterTool.lastRuntimeAt, 'but it is activity');

    runtime.enterPhase('evidence');
    assert.notEqual(runtime.run(run.runId).lastSemanticAt, semanticAfterStart);
  } finally {
    cleanup();
  }
});

// ---- F12: convention cache ------------------------------------------------

test('convention status reports missing, unrecorded, valid and stale areas', () => {
  const { dir, runtime, cleanup } = sandbox();
  try {
    const dirOf = runtime.paths.conventionsDir;

    const empty = inspectConventions(runtime.paths);
    assert.deepEqual(empty.refreshNeeded, ['code', 'comments', 'testing', 'database']);
    assert.equal(empty.areas.every((a) => a.status === 'MISSING'), true);

    writeFileSync(join(dirOf, 'code.md'), '# code\n');
    assert.equal(inspectConventions(runtime.paths).areas[0]?.status, 'UNRECORDED');

    writeFileSync(join(dir, 'sample.ts'), 'export const a = 1;\n');
    writeFileSync(
      join(dirOf, 'metadata.json'),
      JSON.stringify({
        code: { status: 'OK', last_refresh: new Date().toISOString(), evidence: ['sample.ts'] },
        repo_shape: { stacks: ['ts'] },
      }),
    );
    const fresh = inspectConventions(runtime.paths);
    const code = fresh.areas.find((a) => a.area === 'code')!;
    assert.equal(code.status, 'OK');
    assert.deepEqual(code.evidence, ['sample.ts']);
    assert.deepEqual(fresh.repoShape, { stacks: ['ts'] });

    // Evidence changed after the refresh -> stale, computed not asserted.
    writeFileSync(
      join(dirOf, 'metadata.json'),
      JSON.stringify({
        code: { status: 'OK', last_refresh: '2000-01-01T00:00:00.000Z', evidence: ['sample.ts', 'gone.ts'] },
      }),
    );
    const stale = inspectConventions(runtime.paths).areas.find((a) => a.area === 'code')!;
    assert.equal(stale.status, 'STALE');
    assert.deepEqual(stale.changedEvidence, ['sample.ts']);
    assert.deepEqual(stale.missingEvidence, ['gone.ts']);
  } finally {
    cleanup();
  }
});

test('convention metadata is validated, not believed (CONV-01)', () => {
  const { dir, runtime, cleanup } = sandbox();
  const codeArea = () => inspectConventions(runtime.paths).areas.find((a) => a.area === 'code')!;
  const meta = (value: unknown) =>
    writeFileSync(join(runtime.paths.conventionsDir, 'metadata.json'), JSON.stringify({ code: value }));
  try {
    writeFileSync(join(runtime.paths.conventionsDir, 'code.md'), '# code\n');
    writeFileSync(join(dir, 'sample.ts'), 'export const a = 1;\n');
    const now = new Date().toISOString();

    for (const [value, pattern] of [
      [{ status: 'PERFECT', last_refresh: now, evidence: ['sample.ts'] }, /not one of/],
      [{ status: 'OK', last_refresh: 'yesterday', evidence: ['sample.ts'] }, /not an ISO timestamp/],
      [{ status: 'OK', last_refresh: now, evidence: 'sample.ts' }, /evidence must be a list/],
      [{ status: 'OK', last_refresh: now, evidence: ['sample.ts', 42] }, /non-empty strings/],
      [{ status: 'OK', last_refresh: now, evidence: ['/etc/passwd'] }, /project-relative/],
      [{ status: 'OK', last_refresh: now, evidence: ['../outside.ts'] }, /escapes the project/],
      [{ status: 'OK', last_refresh: now, evidence: [] }, /no evidence files/],
    ] as Array<[unknown, RegExp]>) {
      meta(value);
      const report = codeArea();
      assert.equal(report.status, 'INVALID', JSON.stringify(value));
      assert.match(report.detail, pattern);
    }

    // An area that genuinely has no file evidence must say so on purpose.
    meta({ status: 'OK', last_refresh: now, evidence: [], allow_no_evidence: true });
    assert.equal(codeArea().status, 'OK');

    // A directory listed as evidence is not evidence.
    mkdirSync(join(dir, 'evidence-dir'), { recursive: true });
    meta({ status: 'OK', last_refresh: now, evidence: ['evidence-dir'] });
    const dirEvidence = codeArea();
    assert.equal(dirEvidence.status, 'STALE');
    assert.deepEqual(dirEvidence.missingEvidence, ['evidence-dir']);
  } finally {
    cleanup();
  }
});
