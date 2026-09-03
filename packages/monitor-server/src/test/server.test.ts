/**
 * `cw monitor` serves the same UI bundle as `cw app`, so it has to answer the
 * app's questions too — as a workspace of exactly one project, offering nothing
 * it cannot honestly do. These tests pin both dialects: the original `/api/...`
 * routes scripts and docs already use, and the `/api/projects/local/...` ones the
 * shared UI asks for.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { WorkflowRuntime } from '@claude-workflow-kit/workflow-core';
import { createMonitorServer, type MonitorHandle } from '../server.js';

const roots: string[] = [];
const servers: MonitorHandle[] = [];

after(async () => {
  for (const handle of servers) await handle.close();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A project with the runtime installed and one run open, on a free port. */
async function boot(): Promise<{ url: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-monitor-'));
  roots.push(dir);
  const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
  runtime.ensureRuntimeDir();
  writeFileSync(
    join(dir, '.ai-workflow', 'config.json'),
    JSON.stringify({ runtimeDir: '.ai-workflow', preset: 'senior-dev', monitorPort: 4173 }),
    'utf8',
  );
  mkdirSync(join(dir, '.ai-workflow', 'runs'), { recursive: true });
  runtime.startRun('quick-fix', { label: 'the only task' });

  const handle = createMonitorServer({ projectRoot: dir, port: 0, pollMs: 50 });
  servers.push(handle);
  await new Promise<void>((done) => handle.server.once('listening', () => done()));
  const address = handle.server.address();
  const port = address && typeof address === 'object' ? address.port : handle.port;
  return { url: `http://127.0.0.1:${port}` };
}

async function api(url: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('the original single-project routes still answer', async () => {
  const { url } = await boot();
  const health = await api(url, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const state = await api(url, '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.runs.length, 1);
  assert.equal(state.body.runs[0].label, 'the only task');

  const runs = await api(url, '/api/runs');
  assert.equal(runs.body.total, 1);
  assert.equal((await api(url, '/api/analytics')).status, 200);
  assert.equal((await api(url, '/api/nonsense')).status, 404);
});

test('it describes itself as a workspace of one, with nothing it cannot do', async () => {
  const { url } = await boot();
  const app = await api(url, '/api/app');
  assert.equal(app.status, 200);
  assert.equal(app.body.projects.length, 1);
  assert.equal(app.body.lastProjectId, 'local');
  assert.equal(app.body.projects[0].installed, true);
  assert.equal(app.body.projects[0].totalRuns, 1);
  assert.equal(app.body.capabilities.provisioning, false);
  assert.equal(app.body.capabilities.launcher, false);
  assert.deepEqual(app.body.presets, []);
});

test('the project-scoped dialect reaches the same runtime', async () => {
  const { url } = await boot();
  const state = await api(url, '/api/projects/local/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.runs[0].label, 'the only task');

  const runs = await api(url, '/api/projects/local/runs');
  assert.equal(runs.body.total, 1);

  const one = await api(url, '/api/projects/local');
  assert.equal(one.body.project.id, 'local');

  // There is no second project to ask about, and saying so beats a confusing 500.
  const other = await api(url, '/api/projects/somewhere-else/state');
  assert.equal(other.status, 404);
  assert.match(other.body.error, /single-project monitor/);
});

test('the stream opens with the workspace, then the snapshot', async () => {
  const { url } = await boot();
  const res = await fetch(`${url}/api/stream`);
  const reader = res.body!.getReader();
  let text = '';
  while (!text.includes('event: snapshot')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  await reader.cancel();
  assert.ok(text.indexOf('event: workspace') < text.indexOf('event: snapshot'));
  assert.ok(text.includes('the only task'));
});
