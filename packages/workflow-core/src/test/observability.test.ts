/**
 * The observability spine: redaction, the fold, pagination and the history
 * index. The three properties that matter here are that nothing sensitive
 * reaches disk, that a missing metric stays missing instead of becoming zero,
 * and that every derived artefact can be deleted and rebuilt identically.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkflowRuntime } from '../runtime.js';
import { foldRollup } from '../rollup.js';
import { indexEntry, queryRuns, readRunIndex, type RunIndexEntry } from '../run-index.js';
import { readEventPage, readEvents } from '../store.js';
import { OUTSIDE_PROJECT, UNKNOWN_PROGRAM, observe, safePath, safePrograms } from '../telemetry.js';
import { readSessionUsage } from '../usage.js';
import { DEFAULT_CONFIG, type RunState, type WorkflowEvent } from '../types.js';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-obs-'));
  const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
  runtime.ensureRuntimeDir();
  return {
    dir,
    runtime,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

const config = DEFAULT_CONFIG;

// ---- redaction -------------------------------------------------------------

test('a path is recorded relative to the project, or not at all', () => {
  const root = process.platform === 'win32' ? 'D:\\work\\app' : '/work/app';
  assert.equal(safePath(join(root, 'src', 'a.ts'), root), 'src/a.ts');
  assert.equal(safePath('src/a.ts', root), 'src/a.ts');
  const outside = process.platform === 'win32' ? 'D:\\Users\\someone\\.ssh\\id_rsa' : '/home/someone/.ssh/id_rsa';
  assert.equal(
    safePath(outside, root),
    OUTSIDE_PROJECT,
    'a path outside the project names a user; count it, never record it',
  );
});

test('a command is reduced to program names, never the command line', () => {
  assert.deepEqual(safePrograms('npm test -- --token=SECRET'), ['npm']);
  assert.deepEqual(safePrograms('git status && npm run build'), ['git', 'npm']);
  assert.deepEqual(safePrograms('curl -H "Authorization: Bearer sk-live-123" https://x'), ['curl']);
  assert.deepEqual(safePrograms('./weird\u0000name'), [UNKNOWN_PROGRAM]);
});

test('telemetry persists only a normalised path or program, and nothing else', () => {
  const root = process.platform === 'win32' ? 'D:\\work\\app' : '/work/app';
  const write = observe({
    phase: 'end',
    toolName: 'Write',
    toolInput: {
      file_path: join(root, 'src', 'secret.ts'),
      content: 'API_KEY=sk-live-abc123',
    },
    projectRoot: root,
    config,
  });
  assert.deepEqual(write, [{ type: 'FILE_CHANGED', data: { path: 'src/secret.ts' } }]);
  for (const observation of write) {
    assert.deepEqual(Object.keys(observation.data), ['path'], 'no other field may reach disk');
  }

  const command = observe({
    phase: 'start',
    toolName: 'Bash',
    toolInput: { command: 'psql "postgres://user:hunter2@host/db" -c "select 1"' },
    projectRoot: root,
    config,
  });
  assert.deepEqual(command, [{ type: 'COMMAND_STARTED', data: { executable: 'psql' } }]);
});

test('a test command is a test event; an unclassifiable tool records nothing', () => {
  const root = process.cwd();
  assert.deepEqual(
    observe({ phase: 'end', toolName: 'Bash', toolInput: { command: 'npm test' }, projectRoot: root, config }),
    [{ type: 'TEST_PASSED', data: { executable: 'npm' } }],
  );
  assert.deepEqual(
    observe({ phase: 'fail', toolName: 'Bash', toolInput: { command: 'pytest -q' }, projectRoot: root, config }),
    [{ type: 'TEST_FAILED', data: { executable: 'pytest' } }],
  );
  assert.deepEqual(
    observe({ phase: 'end', toolName: 'WebFetch', toolInput: { url: 'https://x' }, projectRoot: root, config }),
    [],
    'an unknown tool is not a reason to persist its arguments',
  );
  assert.deepEqual(
    observe({ phase: 'start', toolName: 'Write', toolInput: { file_path: 'a.ts' }, projectRoot: root, config }),
    [],
    'a write is recorded when it happened, not when it was requested',
  );
});

// ---- the fold --------------------------------------------------------------

function run(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'r-1',
    workflow: 'bug-fix',
    status: 'RUNNING',
    currentNode: 'analysis',
    startedAt: '2026-08-12T10:00:00.000Z',
    updatedAt: '2026-08-12T10:05:00.000Z',
    lastActivityAt: '2026-08-12T10:05:00.000Z',
    lastSemanticAt: '2026-08-12T10:05:00.000Z',
    nodes: {
      intake: { status: 'COMPLETED', visits: 1, startedAt: '2026-08-12T10:00:00.000Z', finishedAt: '2026-08-12T10:01:00.000Z' },
      analysis: { status: 'ACTIVE', visits: 1, startedAt: '2026-08-12T10:01:00.000Z' },
    },
    gates: {},
    runtime: { claude: 'ACTIVE' },
    agents: {},
    artifacts: [],
    ...overrides,
  };
}

const events: WorkflowEvent[] = [
  { ts: '2026-08-12T10:00:00.000Z', type: 'RUN_STARTED', runId: 'r-1', node: 'intake' },
  { ts: '2026-08-12T10:00:30.000Z', type: 'NODE_ENTER', runId: 'r-1', node: 'intake' },
  { ts: '2026-08-12T10:00:40.000Z', type: 'TOOL_START', runId: 'r-1', tool: 'Read' },
  { ts: '2026-08-12T10:00:41.000Z', type: 'FILE_READ', runId: 'r-1', data: { path: 'src/a.ts' } },
  { ts: '2026-08-12T10:01:00.000Z', type: 'NODE_ENTER', runId: 'r-1', node: 'analysis' },
  { ts: '2026-08-12T10:01:10.000Z', type: 'TOOL_START', runId: 'r-1', tool: 'Edit' },
  { ts: '2026-08-12T10:01:11.000Z', type: 'FILE_CHANGED', runId: 'r-1', data: { path: 'src/b.ts' } },
  { ts: '2026-08-12T10:01:20.000Z', type: 'COMMAND_STARTED', runId: 'r-1', data: { executable: 'git' } },
  { ts: '2026-08-12T10:01:25.000Z', type: 'COMMAND_COMPLETED', runId: 'r-1', data: { executable: 'git' } },
  { ts: '2026-08-12T10:02:00.000Z', type: 'DECISION_RECORDED', runId: 'r-1' },
  { ts: '2026-08-12T10:02:30.000Z', type: 'CUSTOM_FUTURE_EVENT' as WorkflowEvent['type'], runId: 'r-1' },
];

test('the fold attributes work to the phase it happened in', () => {
  const rollup = foldRollup(run(), events, { now: '2026-08-12T10:10:00.000Z' });
  assert.equal(rollup.files.read, 1);
  assert.equal(rollup.files.changed, 1);
  assert.equal(rollup.tools.calls, 2);
  assert.deepEqual(rollup.tools.byName, { Read: 1, Edit: 1 });
  assert.equal(rollup.commands.started, 1);
  assert.equal(rollup.commands.completed, 1);
  assert.equal(rollup.governance.decisions, 1);
  assert.equal(rollup.steps['intake']?.filesRead, 1);
  assert.equal(rollup.steps['intake']?.filesChanged, 0);
  assert.equal(rollup.steps['analysis']?.filesChanged, 1);
  assert.deepEqual(rollup.steps['analysis']?.paths, ['src/b.ts']);
  assert.equal(rollup.steps['intake']?.durationMs, 60_000);
  assert.equal(rollup.steps['analysis']?.durationMs, null, 'an unfinished phase has no duration');
});

test('an unmeasured metric stays null; it never becomes zero', () => {
  const rollup = foldRollup(run(), events);
  assert.equal(rollup.usage.available, false);
  assert.equal(rollup.usage.totalTokens, null);
  assert.equal(rollup.usage.estimatedCost, null);
  assert.equal(rollup.tests.cases.available, false);
  assert.equal(rollup.tests.cases.total, null);
  // Commands *are* measured, so they are counted.
  assert.equal(rollup.tests.commandsStarted, 0);
});

test('usage is aggregated only from recorded usage events', () => {
  const rollup = foldRollup(run(), [
    ...events,
    {
      ts: '2026-08-12T10:03:00.000Z',
      type: 'USAGE_RECORDED',
      runId: 'r-1',
      data: { inputTokens: 1200, outputTokens: 300, model: 'claude-opus-5' },
    },
  ]);
  assert.equal(rollup.usage.available, true);
  assert.equal(rollup.usage.totalTokens, 1500);
  assert.deepEqual(rollup.usage.models, ['claude-opus-5']);
});

test('the fold is deterministic and survives unknown event types', () => {
  const a = foldRollup(run(), events, { now: 'T' });
  const b = foldRollup(run(), events, { now: 'T' });
  assert.deepEqual(a, b);
  assert.equal(a.eventCount, events.length, 'an unknown event still counts as history');
});

// ---- pagination ------------------------------------------------------------

test('event pagination walks the log once, in order, without re-reading it', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const started = runtime.startRun('generic', { label: 'paging' });
    for (let i = 0; i < 250; i += 1) runtime.note(`note ${i}`, { runId: started.runId });

    const seen: string[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = runtime.eventPage(started.runId, { after: cursor, limit: 40 });
      pages += 1;
      for (const event of page.events) if (event.message) seen.push(event.message);
      cursor = page.cursor;
      if (!page.hasMore) break;
      assert.ok(pages < 50, 'pagination must terminate');
    }
    const notes = seen.filter((m) => m.startsWith('note '));
    assert.ok(pages >= 6, 'a 250-event log does not fit in one page of 40');
    assert.equal(notes.length, 250);
    assert.equal(notes[0], 'note 0');
    assert.equal(notes.at(-1), 'note 249');
    assert.equal(cursor, runtime.eventPage(started.runId, { after: cursor }).size, 'the last cursor is the end');

    const tail = readEvents(runtime.paths, started.runId, 5);
    assert.equal(tail.length, 5);
    assert.equal(tail.at(-1)?.message, 'note 249', 'the tail read returns the newest events');
    assert.equal(
      readEventPage(runtime.paths, started.runId, { after: 0, limit: 1 }).events.length,
      1,
    );
  } finally {
    cleanup();
  }
});

// ---- history index ---------------------------------------------------------

test('the index answers history without reading every run, and rebuilds identically', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const first = runtime.startRun('quick-fix', { label: 'one' });
    // Retired, not completed: `completeRun` verifies the whole topology (D16),
    // and this test is about the index, not about finishing a workflow.
    runtime.abandonRun({ runId: first.runId, message: 'indexing fixture' });
    runtime.startRun('generic', { label: 'two' });

    const entries = runtime.syncIndex();
    assert.equal(entries.length, 2);
    assert.ok(existsSync(runtime.paths.runIndexFile));

    // A second sync with nothing changed must not rewrite the file.
    const before = readRunIndex(runtime.paths);
    const again = runtime.syncIndex();
    assert.deepEqual(again, before);

    // Delete it and rebuild: same content, because it is derived.
    rmSync(runtime.paths.runIndexFile);
    const rebuilt = runtime.syncIndex({ force: true });
    assert.deepEqual(
      rebuilt.map((e) => ({ ...e, stateMtimeMs: 0 })).sort((a, b) => a.runId.localeCompare(b.runId)),
      before.map((e) => ({ ...e, stateMtimeMs: 0 })).sort((a, b) => a.runId.localeCompare(b.runId)),
    );

    const completed = rebuilt.find((e) => e.runId === first.runId)!;
    assert.equal(completed.status, 'ABANDONED');
    assert.ok(completed.durationMs !== null, 'a finished run has a duration');
    assert.equal(completed.usageAvailable, false);
    assert.equal(completed.totalTokens, null);
  } finally {
    cleanup();
  }
});

test('a rollup is cached by event-log size and rebuilt when the cache is gone', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const started = runtime.startRun('generic', { label: 'rollup' });
    runtime.note('hello', { runId: started.runId });
    const live = runtime.rollup(started.runId);
    assert.equal(existsSync(runtime.paths.rollupFile(started.runId)), false, 'a live run is not frozen');

    runtime.abandonRun({ runId: started.runId, message: 'rollup fixture' });
    const done = runtime.rollup(started.runId);
    assert.ok(existsSync(runtime.paths.rollupFile(started.runId)), 'a finished run is cached');
    assert.ok(done.eventCount > live.eventCount);

    // Corrupt cache -> cache miss, not an error.
    writeFileSync(runtime.paths.rollupFile(started.runId), '{ not json', 'utf8');
    const rebuilt = runtime.rollup(started.runId);
    assert.equal(rebuilt.eventCount, done.eventCount);
  } finally {
    cleanup();
  }
});

// ---- usage ----------------------------------------------------------------

test('usage is folded from a transcript, priced only when every model is priced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-usage-'));
  try {
    const file = join(dir, 'session-1.jsonl');
    const line = (model: string, at: string, usage: Record<string, number>) =>
      JSON.stringify({ timestamp: at, sessionId: 'session-1', message: { model, usage } });
    writeFileSync(
      file,
      [
        // Before the window: must not be counted.
        line('claude-opus-5', '2026-08-12T09:00:00.000Z', { input_tokens: 999, output_tokens: 999 }),
        line('claude-opus-5', '2026-08-12T10:05:00.000Z', {
          input_tokens: 10,
          output_tokens: 100,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 500,
        }),
        line('claude-opus-5', '2026-08-12T10:06:00.000Z', { input_tokens: 5, output_tokens: 50 }),
        '{ not json',
        JSON.stringify({ timestamp: '2026-08-12T10:07:00.000Z', message: { model: 'x' } }),
      ].join('\n'),
      'utf8',
    );

    const window = { from: '2026-08-12T10:00:00.000Z', to: '2026-08-12T11:00:00.000Z' };
    const usage = readSessionUsage(file, 'session-1', window);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 15);
    assert.equal(usage.outputTokens, 150);
    assert.equal(usage.cacheReadTokens, 1000);
    assert.equal(usage.cacheWriteTokens, 500);
    assert.equal(usage.totalTokens, 165);
    assert.equal(usage.messages, 2);
    assert.deepEqual(usage.models, ['claude-opus-5']);
    assert.equal(usage.estimatedCost, null, 'no pricing configured means no cost, not a zero cost');

    const priced = readSessionUsage(file, 'session-1', window, {
      'claude-opus-5': { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 },
    });
    assert.ok(priced?.estimatedCost !== null);
    assert.ok(Math.abs(priced!.estimatedCost! - (15 * 15e-6 + 150 * 75e-6 + 1000 * 1.5e-6 + 500 * 18.75e-6)) < 1e-9);

    const partial = readSessionUsage(file, 'session-1', window, { 'some-other-model': { inputPer1M: 1 } });
    assert.equal(partial?.estimatedCost, null, 'a price for the wrong model is not a price');

    assert.equal(readSessionUsage(join(dir, 'missing.jsonl'), 'x'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('repeated usage snapshots do not multiply the bill', () => {
  const snapshot = (total: number): WorkflowEvent => ({
    ts: '2026-08-12T10:03:00.000Z',
    type: 'USAGE_RECORDED',
    runId: 'r-1',
    data: { sessionId: 's1', inputTokens: total, outputTokens: 0, estimatedCost: total / 1000 },
  });
  const rollup = foldRollup(run(), [snapshot(100), snapshot(250), snapshot(400)]);
  assert.equal(rollup.usage.available, true);
  assert.equal(rollup.usage.totalTokens, 400, 'the newest snapshot per session wins; snapshots are not summed');
  assert.equal(rollup.usage.estimatedCost, 0.4);

  const twoSessions = foldRollup(run(), [
    snapshot(400),
    { ...snapshot(50), data: { sessionId: 's2', inputTokens: 50, outputTokens: 0, estimatedCost: 0.05 } },
  ]);
  assert.equal(twoSessions.usage.totalTokens, 450, 'different sessions add up');
});

test('queries filter and page over the index', () => {
  const base: RunIndexEntry = indexEntry(run({ status: 'COMPLETED', finishedAt: '2026-08-12T10:30:00.000Z' }));
  const all: RunIndexEntry[] = [
    { ...base, runId: 'a-1', status: 'COMPLETED', workflow: 'bug-fix', startedAt: '2026-08-10T10:00:00.000Z' },
    { ...base, runId: 'b-2', status: 'FAILED', workflow: 'feature-change', startedAt: '2026-08-11T10:00:00.000Z' },
    { ...base, runId: 'c-3', status: 'RUNNING', workflow: 'bug-fix', startedAt: '2026-08-12T10:00:00.000Z', label: 'permission bug' },
  ];

  assert.deepEqual(queryRuns(all, { status: ['COMPLETED', 'FAILED'] }).runs.map((r) => r.runId), ['b-2', 'a-1']);
  assert.deepEqual(queryRuns(all, { workflow: 'bug-fix' }).runs.map((r) => r.runId), ['c-3', 'a-1']);
  assert.deepEqual(queryRuns(all, { q: 'PERMISSION' }).runs.map((r) => r.runId), ['c-3']);
  const page = queryRuns(all, { limit: 2, offset: 1 });
  assert.equal(page.total, 3);
  assert.deepEqual(page.runs.map((r) => r.runId), ['b-2', 'a-1']);
});
