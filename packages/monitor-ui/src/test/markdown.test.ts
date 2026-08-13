/**
 * The guide renders SKILL.md files the project installed, so the parser has to
 * survive whatever a skill author wrote — and produce data, never HTML.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarkdown, parseSpans } from '../markdown.js';

test('block structure: headings, lists, code and tables', () => {
  const blocks = parseMarkdown(
    [
      '## 1. Classify',
      '',
      'Pick one **primary task type** from:',
      '',
      '- `ui-change` — a label or layout',
      '- `bug-fix`',
      '  wrapped continuation',
      '',
      '1. First',
      '2. Second',
      '',
      '```bash',
      'cw phase enter implementation',
      '```',
      '',
      '| Gate | Meaning |',
      '| --- | --- |',
      '| BUSINESS_READY | the decision exists |',
      '',
      '> No business decision, no coding.',
      '',
      '---',
    ].join('\n'),
  );

  const kinds = blocks.map((b) => b.kind);
  assert.deepEqual(kinds, ['heading', 'paragraph', 'list', 'list', 'code', 'table', 'quote', 'rule']);

  const heading = blocks[0] as Extract<(typeof blocks)[number], { kind: 'heading' }>;
  assert.equal(heading.level, 2);
  assert.equal(heading.text, '1. Classify');

  const bullets = blocks[2] as Extract<(typeof blocks)[number], { kind: 'list' }>;
  assert.equal(bullets.ordered, false);
  assert.deepEqual(bullets.items, ['`ui-change` — a label or layout', '`bug-fix` wrapped continuation']);

  const ordered = blocks[3] as Extract<(typeof blocks)[number], { kind: 'list' }>;
  assert.equal(ordered.ordered, true);
  assert.deepEqual(ordered.items, ['First', 'Second']);

  const code = blocks[4] as Extract<(typeof blocks)[number], { kind: 'code' }>;
  assert.equal(code.language, 'bash');
  assert.equal(code.text, 'cw phase enter implementation');

  const table = blocks[5] as Extract<(typeof blocks)[number], { kind: 'table' }>;
  assert.deepEqual(table.rows, [
    ['Gate', 'Meaning'],
    ['BUSINESS_READY', 'the decision exists'],
  ]);
});

test('markup inside a code fence is never parsed as markup', () => {
  const blocks = parseMarkdown(['```', '# not a heading', '- not a list', '```'].join('\n'));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.kind, 'code');
});

test('inline spans are data, so nothing can be injected as HTML', () => {
  const spans = parseSpans('run `cw status` and **stop**');
  assert.deepEqual(spans, [
    { kind: 'text', text: 'run ' },
    { kind: 'code', text: 'cw status' },
    { kind: 'text', text: ' and ' },
    { kind: 'strong', text: 'stop' },
  ]);

  const hostile = parseSpans('<img src=x onerror=alert(1)>');
  assert.deepEqual(hostile, [{ kind: 'text', text: '<img src=x onerror=alert(1)>' }]);
});

test('an empty or plain document is still a document', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('just words'), [{ kind: 'paragraph', text: 'just words' }]);
});
