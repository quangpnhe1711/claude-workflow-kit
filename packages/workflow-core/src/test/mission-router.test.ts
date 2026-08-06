/**
 * The router and the monitors are pure functions, and they are where V2 either
 * keeps its promise or quietly breaks it: choose the shortest safe workflow,
 * never let risk downgrade it, and never demand ceremony a trivial task does not
 * owe. These tests pin exactly those two failure directions.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHECKPOINT_KINDS,
  MISSION_STATES,
  availableActions,
  confidenceThresholds,
  emptyMission,
  implementationReadiness,
  missionCompletionBlockers,
  missionHealthReport,
  missionMutationBlocks,
  missionProgress,
  missionStateAllowed,
  outputTemplateFor,
  requiredCheckpoints,
  routeMission,
  skippedValidation,
  topologyFor,
  validationStrategy,
  type MissionRecord,
} from '../mission.js';

const NOW = '2026-08-05T10:00:00.000Z';

function classified(overrides: Partial<MissionRecord> = {}): MissionRecord {
  const mission = emptyMission(NOW);
  mission.classification = {
    taskType: 'small-feature',
    subtypes: [],
    complexity: 'MEDIUM',
    riskLevel: 'MEDIUM',
    workflowClass: 'STANDARD',
    topology: 'standard-change',
    effort: 'MEDIUM',
    reason: 'test',
    flags: {},
    classifiedAt: NOW,
  };
  return { ...mission, ...overrides };
}

test('the shortest safe workflow wins for a trivial change', () => {
  const route = routeMission({ taskType: 'text-label', complexity: 'TRIVIAL' });
  assert.equal(route.workflowClass, 'LIGHTNING');
  assert.equal(route.topology, 'quick-fix');
  assert.deepEqual(route.requiredCheckpoints, [], 'a label change owes no human checkpoint');
  assert.deepEqual(route.validation, ['build', 'compile', 'type-check', 'targeted-static-check']);
  // The expensive steps are named as skipped, not silently absent.
  assert.ok(route.skippedValidation.includes('scoped-regression'));
  assert.ok(route.skippedValidation.includes('security-review'));
  assert.deepEqual(Object.keys(route.confidenceThresholds), ['requirement', 'scope']);
});

test('risk and structural facts can only raise the workflow, never lower it', () => {
  // Complexity says Lightning; a permission flag still forces the deep path.
  const permission = routeMission({
    taskType: 'ui-change',
    complexity: 'TRIVIAL',
    flags: { permissionOrSecurity: true },
  });
  assert.equal(permission.workflowClass, 'DEEP');
  assert.equal(permission.riskLevel, 'HIGH');
  assert.ok(permission.requiredCheckpoints.includes('HIGH_RISK'));
  assert.ok(permission.validation.includes('permission-test'));
  assert.ok(permission.validation.includes('security-review'));

  // A declared low risk cannot talk a high-complexity task down.
  const declaredLow = routeMission({ taskType: 'architecture', complexity: 'HIGH', riskLevel: 'LOW' });
  assert.equal(declaredLow.workflowClass, 'DEEP');

  // A user asking for more control gets it; asking for less does not apply.
  assert.equal(
    routeMission({ taskType: 'text-label', complexity: 'TRIVIAL', requestedClass: 'STANDARD' }).workflowClass,
    'STANDARD',
  );
  assert.equal(
    routeMission({ taskType: 'migration', complexity: 'HIGH', requestedClass: 'LIGHTNING' }).workflowClass,
    'DEEP',
  );
});

test('database, API contract and multi-module impact floor at Standard', () => {
  for (const flags of [{ databaseChange: true }, { apiContractChange: true }, { multiModule: true }]) {
    const route = routeMission({ taskType: 'crud', complexity: 'LOW', flags });
    assert.equal(route.workflowClass, 'STANDARD', JSON.stringify(flags));
    assert.equal(route.riskLevel, 'MEDIUM');
  }
});

test('analysis-only routing never lands on an implementing topology', () => {
  const research = routeMission({ taskType: 'permission', complexity: 'HIGH', flags: { analysisOnly: true } });
  assert.equal(research.workflowClass, 'RESEARCH');
  assert.equal(research.topology, 'solution-analysis');
  assert.deepEqual(research.validation, [], 'nothing is built, so nothing is validated');
});

test('Deep defect work routes to bug-fix and Deep change work to feature-change', () => {
  assert.equal(topologyFor('DEEP', 'bug-fix'), 'bug-fix');
  assert.equal(topologyFor('DEEP', 'permission', ['bug-fix']), 'bug-fix');
  assert.equal(topologyFor('DEEP', 'permission'), 'feature-change');
  assert.equal(topologyFor('FAST', 'validation'), 'quick-fix');
  assert.equal(topologyFor('STANDARD', 'api-change'), 'standard-change');
});

test('mandatory checkpoints follow the change, not the mood', () => {
  const deep = requiredCheckpoints({
    workflowClass: 'DEEP',
    complexity: 'HIGH',
    riskLevel: 'HIGH',
    taskType: 'permission',
    flags: { permissionOrSecurity: true, migration: true },
  });
  for (const kind of ['PLAN', 'INVESTIGATION', 'DESIGN', 'HIGH_RISK', 'CODE', 'RELEASE'] as const) {
    assert.ok(deep.includes(kind), `${kind} must be mandatory here`);
  }
  // Ordered by the lifecycle so a board can render them as a sequence.
  assert.deepEqual(deep, CHECKPOINT_KINDS.filter((k) => deep.includes(k)));

  const bug = requiredCheckpoints({
    workflowClass: 'FAST',
    complexity: 'LOW',
    riskLevel: 'MEDIUM',
    taskType: 'bug-fix',
  });
  assert.deepEqual(bug, ['ROOT_CAUSE'], 'a medium-risk defect owes a root cause and nothing else');

  assert.deepEqual(
    requiredCheckpoints({ workflowClass: 'LIGHTNING', complexity: 'TRIVIAL', riskLevel: 'LOW', taskType: 'css-layout' }),
    [],
  );
});

test('validation adds only the steps that close a stated risk', () => {
  const base = validationStrategy('STANDARD');
  assert.equal(base.includes('performance-check'), false);
  const migration = validationStrategy('DEEP', { migration: true, backwardCompatibility: true });
  assert.ok(migration.includes('migration-check'));
  assert.ok(migration.includes('rollback-check'));
  assert.ok(migration.includes('backward-compatibility-check'));
  assert.equal(skippedValidation(migration).includes('migration-check'), false);
});

test('confidence floors scale with depth and rise for permission work', () => {
  assert.deepEqual(Object.keys(confidenceThresholds({ taskType: 'text-label', workflowClass: 'LIGHTNING' })), [
    'requirement',
    'scope',
  ]);
  const bug = confidenceThresholds({ taskType: 'bug-fix', workflowClass: 'FAST' });
  assert.equal(bug.rootCause, 75, 'no root cause, no fix');
  const permission = confidenceThresholds({
    taskType: 'permission',
    workflowClass: 'DEEP',
    flags: { permissionOrSecurity: true },
  });
  assert.equal(permission.businessRule, 80);
  assert.equal(permission.architecture, 80);
});

test('implementation is refused until evidence, confidence and checkpoints hold', () => {
  const mission = classified();
  const empty = implementationReadiness(mission);
  assert.equal(empty.ok, false);
  assert.ok(empty.blockers.some((b) => b.includes('confidence requirement has not been assessed')));

  mission.confidence = { requirement: 80, scope: 80, businessRule: 80, design: 80, implementation: 80 };
  assert.equal(implementationReadiness(mission).ok, true);

  mission.evidence = { backend: { status: 'CONFLICTING', updatedAt: NOW } };
  const conflicting = implementationReadiness(mission);
  assert.equal(conflicting.ok, false);
  assert.ok(conflicting.blockers.some((b) => b === 'evidence backend is CONFLICTING'));

  mission.evidence = { backend: { status: 'PARTIAL', updatedAt: NOW } };
  const partial = implementationReadiness(mission);
  assert.equal(partial.ok, true, 'PARTIAL warns, it does not block');
  assert.ok(partial.warnings.some((w) => w.includes('PARTIAL')));

  mission.risks = [
    {
      id: 'R-001',
      category: 'data-loss',
      level: 'CRITICAL',
      trigger: 'delete without backup',
      status: 'OPEN',
      peakLevel: 'CRITICAL',
      updatedAt: NOW,
    },
  ];
  assert.equal(implementationReadiness(mission).ok, false, 'a CRITICAL risk stops the work');
});

test('an accepted blocker is waived but never erased', () => {
  const mission = classified();
  mission.confidence = { requirement: 80, scope: 80, businessRule: 80, design: 80, implementation: 40 };
  const before = implementationReadiness(mission);
  assert.equal(before.ok, false);
  mission.acceptances = [
    { blockers: before.blockers, reason: 'user accepts the edge case', at: NOW },
  ];
  const after = implementationReadiness(mission);
  assert.equal(after.ok, true);
  assert.ok(after.warnings.some((w) => w.startsWith('accepted risk:')), 'the waiver stays visible');
});

test('mutation blocks are facts, not judgments', () => {
  const mission = classified();
  // A confidence number below its floor gates the phase, not every write.
  mission.confidence = { requirement: 10, scope: 10, businessRule: 10, design: 10, implementation: 10 };
  assert.deepEqual(missionMutationBlocks(mission), []);

  mission.state = 'PAUSED';
  mission.pauseReason = 'user stepped away';
  assert.deepEqual(missionMutationBlocks(mission), ['mission is PAUSED: user stepped away']);

  mission.state = 'DESIGNING';
  mission.checkpoints = [
    {
      id: 'CP-001',
      kind: 'DESIGN',
      summary: 's',
      decisionRequired: 'd',
      alternatives: [],
      evidence: [],
      status: 'PENDING',
      openedAt: NOW,
    },
    {
      id: 'CP-002',
      kind: 'RELEASE',
      summary: 's',
      decisionRequired: 'd',
      alternatives: [],
      evidence: [],
      status: 'PENDING',
      openedAt: NOW,
    },
  ];
  const blocks = missionMutationBlocks(mission);
  assert.ok(blocks.some((b) => b.includes('CP-001')));
  assert.equal(
    blocks.some((b) => b.includes('CP-002')),
    false,
    'a pending RELEASE decision must not block writing the release evidence',
  );
});

test('health summarises the monitors instead of forming its own opinion', () => {
  const mission = classified();
  assert.equal(missionHealthReport(mission).health, 'HEALTHY');

  mission.offTrack = { status: 'OFF_TRACK', reason: 'reading an unrelated module', at: NOW };
  assert.equal(missionHealthReport(mission).health, 'NEEDS_ATTENTION');

  mission.risks = [
    { id: 'R-1', category: 'api', level: 'HIGH', trigger: 't', status: 'OPEN', peakLevel: 'HIGH', updatedAt: NOW },
  ];
  assert.equal(missionHealthReport(mission).health, 'AT_RISK');

  mission.checkpoints = [
    {
      id: 'CP-001',
      kind: 'DESIGN',
      summary: 's',
      decisionRequired: 'd',
      alternatives: [],
      evidence: [],
      status: 'PENDING',
      openedAt: NOW,
    },
  ];
  assert.equal(missionHealthReport(mission).health, 'BLOCKED');

  mission.risks.push({
    id: 'R-2',
    category: 'data-loss',
    level: 'CRITICAL',
    trigger: 't',
    status: 'OPEN',
    peakLevel: 'CRITICAL',
    updatedAt: NOW,
  });
  assert.equal(missionHealthReport(mission).health, 'CRITICAL');
});

test('progress is weighted by task weight, not by task count', () => {
  const mission = classified();
  const state = missionProgress(mission);
  assert.equal(state.basis, 'state');

  mission.tasks = [
    { id: 'T-1', epic: 'E1', title: 'small', status: 'DONE', weight: 1, updatedAt: NOW },
    { id: 'T-2', epic: 'E1', title: 'migration', status: 'PENDING', weight: 9, updatedAt: NOW },
    { id: 'T-3', epic: 'E2', title: 'dropped', status: 'SKIPPED', weight: 5, updatedAt: NOW },
  ];
  const weighted = missionProgress(mission);
  assert.equal(weighted.basis, 'tasks');
  assert.equal(weighted.percent, 10, '1 of 10 units of work, not 1 of 2 tasks');
  assert.equal(weighted.totalTasks, 2, 'a skipped task is not remaining work');
  assert.deepEqual(weighted.remainingTasks, ['E1: migration']);
});

test('the mission state machine refuses jumps but never traps the user', () => {
  assert.equal(missionStateAllowed('PLANNING', 'INVESTIGATING'), true);
  assert.equal(missionStateAllowed('PLANNING', 'IMPLEMENTING'), false);
  assert.equal(missionStateAllowed('INVESTIGATING', 'IMPLEMENTING'), true, 'Lightning has no design stage');
  // Human control does not depend on the phase.
  for (const from of MISSION_STATES.filter((s) => !['COMPLETED', 'CANCELLED', 'FAILED'].includes(s))) {
    assert.equal(missionStateAllowed(from, 'PAUSED'), true, `${from} -> PAUSED`);
    assert.equal(missionStateAllowed(from, 'CANCELLED'), true, `${from} -> CANCELLED`);
  }
  assert.equal(missionStateAllowed('COMPLETED', 'IMPLEMENTING'), false);
});

test('completion is a claim about deliverables and open questions', () => {
  const mission = classified();
  assert.deepEqual(missionCompletionBlockers(mission), []);
  mission.deliverables = [
    { name: 'Code', required: true, status: 'PENDING', updatedAt: NOW },
    { name: 'Changelog', required: false, status: 'SKIPPED', updatedAt: NOW },
  ];
  assert.deepEqual(missionCompletionBlockers(mission), ['required deliverable "Code" is PENDING']);
});

test('the board offers only the actions the state supports', () => {
  const mission = classified();
  assert.deepEqual(availableActions(mission), ['pause', 'cancel']);
  mission.state = 'PAUSED';
  assert.ok(availableActions(mission).includes('resume'));
  assert.equal(availableActions(mission).includes('pause'), false);
  mission.state = 'DESIGNING';
  mission.checkpoints = [
    {
      id: 'CP-001',
      kind: 'DESIGN',
      summary: 's',
      decisionRequired: 'd',
      alternatives: [],
      evidence: [],
      status: 'PENDING',
      openedAt: NOW,
    },
  ];
  for (const action of ['approve', 'reject', 'modify', 'request-more-evidence', 'proceed-anyway']) {
    assert.ok(availableActions(mission).includes(action), action);
  }
});

test('every task type resolves to a report template that the preset ships', () => {
  assert.equal(outputTemplateFor('text-label'), 'text-label.md');
  assert.equal(outputTemplateFor('permission'), 'permission-report.md');
  assert.equal(outputTemplateFor('research'), 'research-report.md');
  assert.equal(outputTemplateFor('devops'), 'implementation-report.md', 'unmapped types fall back, never crash');
});
