/**
 * The launcher is the only part of the kit that starts work rather than
 * recording it, so it is tested against a stand-in binary: real Claude Code is
 * not available in CI and is not what these assertions are about. What matters
 * is that the prompt travels over stdin (never argv), that an edit-capable mode
 * cannot be requested by accident, that output pages from a byte cursor, and
 * that a stopped task is reported as stopped rather than failed.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { claudeAvailable, TaskLauncher, type TaskRecord } from '../launcher.js';
import { Workspace, type ProjectEntry } from '../workspace.js';

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * A fake `claude`: echoes what it was given as stream-json so the test can prove
 * the prompt arrived over stdin, and blocks forever when asked to, so stopping
 * has something to stop.
 */
const FAKE = `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('9.9.9 (fake)\\n');
  process.exit(0);
}
let prompt = '';
try {
  prompt = readFileSync(0, 'utf8');
} catch {
  prompt = '';
}
process.stdout.write(JSON.stringify({ type: 'system', argv: args }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'user', prompt: prompt.trim() }) + '\\n');
// Stands in for what the installed skills do through \`cw\`: move a run.
if (prompt.includes('TOUCH')) {
  const runs = join(process.cwd(), '.ai-workflow', 'runs', 'qf-touched');
  mkdirSync(runs, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(runs, 'state.json'),
    JSON.stringify({ runId: 'qf-touched', startedAt: now, lastActivityAt: now }),
  );
  writeFileSync(join(process.cwd(), '.ai-workflow', 'current-run'), 'qf-touched');
}
if (prompt.includes('HANG')) {
  setInterval(() => {}, 1000);
} else if (prompt.includes('FAIL')) {
  process.stderr.write('the fake session refused\\n');
  process.exit(3);
} else {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
  process.exit(0);
}
`;

function sandbox(): { entry: ProjectEntry; bin: string } {
  const home = mkdtempSync(join(tmpdir(), 'cwk-launch-'));
  roots.push(home);
  const projectPath = join(home, 'project');
  mkdirSync(join(projectPath, '.ai-workflow'), { recursive: true });

  const script = join(home, 'fake-claude.mjs');
  writeFileSync(script, FAKE, 'utf8');
  let bin = script;
  if (process.platform === 'win32') {
    // `spawn` cannot run a .mjs directly on Windows; the shim is what a real
    // `claude` install looks like there anyway.
    bin = join(home, 'fake-claude.cmd');
    writeFileSync(bin, `@node "${script}" %*\r\n`, 'utf8');
  } else {
    chmodSync(script, 0o755);
  }

  const workspace = new Workspace(join(home, 'workspace.json'));
  return { entry: workspace.add({ path: projectPath }), bin };
}

async function settle(
  launcher: TaskLauncher,
  entry: ProjectEntry,
  taskId: string,
  until: (task: TaskRecord) => boolean,
  timeoutMs = 15_000,
): Promise<TaskRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = launcher.get(entry, taskId);
    if (until(task)) return task;
    if (Date.now() > deadline) throw new Error(`task ${taskId} stayed ${task.status}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

test('a task runs, its prompt arrives over stdin, and its output pages from a cursor', async () => {
  const { entry, bin } = sandbox();
  process.env['CW_CLAUDE_BIN'] = bin;
  const launcher = new TaskLauncher();

  assert.equal(claudeAvailable().ok, true, 'the stand-in binary is runnable');

  const started = launcher.start(entry, { prompt: 'fix the thing' });
  assert.equal(started.status, 'RUNNING');
  assert.equal(started.mode, 'plan', 'the default mode cannot edit the repository');

  const done = await settle(launcher, entry, started.id, (t) => t.status !== 'RUNNING');
  assert.equal(done.status, 'DONE');
  assert.equal(done.exitCode, 0);

  const first = launcher.output(entry, started.id, 0, 40);
  assert.ok(first.cursor > 0 && first.cursor <= 40);
  const rest = launcher.output(entry, started.id, first.cursor);
  const text = first.text + rest.text;

  assert.ok(text.includes('"prompt":"fix the thing"'), 'the prompt reached the session');
  assert.ok(!text.includes('"argv":["-p","fix the thing"'), 'the prompt is never an argument');
  assert.ok(text.includes('"--permission-mode","plan"'));
  assert.equal(rest.done, true);
});

test('an edit-capable mode must be confirmed explicitly', () => {
  const { entry, bin } = sandbox();
  process.env['CW_CLAUDE_BIN'] = bin;
  const launcher = new TaskLauncher();

  assert.throws(
    () => launcher.start(entry, { prompt: 'rewrite everything', mode: 'acceptEdits' }),
    /confirmUnsafe/,
  );
  assert.throws(
    () => launcher.start(entry, { prompt: 'rewrite everything', mode: 'bypassPermissions' }),
    /confirmUnsafe/,
  );
  assert.throws(() => launcher.start(entry, { prompt: '  ' }), /"prompt" is required/);

  const allowed = launcher.start(entry, {
    prompt: 'rewrite everything',
    mode: 'acceptEdits',
    confirmUnsafe: true,
  });
  assert.equal(allowed.mode, 'acceptEdits');
});

test('a failing session is reported with its exit code and its stderr', async () => {
  const { entry, bin } = sandbox();
  process.env['CW_CLAUDE_BIN'] = bin;
  const launcher = new TaskLauncher();

  const started = launcher.start(entry, { prompt: 'please FAIL' });
  const done = await settle(launcher, entry, started.id, (t) => t.status !== 'RUNNING');
  assert.equal(done.status, 'FAILED');
  assert.equal(done.exitCode, 3);
  assert.match(done.error ?? '', /refused/);
});

test('a stopped task reads as stopped, and a task from a previous app as unknown', async () => {
  const { entry, bin } = sandbox();
  process.env['CW_CLAUDE_BIN'] = bin;
  const launcher = new TaskLauncher();

  const started = launcher.start(entry, { prompt: 'HANG around' });
  // Wait until the child has actually produced output, so the kill lands on a
  // running process rather than one still starting.
  await settle(launcher, entry, started.id, () => launcher.output(entry, started.id).size > 0);

  const stopped = launcher.stop(entry, started.id);
  assert.equal(stopped.status, 'STOPPED');
  const afterExit = await settle(launcher, entry, started.id, (t) => Boolean(t.endedAt));
  assert.equal(afterExit.status, 'STOPPED', 'the close handler must not relabel it FAILED');

  // A record left RUNNING by a previous process cannot be waited on.
  const orphaned = new TaskLauncher();
  const ghost = launcher.list(entry)[0]!;
  ghost.status = 'RUNNING';
  writeFileSync(
    join(entry.path, '.ai-workflow', 'app', 'tasks.json'),
    JSON.stringify([ghost], null, 2),
    'utf8',
  );
  orphaned.reconcile(entry);
  assert.equal(orphaned.get(entry, ghost.id).status, 'UNKNOWN');
});

test('a task links the run it worked in, and never a run it only found lying about', async () => {
  const { entry, bin } = sandbox();
  process.env['CW_CLAUDE_BIN'] = bin;
  const launcher = new TaskLauncher();

  // A pointer left over from last week. Adopting it would credit this session
  // with work it never touched.
  const runs = join(entry.path, '.ai-workflow', 'runs', 'sc-stale');
  mkdirSync(runs, { recursive: true });
  writeFileSync(
    join(runs, 'state.json'),
    JSON.stringify({
      runId: 'sc-stale',
      startedAt: '2020-01-01T00:00:00.000Z',
      lastActivityAt: '2020-01-01T00:00:00.000Z',
    }),
    'utf8',
  );
  writeFileSync(join(entry.path, '.ai-workflow', 'current-run'), 'sc-stale', 'utf8');

  const quiet = launcher.start(entry, { prompt: 'just answer a question' });
  await settle(launcher, entry, quiet.id, (t) => t.status !== 'RUNNING');
  // The link is attached on a timer, so give it more than one tick to be wrong in.
  await new Promise((done) => setTimeout(done, 1500));
  assert.equal(launcher.get(entry, quiet.id).runId, undefined, 'a stale pointer is not adopted');

  // A session that actually moves a run does get linked to it.
  const working = launcher.start(entry, { prompt: 'TOUCH the run please' });
  await settle(launcher, entry, working.id, (t) => t.status !== 'RUNNING');
  const linked = await settle(launcher, entry, working.id, (t) => Boolean(t.runId));
  assert.equal(linked.runId, 'qf-touched');
});
