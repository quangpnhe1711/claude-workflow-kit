import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWorkflow } from '@claude-workflow-kit/workflow-core';
import { layout, NODE_HEIGHT, NODE_WIDTH } from '../layout.js';
import type { WorkflowDefinition } from '../types.js';

test('an advisory wait is anchored beside its incoming phase', () => {
  const standard = loadWorkflow('standard-change') as unknown as WorkflowDefinition;
  const placed = layout(standard);
  const prompt = placed.get('prompt')!;
  const impact = placed.get('impact')!;
  const waiting = placed.get('await-decision')!;

  assert.equal(waiting.rank, impact.rank);
  assert.notEqual(waiting.rank, prompt.rank, 'undefined gates must not match the first ungated node');
  assert.ok(waiting.x >= impact.x + NODE_WIDTH);
  assert.equal(waiting.y, impact.y + (NODE_HEIGHT + 78) / 2);
});
