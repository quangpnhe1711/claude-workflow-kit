import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWorkflow } from '../loader.js';
import {
  TransitionError,
  applyRuntimeEvent,
  checkRunComplete,
  completeRun,
  derivedRunStatus,
  enterNode,
  initialRunState,
  passGate,
  skipNode,
  waitGate,
} from '../state-machine.js';

const T0 = '2026-08-02T10:00:00.000Z';
const def = loadWorkflow('feature-change');

function fresh() {
  return initialRunState(def, 'fc-test-001', T0);
}

test('initial state starts on the start node with open gates', () => {
  const run = fresh();
  assert.equal(run.currentNode, 'prompt');
  assert.equal(run.status, 'RUNNING');
  assert.equal(run.gates['BUSINESS_READY'], 'OPEN');
  assert.equal(run.nodes['evidence']?.status, 'PENDING');
});

test('legal transitions advance the run', () => {
  const run = fresh();
  enterNode(def, run, 'evidence', T0);
  assert.equal(run.nodes['evidence']?.status, 'ACTIVE');
  enterNode(def, run, 'business', T0);
  assert.equal(run.nodes['evidence']?.status, 'COMPLETED');
  assert.equal(run.currentNode, 'business');
});

test('an illegal transition is rejected', () => {
  const run = fresh();
  assert.throws(() => enterNode(def, run, 'implementation', T0), TransitionError);
});

test('the business gate blocks implementation until passed', () => {
  const run = fresh();
  enterNode(def, run, 'evidence', T0);
  enterNode(def, run, 'business', T0);
  assert.throws(() => enterNode(def, run, 'readiness', T0), TransitionError);
  passGate(def, run, 'BUSINESS_READY', T0);
  enterNode(def, run, 'readiness', T0);
  assert.equal(run.currentNode, 'readiness');
});

test('gate wait parks the run on the waiting node and pass releases it', () => {
  const run = fresh();
  enterNode(def, run, 'evidence', T0);
  enterNode(def, run, 'business', T0);
  waitGate(def, run, 'BUSINESS_READY', T0);
  assert.equal(run.status, 'WAITING_USER');
  assert.equal(run.currentNode, 'await-business');
  assert.equal(run.nodes['await-business']?.status, 'WAITING_USER');

  passGate(def, run, 'BUSINESS_READY', T0);
  assert.equal(run.status, 'RUNNING');
  assert.equal(run.currentNode, 'business');
  enterNode(def, run, 'readiness', T0);
  assert.equal(run.currentNode, 'readiness');
});

test('re-entering the current phase is a retry, not another visit', () => {
  const run = fresh();
  enterNode(def, run, 'evidence', T0);
  enterNode(def, run, 'evidence', T0);
  enterNode(def, run, 'evidence', T0);
  assert.equal(run.nodes['evidence']?.visits, 1, 'a duplicate emit must not inflate the loop count');
  assert.equal(run.nodes['evidence']?.status, 'ACTIVE');
});

test('a review loop can re-enter implementation', () => {
  const run = fresh();
  for (const node of ['evidence', 'business']) enterNode(def, run, node, T0);
  passGate(def, run, 'BUSINESS_READY', T0);
  for (const node of ['readiness', 'conventions', 'implementation', 'validation', 'e2e', 'review']) {
    enterNode(def, run, node, T0);
  }
  enterNode(def, run, 'implementation', T0);
  assert.equal(run.nodes['implementation']?.visits, 2);
});

test('a full workflow may skip unjustified E2E and continue to review', () => {
  const run = fresh();
  for (const node of ['evidence', 'business']) enterNode(def, run, node, T0);
  passGate(def, run, 'BUSINESS_READY', T0);
  for (const node of ['readiness', 'conventions', 'implementation', 'validation']) {
    enterNode(def, run, node, T0);
  }
  skipNode(def, run, 'e2e', T0);
  enterNode(def, run, 'review', T0);
  assert.equal(run.currentNode, 'review');
  assert.equal(run.nodes['e2e']?.status, 'SKIPPED');

  enterNode(def, run, 'assessment', T0);
  enterNode(def, run, 'report', T0);
  const validArtifacts = [
    'evidence.md',
    'business-decision.md',
    'implementation-plan.md',
    'impact-risk-scope.md',
    'test-strategy.md',
    'validation.md',
    'review.md',
    'assessment.md',
    'final-report.md',
  ];
  assert.deepEqual(checkRunComplete(def, run, validArtifacts), { ok: true, reasons: [] });
});

test('runtime events never move the semantic phase', () => {
  const run = fresh();
  enterNode(def, run, 'evidence', T0);
  applyRuntimeEvent(run, { ts: T0, type: 'TOOL_START', runId: run.runId, tool: 'Grep' });
  assert.equal(run.runtime.claude, 'TOOL_RUNNING');
  assert.equal(run.runtime.tool, 'Grep');
  assert.equal(run.currentNode, 'evidence');

  applyRuntimeEvent(run, { ts: T0, type: 'TOOL_END', runId: run.runId, tool: 'Grep' });
  assert.equal(run.runtime.claude, 'ACTIVE');
});

test('subagent lifecycle is tracked', () => {
  const run = fresh();
  applyRuntimeEvent(run, {
    ts: T0,
    type: 'SUBAGENT_START',
    runId: run.runId,
    agent: 'independent-reviewer',
    agentId: 'a1',
  });
  assert.equal(run.runtime.claude, 'SUBAGENT_RUNNING');
  assert.equal(run.agents['a1']?.status, 'RUNNING');

  applyRuntimeEvent(run, { ts: T0, type: 'SUBAGENT_STOP', runId: run.runId, agentId: 'a1' });
  assert.equal(run.agents['a1']?.status, 'STOPPED');
  assert.equal(run.runtime.claude, 'ACTIVE');
});

test('a silent run reads as POSSIBLY_STALLED, never FAILED', () => {
  const run = fresh();
  const later = new Date(Date.parse(T0) + 5 * 60_000).toISOString();
  assert.equal(derivedRunStatus(run, 120, T0), 'RUNNING');
  assert.equal(derivedRunStatus(run, 120, later), 'POSSIBLY_STALLED');
  assert.notEqual(derivedRunStatus(run, 120, later), 'FAILED');
});

test('completing a run marks the end node', () => {
  const run = fresh();
  enterNode(def, run, 'evidence', T0);
  completeRun(def, run, T0);
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.currentNode, 'done');
  assert.equal(run.nodes['done']?.status, 'COMPLETED');
});
