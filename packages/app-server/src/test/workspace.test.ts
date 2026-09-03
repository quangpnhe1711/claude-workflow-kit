/**
 * The registry is the app's only durable state, and the two things that must
 * hold are that a directory maps to exactly one project however it is spelled,
 * and that a damaged registry never stops the app from opening.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { detectRuntimeDir, inspectProject, projectIdFor, Workspace } from '../workspace.js';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-ws-'));
  return {
    dir,
    file: join(dir, 'workspace.json'),
    project: (name: string) => {
      const path = join(dir, name);
      mkdirSync(path, { recursive: true });
      return path;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

test('a project id is derived from the path, so one directory is one project', () => {
  const box = sandbox();
  try {
    const path = box.project('demo');
    assert.equal(projectIdFor(path), projectIdFor(join(path, '.')));
    assert.equal(projectIdFor(path), projectIdFor(`${path}${process.platform === 'win32' ? '\\' : '/'}`));
    assert.notEqual(projectIdFor(path), projectIdFor(box.project('other')));
    assert.match(projectIdFor(path), /^demo-[0-9a-f]{8}$/);
  } finally {
    box.cleanup();
  }
});

test('adding the same directory twice updates the entry instead of forking it', () => {
  const box = sandbox();
  try {
    const path = box.project('demo');
    const workspace = new Workspace(box.file);
    const first = workspace.add({ path });
    const second = workspace.add({ path, name: 'Renamed' });

    assert.equal(first.id, second.id);
    assert.equal(workspace.list().length, 1);
    assert.equal(workspace.find(first.id)?.name, 'Renamed');
    // The original registration time survives a re-add.
    assert.equal(second.addedAt, first.addedAt);

    // And it survives a reload from disk.
    const reopened = new Workspace(box.file);
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.lastProjectId, first.id);
  } finally {
    box.cleanup();
  }
});

test('removing a project drops the row and moves lastProjectId, but touches no files', () => {
  const box = sandbox();
  try {
    const a = box.project('alpha');
    const b = box.project('beta');
    const workspace = new Workspace(box.file);
    const first = workspace.add({ path: a });
    const second = workspace.add({ path: b });
    workspace.touch(second.id);
    assert.equal(workspace.lastProjectId, second.id);

    assert.equal(workspace.remove(second.id), true);
    assert.equal(workspace.remove(second.id), false);
    assert.equal(workspace.lastProjectId, first.id);
    assert.equal(workspace.list().length, 1);
    assert.ok(existsSync(b), 'unregistering must not delete the project directory');
  } finally {
    box.cleanup();
  }
});

test('registering a directory that does not exist is refused', () => {
  const box = sandbox();
  try {
    const workspace = new Workspace(box.file);
    assert.throws(() => workspace.add({ path: join(box.dir, 'nope') }), /no such directory/);
  } finally {
    box.cleanup();
  }
});

test('an unreadable registry opens empty and is kept beside the new one', () => {
  const box = sandbox();
  try {
    writeFileSync(box.file, '{ this is not json', 'utf8');
    const workspace = new Workspace(box.file);
    assert.deepEqual(workspace.list(), []);
    assert.ok(existsSync(`${box.file}.corrupt`), 'the damaged file is preserved, not deleted');

    // The app is usable again immediately.
    const path = box.project('demo');
    assert.equal(workspace.add({ path }).path, resolve(path));
  } finally {
    box.cleanup();
  }
});

test('a project installed with --runtime is registered with the name it actually uses', () => {
  const box = sandbox();
  try {
    const path = box.project('custom');
    mkdirSync(join(path, '.claude'), { recursive: true });
    writeFileSync(join(path, '.claude', 'cw-runtime'), '.my-workflow\n', 'utf8');
    assert.equal(detectRuntimeDir(path), '.my-workflow');

    const workspace = new Workspace(box.file);
    const entry = workspace.add({ path });
    assert.equal(entry.runtimeDir, '.my-workflow');

    // Not installed until config.json exists there.
    assert.equal(inspectProject(entry).installed, false);
    mkdirSync(join(path, '.my-workflow'), { recursive: true });
    writeFileSync(
      join(path, '.my-workflow', 'config.json'),
      JSON.stringify({ runtimeDir: '.my-workflow', preset: 'senior-dev', monitorPort: 4173 }),
      'utf8',
    );
    const inspection = inspectProject(entry);
    assert.equal(inspection.installed, true);
    assert.equal(inspection.preset, 'senior-dev');
    assert.equal(inspection.monitorPort, 4173);
  } finally {
    box.cleanup();
  }
});
