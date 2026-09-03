/**
 * The app serves several projects from one process. The properties worth
 * pinning down are that two projects never see each other's runs, that a write
 * from another origin is refused, that config edits are whitelisted, and that
 * the provisioning routes say so plainly when no installer is attached.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { WorkflowRuntime } from '@claude-workflow-kit/workflow-core';
import { createAppServer, type AppHandle } from '../server.js';
import { Workspace } from '../workspace.js';

const roots: string[] = [];
const servers: AppHandle[] = [];

after(async () => {
  for (const handle of servers) await handle.close();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A project with the runtime installed and one run already open. */
function seedProject(home: string, name: string, workflow: string, label: string): string {
  const path = join(home, name);
  mkdirSync(path, { recursive: true });
  const runtime = new WorkflowRuntime({ projectRoot: path, runtimeDir: '.ai-workflow' });
  runtime.ensureRuntimeDir();
  writeFileSync(
    join(path, '.ai-workflow', 'config.json'),
    JSON.stringify({ runtimeDir: '.ai-workflow', preset: 'senior-dev', monitorPort: 4173 }, null, 2),
    'utf8',
  );
  runtime.startRun(workflow, { label });
  return path;
}

async function boot(): Promise<{ handle: AppHandle; alpha: string; beta: string; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'cwk-app-'));
  roots.push(home);
  // Different workflows, so the two run ids differ and a crossed lookup is a
  // real miss rather than an accidental hit on a same-numbered run.
  const alpha = seedProject(home, 'alpha', 'quick-fix', 'alpha task');
  const beta = seedProject(home, 'beta', 'bug-fix', 'beta task');

  const workspace = new Workspace(join(home, 'workspace.json'));
  workspace.add({ path: alpha });
  workspace.add({ path: beta });

  const handle = await createAppServer({ port: 0, workspace, pollMs: 50 }).ready;
  servers.push(handle);
  return { handle, alpha, beta, home };
}

function idOf(handle: AppHandle, name: string): string {
  const entry = handle.workspace.list().find((p) => p.name === name);
  assert.ok(entry, `project "${name}" is registered`);
  return entry.id;
}

async function api(
  handle: AppHandle,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${handle.url}${path}`, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test('every registered project is listed, with its own run counts', async () => {
  const { handle } = await boot();
  const { status, body } = await api(handle, '/api/app');
  assert.equal(status, 200);
  assert.equal(body.projects.length, 2);
  for (const project of body.projects) {
    assert.equal(project.installed, true);
    assert.equal(project.available, true);
    assert.equal(project.totalRuns, 1);
    assert.equal(project.activeRuns + project.waitingRuns, 1);
  }
  assert.equal(body.capabilities.provisioning, false, 'no installer was injected');
});

test('runs are answered per project and never leak across them', async () => {
  const { handle } = await boot();
  const alphaId = idOf(handle, 'alpha');
  const betaId = idOf(handle, 'beta');

  const alpha = await api(handle, `/api/projects/${alphaId}/state`);
  const beta = await api(handle, `/api/projects/${betaId}/state`);
  assert.equal(alpha.status, 200);
  assert.equal(beta.status, 200);
  assert.equal(alpha.body.runs.length, 1);
  assert.equal(beta.body.runs.length, 1);
  assert.equal(alpha.body.runs[0].label, 'alpha task');
  assert.equal(beta.body.runs[0].label, 'beta task');
  assert.notEqual(alpha.body.projectRoot, beta.body.projectRoot);

  // A run id from one project is not readable through the other.
  const crossed = await api(handle, `/api/projects/${betaId}/runs/${alpha.body.runs[0].runId}`);
  assert.equal(crossed.status, 500);

  const unknown = await api(handle, '/api/projects/does-not-exist/state');
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /unknown project/);
});

test('history and analytics are scoped to the project that was asked for', async () => {
  const { handle } = await boot();
  const alphaId = idOf(handle, 'alpha');
  const runs = await api(handle, `/api/projects/${alphaId}/runs?limit=10`);
  assert.equal(runs.status, 200);
  assert.equal(runs.body.total, 1);
  assert.equal(runs.body.runs[0].label, 'alpha task');

  const analytics = await api(handle, `/api/projects/${alphaId}/analytics`);
  assert.equal(analytics.status, 200);
  assert.ok(analytics.body);
});

test('analytics roll up across projects without averaging small ones up', async () => {
  const { handle } = await boot();
  const { status, body } = await api(handle, '/api/analytics');
  assert.equal(status, 200);
  assert.equal(body.totals.projects, 2);
  assert.equal(body.totals.installed, 2);
  assert.equal(body.totals.totalRuns, 2);
  assert.equal(body.projects.length, 2);
  // Nothing has settled, so there is no success rate to report — not a zero.
  assert.equal(body.totals.successRate, null);
  // Usage is unmeasured in a fresh project; it must stay null rather than become 0.
  assert.equal(body.totals.totalTokens, null);
});

test('a write from another origin is refused', async () => {
  const { handle } = await boot();
  const alphaId = idOf(handle, 'alpha');
  const refused = await api(handle, `/api/projects/${alphaId}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ enforceGates: false }),
  });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /cross-origin/);
});

test('only whitelisted config keys can be written, and the rest are preserved', async () => {
  const { handle } = await boot();
  const alphaId = idOf(handle, 'alpha');

  const before = await api(handle, `/api/projects/${alphaId}/config`);
  assert.equal(before.status, 200);
  assert.ok(before.body.editable.includes('stallThresholdSeconds'));

  const ok = await api(handle, `/api/projects/${alphaId}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stallThresholdSeconds: 240 }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.config.stallThresholdSeconds, 240);
  assert.equal(ok.body.config.preset, 'senior-dev', 'unmanaged keys survive the write');

  const refused = await api(handle, `/api/projects/${alphaId}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mutationTools: [] }),
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /not editable/);

  const invalid = await api(handle, `/api/projects/${alphaId}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stallThresholdSeconds: -1 }),
  });
  assert.equal(invalid.status, 400);

  // The edited value is what the next snapshot is built from.
  const state = await api(handle, `/api/projects/${alphaId}/state`);
  assert.equal(state.body.stallThresholdSeconds, 240);
});

test('provisioning routes say the installer is missing rather than failing obscurely', async () => {
  const { handle } = await boot();
  const alphaId = idOf(handle, 'alpha');
  const doctor = await api(handle, `/api/projects/${alphaId}/doctor`);
  assert.equal(doctor.status, 501);
  assert.match(doctor.body.error, /no installer attached/);
});

test('registering and unregistering a project through the API leaves its files alone', async () => {
  const { handle, home } = await boot();
  const extra = join(home, 'gamma');
  mkdirSync(extra, { recursive: true });

  const added = await api(handle, '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: extra, name: 'Gamma' }),
  });
  assert.equal(added.status, 200);
  assert.equal(added.body.project.name, 'Gamma');
  assert.equal(added.body.project.installed, false, 'registering does not install');

  const removed = await api(handle, `/api/projects/${added.body.project.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.ok(existsSync(extra), 'unregistering must not delete the directory');

  const gone = await api(handle, `/api/projects/${added.body.project.id}`);
  assert.equal(gone.status, 404);
});

test('the stream sends the workspace first, then the snapshot of the named project', async () => {
  const { handle } = await boot();
  const alphaId = idOf(handle, 'alpha');
  const res = await fetch(`${handle.url}/api/stream?project=${alphaId}`);
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  let text = '';
  while (!text.includes('event: snapshot')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  await reader.cancel();
  assert.ok(text.indexOf('event: workspace') < text.indexOf('event: snapshot'));
  assert.ok(text.includes('alpha task'));
});
