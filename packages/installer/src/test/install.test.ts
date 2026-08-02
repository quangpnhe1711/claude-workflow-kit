import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { install, uninstall } from '../install.js';
import { mergeClaudeMd, mergeSettings, removeKitHooks, stripClaudeMdBlock } from '../merge.js';
import { doctor } from '../doctor.js';

function project(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-install-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the managed block is inserted, replaced and stripped without touching user content', () => {
  const user = '# My Project\n\nOur own rule: never deploy on Friday.\n';
  const first = mergeClaudeMd(user, 'BLOCK ONE');
  assert.ok(first.includes('Our own rule'));
  assert.ok(first.includes('BLOCK ONE'));

  const second = mergeClaudeMd(first, 'BLOCK TWO');
  assert.ok(second.includes('BLOCK TWO'));
  assert.ok(!second.includes('BLOCK ONE'));
  assert.equal(second.match(/CW:START/g)?.length, 1);
  assert.ok(second.includes('Our own rule'));

  const stripped = stripClaudeMdBlock(second);
  assert.ok(!stripped.includes('CW:START'));
  assert.ok(stripped.includes('Our own rule'));
});

test('settings merge keeps unrelated user settings and user hooks', () => {
  const existing = {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node my-own-hook.js' }] }],
    },
  };
  const template = {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node .claude/hooks/cw-hook.mjs PreToolUse' }] }],
    },
  };

  const merged = mergeSettings(existing, template) as typeof existing;
  assert.deepEqual(merged.permissions, existing.permissions);
  assert.equal(merged.hooks.PreToolUse.length, 2);

  // Rerunning must not duplicate the kit entry.
  const again = mergeSettings(merged, template) as typeof existing;
  assert.equal(again.hooks.PreToolUse.length, 2);

  const cleaned = removeKitHooks(again) as typeof existing;
  assert.equal(cleaned.hooks.PreToolUse.length, 1);
  assert.equal(cleaned.hooks.PreToolUse[0]!.hooks![0]!.command, 'node my-own-hook.js');
});

test('init installs skills, agents, hooks, runtime and the managed block', () => {
  const { dir, cleanup } = project();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Existing\n\nProject rule stays.\n', 'utf8');
    const result = install({ projectRoot: dir });

    assert.ok(existsSync(join(dir, '.claude', 'skills', 'feature-change', 'SKILL.md')));
    assert.ok(existsSync(join(dir, '.claude', 'agents', 'independent-reviewer.md')));
    assert.ok(existsSync(join(dir, '.claude', 'hooks', 'cw-hook.mjs')));
    assert.ok(existsSync(join(dir, '.ai-workflow', 'config.json')));
    assert.ok(existsSync(join(dir, '.ai-workflow', 'runs')));
    assert.ok(existsSync(join(dir, 'CLAUDE.md.cw-backup')));

    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.includes('Project rule stays.'));
    assert.ok(claudeMd.includes('NO BUSINESS DECISION = NO CODING.'));

    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.ok(Object.keys(settings.hooks).length >= 10);
    assert.ok(result.config.runtimeUrl?.startsWith('file:'));
  } finally {
    cleanup();
  }
});

test('init is idempotent', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const before = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    install({ projectRoot: dir, mode: 'update' });
    const after = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.equal(before, after);

    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: unknown[] }>>;
    };
    assert.equal(settings.hooks['PreToolUse']!.length, 1);
  } finally {
    cleanup();
  }
});

test('update preserves user config values', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir, monitorPort: 4999 });
    mkdirSync(join(dir, '.ai-workflow'), { recursive: true });
    const configFile = join(dir, '.ai-workflow', 'config.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    config['stallThresholdSeconds'] = 300;
    writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');

    install({ projectRoot: dir, mode: 'update' });
    const updated = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    assert.equal(updated['stallThresholdSeconds'], 300);
    assert.equal(updated['monitorPort'], 4999);
  } finally {
    cleanup();
  }
});

test('uninstall removes managed content and keeps run evidence by default', () => {
  const { dir, cleanup } = project();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Existing\n\nProject rule stays.\n', 'utf8');
    install({ projectRoot: dir });
    uninstall({ projectRoot: dir });

    assert.ok(!existsSync(join(dir, '.claude', 'skills', 'feature-change', 'SKILL.md')));
    assert.ok(!existsSync(join(dir, '.claude', 'hooks', 'cw-hook.mjs')));
    assert.ok(existsSync(join(dir, '.ai-workflow')));

    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.includes('Project rule stays.'));
    assert.ok(!claudeMd.includes('CW:START'));

    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as {
      hooks?: Record<string, unknown>;
    };
    assert.equal(settings.hooks, undefined);
  } finally {
    cleanup();
  }
});

test('doctor reports a healthy install and flags a missing one', async () => {
  const { dir, cleanup } = project();
  try {
    const before = await doctor({ projectRoot: dir });
    assert.ok(before.some((c) => c.name === 'runtime directory' && c.status === 'fail'));

    install({ projectRoot: dir });
    const after = await doctor({ projectRoot: dir });
    const byName = new Map(after.map((c) => [c.name, c]));
    assert.equal(byName.get('runtime directory')?.status, 'ok');
    assert.equal(byName.get('runtimeUrl')?.status, 'ok');
    assert.equal(byName.get('skills')?.status, 'ok');
    assert.equal(byName.get('settings.json hooks')?.status, 'ok');
    assert.equal(byName.get('CLAUDE.md')?.status, 'ok');
    assert.ok(!after.some((c) => c.status === 'fail'));
  } finally {
    cleanup();
  }
});
