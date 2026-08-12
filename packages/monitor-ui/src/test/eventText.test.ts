/**
 * The timeline must survive an event type this build has never heard of: the
 * kit adds event types faster than the UI is rebuilt, and a run whose log
 * contains one must still render.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeEvent, humaniseType, isActivityEvent } from '../eventText.js';
import type { WorkflowEvent } from '../types.js';

const at = '2026-08-12T10:00:00.000Z';

test('a known event gets a semantic label and its subject', () => {
  const line = describeEvent({ ts: at, type: 'FILE_CHANGED', runId: 'r', data: { path: 'src/a.ts' } });
  assert.equal(line.label, 'Changed');
  assert.equal(line.detail, 'src/a.ts');
  assert.equal(line.generic, false);
  assert.equal(line.tone, 'ok');

  const gate = describeEvent({ ts: at, type: 'GATE_PASS', runId: 'r', gate: 'BUSINESS_READY' });
  assert.equal(gate.label, 'Gate passed');
  assert.equal(gate.detail, 'BUSINESS_READY');
});

test('an unknown event type renders from its own name instead of crashing', () => {
  const line = describeEvent({
    ts: at,
    type: 'QUANTUM_ENTANGLED' as WorkflowEvent['type'],
    runId: 'r',
    message: 'something new happened',
  });
  assert.equal(line.label, 'Quantum entangled');
  assert.equal(line.detail, 'something new happened');
  assert.equal(line.generic, true, 'the UI flags it so nobody reads it as a supported type');
  assert.equal(line.tone, 'info');
});

test('a malformed event still produces a line', () => {
  const line = describeEvent({ ts: at, type: '' as WorkflowEvent['type'], runId: 'r' });
  assert.equal(line.label, 'Event');
  assert.equal(line.detail, undefined);
  assert.equal(humaniseType(undefined as unknown as string), 'Event');
});

test('long details are truncated, never dumped', () => {
  const line = describeEvent({ ts: at, type: 'NOTE', runId: 'r', message: 'x'.repeat(500) });
  assert.ok((line.detail ?? '').length <= 160);
  assert.ok(line.detail?.endsWith('…'));
});

test('the activity feed drops paired noise but keeps real work', () => {
  assert.equal(isActivityEvent({ ts: at, type: 'TOOL_END', runId: 'r' }), false);
  assert.equal(isActivityEvent({ ts: at, type: 'FILE_READ', runId: 'r' }), true);
  assert.equal(isActivityEvent({ ts: at, type: 'CHECKPOINT_OPENED', runId: 'r' }), true);
});
