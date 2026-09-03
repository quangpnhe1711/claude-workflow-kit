/**
 * Routes carry the project, so a link is meaningful outside the session that
 * produced it. The cases that matter are the round trip (parse ∘ href = id), a
 * hash that names no project, and switching projects while a run is open — a run
 * id belongs to exactly one project and must not be carried across.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { href, parseRoute, routeProjectId, switchProject, type Route } from '../routes.js';

const ROUTES: Route[] = [
  { name: 'projects' },
  { name: 'dashboard', projectId: 'demo-1a2b3c4d' },
  { name: 'runs', projectId: 'demo-1a2b3c4d' },
  { name: 'run', projectId: 'demo-1a2b3c4d', runId: 'fc-20260831-001' },
  { name: 'skills', projectId: 'demo-1a2b3c4d' },
  { name: 'launch', projectId: 'demo-1a2b3c4d' },
  { name: 'settings', projectId: 'demo-1a2b3c4d' },
];

test('every route survives a round trip through its own link', () => {
  for (const route of ROUTES) {
    assert.deepEqual(parseRoute(href(route)), route, `round trip: ${href(route)}`);
  }
});

test('a hash with no project lands on the project list', () => {
  for (const hash of ['', '#', '#/', '#/projects', '#/dashboard', '#/p', '#/p/']) {
    assert.deepEqual(parseRoute(hash), { name: 'projects' }, `"${hash}" has no project`);
  }
  assert.equal(routeProjectId({ name: 'projects' }), null);
});

test('an unknown screen inside a project falls back to its dashboard', () => {
  assert.deepEqual(parseRoute('#/p/demo-1a2b3c4d/nonsense'), {
    name: 'dashboard',
    projectId: 'demo-1a2b3c4d',
  });
  assert.deepEqual(parseRoute('#/p/demo-1a2b3c4d'), {
    name: 'dashboard',
    projectId: 'demo-1a2b3c4d',
  });
});

test('ids that need encoding survive both directions', () => {
  const route: Route = { name: 'run', projectId: 'my app-9f8e7d6c', runId: 'fc/20260831 001' };
  const link = href(route);
  assert.ok(!link.includes(' '), 'a space would break the link');
  assert.deepEqual(parseRoute(link), route);
});

test('switching projects keeps the screen but never carries a run id across', () => {
  const other = 'other-99887766';
  assert.deepEqual(switchProject({ name: 'settings', projectId: 'demo-1a2b3c4d' }, other), {
    name: 'settings',
    projectId: other,
  });
  // The run belongs to the project it was opened in; the run list is the honest
  // landing place in the new one.
  assert.deepEqual(
    switchProject({ name: 'run', projectId: 'demo-1a2b3c4d', runId: 'fc-20260831-001' }, other),
    { name: 'runs', projectId: other },
  );
  assert.deepEqual(switchProject({ name: 'projects' }, other), {
    name: 'dashboard',
    projectId: other,
  });
});
