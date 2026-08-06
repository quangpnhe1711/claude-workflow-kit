/**
 * Mission Control through the runtime: the parts that have teeth. A checkpoint
 * that only prints is not a checkpoint, a paused mission that keeps editing is
 * not paused, and an escalation that drops the mission loses every decision the
 * task already made.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkflowRuntime } from '../runtime.js';
import { validateRunState } from '../store.js';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-mission-'));
  const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
  runtime.ensureRuntimeDir();
  return {
    dir,
    runtime,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

const edit = (runtime: WorkflowRuntime, file = 'src/app.ts') =>
  runtime.checkMutation({ toolName: 'Edit', toolInput: { file_path: file } });

/** Bring a Standard mission to the point where implementation is legitimate. */
function readyStandard(runtime: WorkflowRuntime): void {
  runtime.startRun('standard-change', { label: 'bounded change' });
  runtime.classifyMission({ taskType: 'small-feature', complexity: 'MEDIUM' });
  for (const [dimension, value] of [
    ['requirement', 85],
    ['scope', 85],
    ['businessRule', 85],
    ['design', 85],
    ['implementation', 85],
  ] as const) {
    runtime.setConfidence(dimension, value);
  }
}

test('classification routes the run and keeps one task, one run id', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const opened = runtime.startRun('quick-fix', { label: 'hide a menu item' });
    const { run, route } = runtime.classifyMission({
      taskType: 'permission',
      complexity: 'LOW',
      flags: { permissionOrSecurity: true },
    });
    assert.equal(route.workflowClass, 'DEEP');
    assert.equal(run.runId, opened.runId, 'routing escalates in place; it does not open a second run');
    assert.equal(run.workflow, 'feature-change');
    assert.equal(run.mission?.classification?.topology, 'feature-change');
    assert.equal(run.mission?.state, 'PLANNING');
    assert.deepEqual(runtime.runIds(), [opened.runId]);
    assert.ok(runtime.events(run.runId).some((e) => e.type === 'MISSION_CLASSIFIED'));
  } finally {
    cleanup();
  }
});

test('escalation carries the mission across the topology swap', () => {
  const { runtime, cleanup } = sandbox();
  try {
    runtime.startRun('quick-fix', { label: 'edit contact' });
    runtime.classifyMission({ taskType: 'crud', complexity: 'LOW' });
    runtime.setConfidence('requirement', 90);
    runtime.recordDecision({ decision: 'reuse the existing service', reason: 'one call site' });
    const escalated = runtime.escalateRun('standard-change', { reason: 'two ownership models found' });
    assert.equal(escalated.mission?.confidence.requirement, 90);
    assert.equal(escalated.mission?.decisions.length, 1);
    assert.equal(
      escalated.mission?.classification?.topology,
      'standard-change',
      'the recorded topology follows the escalation',
    );
  } finally {
    cleanup();
  }
});

test('a pending checkpoint denies repository writes and read-only work continues', () => {
  const { runtime, cleanup } = sandbox();
  try {
    readyStandard(runtime);
    assert.equal(edit(runtime).decision, 'allow', 'a Standard mission with no open question is not blocked');

    runtime.openCheckpoint({
      kind: 'DESIGN',
      summary: 'two contracts are plausible',
      decisionRequired: 'keep the legacy field or rename it',
      recommendation: 'keep the legacy field',
    });
    const denied = edit(runtime);
    assert.equal(denied.decision, 'deny');
    assert.match(denied.reason ?? '', /CP-001 \(DESIGN\) is awaiting the user/);
    assert.equal(
      runtime.checkMutation({ toolName: 'Bash', toolInput: { command: 'git diff' } }).decision,
      'allow',
      'investigation must keep working while the user decides',
    );
    assert.equal(
      runtime.checkMutation({ toolName: 'Bash', toolInput: { command: 'cw board' } }).decision,
      'allow',
      'the board itself must stay reachable',
    );

    runtime.resolveCheckpoint('CP-001', { action: 'approve', note: 'keep the legacy field' });
    assert.equal(edit(runtime).decision, 'allow');
    const resolved = runtime.mission()?.checkpoints[0];
    assert.equal(resolved?.status, 'APPROVED');
    assert.equal(resolved?.response, 'keep the legacy field');
    assert.equal(runtime.mission()?.state, 'READY_TO_IMPLEMENT');
  } finally {
    cleanup();
  }
});

test('a required checkpoint that was never opened blocks writes too', () => {
  const { runtime, cleanup } = sandbox();
  try {
    runtime.startRun('standard-change', { label: 'export contract' });
    runtime.classifyMission({
      taskType: 'api-change',
      complexity: 'MEDIUM',
      flags: { apiContractChange: true },
    });
    const denied = edit(runtime);
    assert.equal(denied.decision, 'deny');
    assert.match(denied.reason ?? '', /required PLAN checkpoint was never opened/);
    assert.match(denied.reason ?? '', /required DESIGN checkpoint was never opened/);
  } finally {
    cleanup();
  }
});

test('rejecting a checkpoint needs a note and sends the mission back, not forward', () => {
  const { runtime, cleanup } = sandbox();
  try {
    readyStandard(runtime);
    runtime.openCheckpoint({ kind: 'DESIGN', summary: 's', decisionRequired: 'pick one' });
    assert.throws(() => runtime.resolveCheckpoint('CP-001', { action: 'reject' }), /needs --note/);
    runtime.resolveCheckpoint('CP-001', { action: 'reject', note: 'use the second option' });
    assert.equal(runtime.mission()?.state, 'DESIGNING');
    assert.throws(() => runtime.resolveCheckpoint('CP-001', { action: 'approve' }), /already REJECTED/);
  } finally {
    cleanup();
  }
});

test('two pending checkpoints of the same kind are refused', () => {
  const { runtime, cleanup } = sandbox();
  try {
    readyStandard(runtime);
    runtime.openCheckpoint({ kind: 'DESIGN', summary: 's', decisionRequired: 'd' });
    assert.throws(
      () => runtime.openCheckpoint({ kind: 'DESIGN', summary: 's2', decisionRequired: 'd2' }),
      /already pending/,
    );
  } finally {
    cleanup();
  }
});

test('the implementation phase is refused while the mission is not ready', () => {
  const { runtime, cleanup } = sandbox();
  try {
    runtime.startRun('standard-change', { label: 'bounded change' });
    runtime.classifyMission({ taskType: 'small-feature', complexity: 'MEDIUM' });
    runtime.enterPhase('impact');
    assert.throws(
      () => runtime.enterPhase('implementation'),
      /confidence requirement has not been assessed/,
    );

    for (const [dimension, value] of [
      ['requirement', 85],
      ['scope', 85],
      ['businessRule', 85],
      ['design', 60],
      ['implementation', 85],
    ] as const) {
      runtime.setConfidence(dimension, value);
    }
    assert.throws(() => runtime.enterPhase('implementation'), /confidence design is 60%/);

    runtime.setConfidence('design', 80);
    assert.equal(runtime.enterPhase('implementation').currentNode, 'implementation');
    assert.equal(runtime.mission()?.state, 'IMPLEMENTING', 'the board follows the phase');
  } finally {
    cleanup();
  }
});

test('accept-risk is the only way past a blocker, and it is audited', () => {
  const { runtime, cleanup } = sandbox();
  try {
    runtime.startRun('quick-fix', { label: 'label text' });
    runtime.classifyMission({ taskType: 'text-label', complexity: 'TRIVIAL' });
    runtime.enterPhase('triage');
    assert.throws(() => runtime.enterPhase('fix'), /confidence requirement has not been assessed/);

    const accepted = runtime.acceptMissionRisk({ reason: 'one-word copy change, scope is the string' });
    assert.equal(accepted.accepted.length, 2, 'requirement and scope were both waived');
    assert.equal(runtime.enterPhase('fix').currentNode, 'fix');
    const event = runtime.events(accepted.run.runId).find((e) => e.type === 'ACCEPTED_RISK');
    assert.match(event?.message ?? '', /one-word copy change/);
    assert.throws(
      () => runtime.acceptMissionRisk({ reason: 'nothing left' }),
      /nothing to accept/,
      'the waiver cannot be used as a habit when there is no blocker',
    );
  } finally {
    cleanup();
  }
});

test('pause stops the repository; resume returns to the same state', () => {
  const { runtime, cleanup } = sandbox();
  try {
    readyStandard(runtime);
    runtime.enterPhase('impact');
    runtime.enterPhase('implementation');
    assert.equal(runtime.mission()?.state, 'IMPLEMENTING');

    runtime.pauseMission({ reason: 'user stepped away' });
    const denied = edit(runtime);
    assert.equal(denied.decision, 'deny');
    assert.match(denied.reason ?? '', /mission is PAUSED: user stepped away/);
    // A paused mission only leaves through resume; work cannot continue under it.
    assert.throws(() => runtime.setMissionState('VALIDATING'), /PAUSED -> VALIDATING is not a legal transition/);

    runtime.resumeMission();
    assert.equal(runtime.mission()?.state, 'IMPLEMENTING');
    assert.equal(edit(runtime).decision, 'allow');
  } finally {
    cleanup();
  }
});

test('cancelling a mission retires the run instead of completing it', () => {
  const { runtime, cleanup } = sandbox();
  try {
    readyStandard(runtime);
    const cancelled = runtime.cancelMission({ reason: 'the feature was dropped' });
    assert.equal(cancelled.status, 'ABANDONED', 'CANCELLED must never read as success');
    assert.equal(cancelled.mission?.state, 'CANCELLED');
    assert.equal(runtime.currentRunId(), undefined);
  } finally {
    cleanup();
  }
});

test('a mission state jump is refused unless it is forced on purpose', () => {
  const { runtime, cleanup } = sandbox();
  try {
    readyStandard(runtime);
    assert.throws(() => runtime.setMissionState('DELIVERING'), /not a legal transition/);
    const forced = runtime.setMissionState('DELIVERING', { force: true, message: 'recovered a lost session' });
    assert.equal(forced.mission?.state, 'DELIVERING');
    const event = runtime.events(forced.runId).filter((e) => e.type === 'MISSION_STATE').at(-1);
    assert.equal((event?.data as { forced?: boolean } | undefined)?.forced, true);
  } finally {
    cleanup();
  }
});

test('risk escalation is an event and CRITICAL stops implementation', () => {
  const { runtime, cleanup } = sandbox();
  try {
    readyStandard(runtime);
    runtime.recordRisk({ id: 'R-001', category: 'cache', level: 'LOW', trigger: 'permission cache observed' });
    const escalated = runtime.recordRisk({
      id: 'R-001',
      category: 'cache',
      level: 'HIGH',
      trigger: 'cache is shared across tenants',
    });
    assert.equal(escalated.escalated, true);
    assert.equal(escalated.risk.peakLevel, 'HIGH');
    assert.ok(runtime.events(escalated.run.runId).some((e) => e.type === 'RISK_ESCALATED'));

    runtime.recordRisk({ id: 'R-001', category: 'cache', level: 'CRITICAL', trigger: 'cross-tenant leak' });
    runtime.enterPhase('impact');
    assert.throws(() => runtime.enterPhase('implementation'), /CRITICAL risk R-001/);
    // Mitigating it clears the block without rewriting the history.
    runtime.recordRisk({
      id: 'R-001',
      category: 'cache',
      level: 'CRITICAL',
      trigger: 'cross-tenant leak',
      status: 'MITIGATED',
      mitigation: 'invalidate per tenant',
    });
    assert.equal(runtime.enterPhase('implementation').currentNode, 'implementation');
    assert.equal(runtime.mission()?.risks[0]?.peakLevel, 'CRITICAL');
  } finally {
    cleanup();
  }
});

test('a task added after the plan has to justify itself', () => {
  const { runtime, cleanup } = sandbox();
  try {
    readyStandard(runtime);
    runtime.addMissionTask({ epic: 'Investigation', title: 'read the export service' });
    runtime.planMission({ objective: 'add a tenant filter', scope: ['export service'] });
    runtime.setMissionState('INVESTIGATING');
    assert.throws(
      () => runtime.addMissionTask({ epic: 'Cleanup', title: 'tidy an unrelated module' }),
      /needs --reason/,
    );
    const added = runtime.addMissionTask({
      epic: 'Implementation',
      title: 'invalidate the permission cache',
      reason: 'the same cache serves notifications',
      evidence: 'NotificationService reads PermissionCache',
      weight: 3,
    });
    assert.equal(added.task.weight, 3);
    runtime.updateMissionTask('T-001', 'DONE');
    const board = runtime.missionBoard();
    assert.equal(board.progress.basis, 'tasks');
    assert.equal(board.progress.completedTasks, 1);
  } finally {
    cleanup();
  }
});

test('a run cannot complete with an open checkpoint or an undelivered deliverable', () => {
  const { runtime, cleanup } = sandbox();
  try {
    readyStandard(runtime);
    runtime.enterPhase('impact');
    runtime.completePhase();
    runtime.enterPhase('implementation');
    runtime.completePhase();
    runtime.enterPhase('validation');
    runtime.completePhase();

    runtime.setDeliverable({ name: 'Manual test checklist', required: true });
    assert.throws(() => runtime.completeRun(), /required deliverable "Manual test checklist" is PENDING/);
    runtime.setDeliverable({ name: 'Manual test checklist', required: true, status: 'DONE' });

    runtime.openCheckpoint({ kind: 'RELEASE', summary: 'deploy needs a cache flush', decisionRequired: 'release now?' });
    assert.throws(() => runtime.completeRun(), /CP-001 \(RELEASE\) is still awaiting the user/);
    runtime.resolveCheckpoint('CP-001', { action: 'approve' });

    const done = runtime.completeRun();
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.mission?.state, 'COMPLETED');
  } finally {
    cleanup();
  }
});

test('the board never leaves Current Action blank and reports state drift', () => {
  const { runtime, cleanup } = sandbox();
  try {
    readyStandard(runtime);
    const board = runtime.missionBoard();
    assert.ok(board.currentAction.length > 0);
    assert.equal(board.health.health, 'HEALTHY');
    runtime.setCurrentAction('Reading PermissionMiddleware');
    assert.equal(runtime.missionBoard().currentAction, 'Reading PermissionMiddleware');

    // A forced mission state that the topology contradicts is reported, not hidden.
    runtime.enterPhase('impact');
    runtime.setMissionState('DELIVERING', { force: true });
    assert.equal(runtime.missionBoard().stateDrift, 'INVESTIGATING');
  } finally {
    cleanup();
  }
});

test('off-track, context and scope changes are recorded on the run', () => {
  const { runtime, cleanup } = sandbox();
  try {
    readyStandard(runtime);
    runtime.setOffTrack({
      status: 'OFF_TRACK',
      expectedScope: 'export service',
      actualScope: 'billing module',
      reason: 'followed a shared helper',
      recommendation: 'return to scope',
    });
    assert.equal(runtime.missionBoard().health.health, 'NEEDS_ATTENTION');
    runtime.setOffTrack({ status: 'ON_TRACK' });
    assert.equal(runtime.missionBoard().health.health, 'HEALTHY');

    runtime.recordContextSummary({ summary: 'export + permission only', coverage: 80, degraded: true });
    assert.equal(runtime.missionBoard().health.health, 'NEEDS_ATTENTION');

    runtime.planMission({ objective: 'add a filter', scope: ['export'] });
    runtime.recordScopeChange({
      previousScope: 'export',
      newScope: 'export, notification',
      reason: 'notifications read the same permission set',
      addedTasks: ['T-010'],
    });
    assert.deepEqual(runtime.mission()?.plan?.scope, ['export', 'notification']);
    assert.equal(runtime.mission()?.scopeChanges.length, 1);
  } finally {
    cleanup();
  }
});

test('a mission with an invented state is corrupt, not empty', () => {
  const { runtime, cleanup } = sandbox();
  try {
    readyStandard(runtime);
    const run = runtime.currentRun()!;
    const raw = JSON.parse(readFileSync(runtime.paths.stateFile(run.runId), 'utf8')) as Record<
      string,
      unknown
    >;
    (raw['mission'] as Record<string, unknown>)['state'] = 'ALMOST_DONE';
    assert.match(String(validateRunState(raw)), /unknown mission state/);

    (raw['mission'] as Record<string, unknown>)['state'] = 'IMPLEMENTING';
    (raw['mission'] as Record<string, unknown>)['risks'] = 'none';
    assert.match(String(validateRunState(raw)), /"mission.risks" must be an array/);

    writeFileSync(runtime.paths.stateFile(run.runId), JSON.stringify(raw), 'utf8');
    assert.throws(() => runtime.run(run.runId), /corrupt/);
  } finally {
    cleanup();
  }
});
