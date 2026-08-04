import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWorkflow, WorkflowDefinitionError } from '../loader.js';

const workflow = (waiting: string) => `
id: schema-test
nodes:
  - id: prompt
    kind: start
  - id: work
  - id: wait
    kind: waiting
${waiting}
  - id: done
    kind: end
edges:
  - { from: prompt, to: work }
  - { from: work, to: wait }
  - { from: wait, to: work }
  - { from: work, to: done }
`;

test('a gate-free waiting node must opt into advisory semantics explicitly', () => {
  const parsed = parseWorkflow(workflow('    advisory: true'), 'advisory.yaml');
  assert.equal(parsed.nodes.find((node) => node.id === 'wait')?.advisory, true);
});

test('an ordinary waiting node with an omitted gate is rejected', () => {
  assert.throws(
    () => parseWorkflow(workflow(''), 'missing-gate.yaml'),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowDefinitionError);
      assert.match(error.message, /requires a gate or advisory: true/);
      return true;
    },
  );
});

test('a waiting node cannot be both hard-gated and advisory', () => {
  assert.throws(
    () => parseWorkflow(workflow('    gate: READY\n    advisory: true'), 'ambiguous-wait.yaml'),
    /cannot declare both gate and advisory/,
  );
});
