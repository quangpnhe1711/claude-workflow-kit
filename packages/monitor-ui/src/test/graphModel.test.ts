import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWorkflow } from '@claude-workflow-kit/workflow-core';
import { nodeStatusView } from '../derive.js';
import { buildGraphModel, gateSatisfied, nextSelectedRunId } from '../graphModel.js';
import type { RunView, WorkflowDefinition } from '../types.js';

const T0 = Date.parse('2026-08-03T10:00:00.000Z');
const iso = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

const feature = loadWorkflow('feature-change') as unknown as WorkflowDefinition;

function run(overrides: Partial<RunView> = {}): RunView {
  const nodes: RunView['nodes'] = {};
  for (const node of feature.nodes) nodes[node.id] = { status: 'PENDING', visits: 0 };
  nodes['prompt'] = { status: 'COMPLETED', visits: 1 };

  const base: RunView = {
    runId: 'fc-20260803-001',
    workflow: 'feature-change',
    status: 'RUNNING',
    currentNode: 'prompt',
    startedAt: iso(0),
    updatedAt: iso(0),
    lastActivityAt: iso(0),
    lastSemanticAt: iso(0),
    nodes,
    gates: { BUSINESS_READY: 'OPEN' },
    runtime: { claude: 'ACTIVE', lastEventAt: iso(0) },
    agents: {},
    artifacts: [],
    derivedStatus: 'RUNNING',
    derivedSemantic: 'OK',
  };
  return { ...base, ...overrides };
}

const edgeOf = (model: ReturnType<typeof buildGraphModel>, from: string, to: string) =>
  model.edges.find((e) => e.from === from && e.to === to)!;

// ---- node state derivation ------------------------------------------------

test('node status derivation: stored status, with STALE derived at render time', () => {
  const active = run({
    currentNode: 'evidence',
    lastActivityAt: iso(0),
    nodes: { ...run().nodes, evidence: { status: 'ACTIVE', visits: 1, startedAt: iso(0) } },
  });

  assert.equal(nodeStatusView(active, 'evidence', T0 + 10_000, 120), 'ACTIVE');
  assert.equal(nodeStatusView(active, 'evidence', T0 + 300_000, 120), 'STALE', 'silence reads as stale');
  assert.equal(nodeStatusView(active, 'business', T0 + 300_000, 120), 'PENDING', 'only the live node goes stale');
  assert.equal(nodeStatusView(active, 'prompt', T0 + 300_000, 120), 'COMPLETED');
  assert.notEqual(nodeStatusView(active, 'evidence', T0 + 300_000, 120), 'FAILED');
});

test('the graph model carries per-node artifact ownership', () => {
  const model = buildGraphModel(feature, run({ artifacts: ['implementation-plan.md'] }), T0, 120);
  const readiness = model.nodes.find((n) => n.id === 'readiness')!;
  assert.deepEqual(readiness.artifacts, [
    { name: 'implementation-plan.md', present: true },
    { name: 'impact-risk-scope.md', present: false },
    { name: 'test-strategy.md', present: false },
  ]);
  assert.deepEqual(model.nodes.find((n) => n.id === 'conventions')!.artifacts, []);
});

// ---- gate-blocked edges ---------------------------------------------------

test('gateSatisfied handles plain and negated conditions', () => {
  assert.equal(gateSatisfied('BUSINESS_READY', { BUSINESS_READY: 'PASSED' }), true);
  assert.equal(gateSatisfied('BUSINESS_READY', { BUSINESS_READY: 'OPEN' }), false);
  assert.equal(gateSatisfied('!BUSINESS_READY', { BUSINESS_READY: 'OPEN' }), true);
  assert.equal(gateSatisfied('!BUSINESS_READY', { BUSINESS_READY: 'PASSED' }), false);
});

test('a gate-blocked edge is marked and never animated', () => {
  const blocked = buildGraphModel(
    feature,
    run({
      currentNode: 'business',
      transitions: [{ from: 'business', to: 'await-business', at: iso(1) }],
    }),
    T0,
    120,
  );
  const toReadiness = edgeOf(blocked, 'business', 'readiness');
  assert.equal(toReadiness.gateBlocked, true, 'BUSINESS_READY is open');
  assert.equal(toReadiness.animated, false, 'a closed route must not look live');

  const toWaiting = edgeOf(blocked, 'business', 'await-business');
  assert.equal(toWaiting.gateBlocked, false, '!BUSINESS_READY is satisfied while the gate is open');
  assert.equal(toWaiting.animated, true);

  const passed = buildGraphModel(
    feature,
    run({
      currentNode: 'readiness',
      gates: { BUSINESS_READY: 'PASSED' },
      transitions: [{ from: 'business', to: 'readiness', at: iso(2) }],
    }),
    T0,
    120,
  );
  assert.equal(edgeOf(passed, 'business', 'readiness').animated, true);
  assert.equal(edgeOf(passed, 'business', 'await-business').gateBlocked, true);
  assert.equal(edgeOf(passed, 'business', 'await-business').animated, false);
});

// ---- active edge animation ------------------------------------------------

test('the traversed edge is the active path; unrelated edges are idle', () => {
  const nodes = { ...run().nodes };
  nodes['evidence'] = { status: 'COMPLETED', visits: 1 };
  nodes['business'] = { status: 'ACTIVE', visits: 1, startedAt: iso(0) };
  const model = buildGraphModel(
    feature,
    run({
      currentNode: 'business',
      nodes,
      transitions: [
        { from: 'prompt', to: 'evidence', at: iso(1) },
        { from: 'evidence', to: 'business', at: iso(2) },
      ],
    }),
    T0,
    120,
  );

  assert.equal(edgeOf(model, 'evidence', 'business').isActivePath, true);
  assert.equal(edgeOf(model, 'evidence', 'business').animated, true);
  assert.equal(edgeOf(model, 'prompt', 'evidence').isActivePath, false, 'an earlier hop is history');
  assert.equal(edgeOf(model, 'prompt', 'evidence').animated, false);
  assert.equal(edgeOf(model, 'validation', 'e2e').animated, false);
});

test('a review loop animates only the hop it just took (MON-02)', () => {
  const nodes = { ...run().nodes };
  for (const id of ['evidence', 'business', 'readiness', 'conventions', 'implementation', 'validation', 'e2e', 'review']) {
    nodes[id] = { status: 'COMPLETED', visits: 1 };
  }
  nodes['implementation'] = { status: 'ACTIVE', visits: 2, startedAt: iso(0) };
  const model = buildGraphModel(
    feature,
    run({
      currentNode: 'implementation',
      gates: { BUSINESS_READY: 'PASSED' },
      nodes,
      transitions: [
        { from: 'e2e', to: 'review', at: iso(10) },
        { from: 'review', to: 'implementation', at: iso(11) },
      ],
    }),
    T0,
    120,
  );

  const animated = model.edges.filter((e) => e.animated).map((e) => `${e.from}->${e.to}`);
  assert.deepEqual(animated, ['review->implementation'], 'exactly one live edge, the one just traversed');
  // Every completed predecessor used to be treated as an active path.
  assert.equal(edgeOf(model, 'conventions', 'implementation').isActivePath, false);
});

test('a terminal run has no animated edges (MON-02)', () => {
  for (const status of ['COMPLETED', 'FAILED', 'ABANDONED'] as const) {
    const model = buildGraphModel(
      feature,
      run({
        status,
        derivedStatus: status,
        currentNode: 'done',
        gates: { BUSINESS_READY: 'PASSED' },
        transitions: [{ from: 'report', to: 'done', at: iso(20) }],
      }),
      T0,
      120,
    );
    assert.deepEqual(model.edges.filter((e) => e.animated), [], `${status} must not animate`);
  }
});

// ---- waiting user ---------------------------------------------------------

test('waiting on the user is a node in the diagram, not a hidden flag', () => {
  const nodes = { ...run().nodes };
  nodes['evidence'] = { status: 'COMPLETED', visits: 1 };
  nodes['business'] = { status: 'ACTIVE', visits: 1 };
  nodes['await-business'] = { status: 'WAITING_USER', visits: 1, startedAt: iso(0) };
  const model = buildGraphModel(
    feature,
    run({
      status: 'WAITING_USER',
      derivedStatus: 'WAITING_USER',
      currentNode: 'await-business',
      gates: { BUSINESS_READY: 'WAITING' },
      nodes,
      transitions: [{ from: 'await-business', to: 'business', at: iso(5) }],
    }),
    T0 + 600_000,
    120,
  );

  const waiting = model.nodes.find((n) => n.id === 'await-business')!;
  assert.equal(waiting.status, 'WAITING_USER');
  assert.equal(waiting.isCurrent, true);
  assert.equal(waiting.node.kind, 'waiting');
  assert.notEqual(waiting.status, 'STALE', 'a human taking their time is not a stall');
  assert.equal(edgeOf(model, 'await-business', 'business').animated, true, 'the way back is live');
});

// ---- semantic lag ---------------------------------------------------------

test('semantic lag is surfaced on the run without changing any node status', () => {
  const nodes = { ...run().nodes };
  nodes['evidence'] = { status: 'ACTIVE', visits: 1, startedAt: iso(0) };
  const lagging = run({
    currentNode: 'evidence',
    nodes,
    derivedSemantic: 'SEMANTIC_LAG',
    lastSemanticAt: iso(0),
    lastRuntimeAt: iso(1800),
    lastActivityAt: iso(1800),
  });

  const model = buildGraphModel(feature, lagging, T0 + 1_800_000, 120);
  const node = model.nodes.find((n) => n.id === 'evidence')!;
  assert.equal(lagging.derivedSemantic, 'SEMANTIC_LAG');
  assert.equal(node.isCurrent, true);
  assert.equal(node.status, 'ACTIVE', 'runtime is fresh, so the node is not stale');
  assert.notEqual(node.status, 'FAILED');
  assert.equal(model.nodes.find((n) => n.id === 'implementation')!.status, 'PENDING');
});

// ---- subagent branch ------------------------------------------------------

test('running subagents branch off the current phase; stopped ones disappear', () => {
  const model = buildGraphModel(
    feature,
    run({
      currentNode: 'review',
      agents: {
        a1: { id: 'a1', name: 'independent-reviewer', status: 'RUNNING', startedAt: iso(0) },
        a2: { id: 'a2', name: 'business-analyst', status: 'STOPPED', startedAt: iso(0), finishedAt: iso(30) },
      },
    }),
    T0,
    120,
  );
  assert.deepEqual(
    model.agents.map((a) => a.id),
    ['a1'],
  );
  assert.equal(model.agents[0]!.anchor, 'review');
});

// ---- multiple run selection -----------------------------------------------

test('run selection follows the active run but never overrides a user choice', () => {
  const runs = [{ runId: 'fc-1' }, { runId: 'bf-2' }, { runId: 'g-3' }];

  assert.equal(nextSelectedRunId(null, runs, 'bf-2'), 'bf-2', 'follow the current run');
  assert.equal(nextSelectedRunId('fc-1', runs, 'bf-2'), 'fc-1', 'keep the user selection');
  assert.equal(nextSelectedRunId('gone', runs, 'bf-2'), 'bf-2', 'fall back when it disappears');
  assert.equal(nextSelectedRunId(null, runs, null), 'fc-1', 'no current run: first listed');
  assert.equal(nextSelectedRunId(null, [], null), null, 'no runs at all');
});
