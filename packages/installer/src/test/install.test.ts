import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkflowRuntime } from '@claude-workflow-kit/workflow-core';
import { install, uninstall } from '../install.js';
import { mergeClaudeMd, mergeSettings, readJsonFile, removeKitHooks, stripClaudeMdBlock } from '../merge.js';
import { doctor } from '../doctor.js';

function project(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-install-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
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

test('hook commands are project-dir anchored, never cwd-relative', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commands = Object.values(settings.hooks).flatMap((m) => m.flatMap((e) => e.hooks.map((h) => h.command)));
    assert.ok(commands.length >= 12);
    for (const command of commands) {
      assert.ok(
        command.includes('${CLAUDE_PROJECT_DIR}/.claude/hooks/cw-hook.mjs'),
        `hook command must be anchored to the project dir: ${command}`,
      );
      assert.ok(
        !/node \.claude/.test(command),
        `hook command must not depend on the process cwd: ${command}`,
      );
    }
  } finally {
    cleanup();
  }
});

test('machine-local runtime files are gitignored, conventions are not', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const ignore = readFileSync(join(dir, '.ai-workflow', '.gitignore'), 'utf8');
    for (const entry of ['current-run', 'sessions.json', 'hook-errors.log', 'config.json']) {
      assert.ok(ignore.includes(entry), `${entry} must be gitignored`);
    }
    assert.ok(!ignore.includes('conventions'), 'shared repository knowledge stays committable');
    assert.ok(existsSync(join(dir, '.ai-workflow', 'runs', '.gitignore')));
  } finally {
    cleanup();
  }
});

test('the installed preset carries the routable workflow bodies', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const skills = join(dir, '.claude', 'skills');
    for (const skill of ['work', 'feature-change', 'bug-fix', 'wf-feature-change', 'wf-bug-fix']) {
      assert.ok(existsSync(join(skills, skill, 'SKILL.md')), `${skill} installed`);
    }
    // The entry points stay user-only; the bodies must be model-invocable, or
    // /work cannot route to them.
    const entry = readFileSync(join(skills, 'feature-change', 'SKILL.md'), 'utf8');
    assert.ok(entry.includes('disable-model-invocation: true'));
    assert.ok(entry.includes('wf-feature-change'));
    const body = readFileSync(join(skills, 'wf-feature-change', 'SKILL.md'), 'utf8');
    assert.ok(!body.includes('disable-model-invocation'));
    assert.ok(body.includes('user-invocable: false'));
    const work = readFileSync(join(skills, 'work', 'SKILL.md'), 'utf8');
    assert.ok(work.includes('wf-bug-fix') && work.includes('wf-feature-change'));
  } finally {
    cleanup();
  }
});

test('no skill or rule depends on an external output-compression plugin', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const files = [join(dir, 'CLAUDE.md')];
    for (const skill of ['wf-final-report', 'work', 'wf-feature-change', 'wf-bug-fix']) {
      files.push(join(dir, '.claude', 'skills', skill, 'SKILL.md'));
    }
    for (const file of files) {
      assert.ok(!readFileSync(file, 'utf8').includes('caveman'), `${file} must not depend on caveman`);
    }
    const rules = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(rules.includes('COMPRESS WORDING, NOT SUBSTANCE.'));
    assert.ok(rules.includes('Execution narration'), 'the depth budget survives');
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
    assert.equal(byName.get('semantic progress')?.status, 'ok');
    assert.ok(byName.has('conventions'), 'the convention cache is inspected');
    assert.ok(!after.some((c) => c.status === 'fail'));
  } finally {
    cleanup();
  }
});

test('doctor surfaces semantic lag and an unreadable run', async () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
    const run = runtime.startRun('feature-change', { label: 'frozen diagram' });

    // Claude keeps working; the workflow never reports a transition.
    const state = JSON.parse(readFileSync(runtime.paths.stateFile(run.runId), 'utf8')) as Record<string, unknown>;
    state['lastSemanticAt'] = new Date(Date.now() - 3_600_000).toISOString();
    state['lastRuntimeAt'] = new Date().toISOString();
    state['lastActivityAt'] = state['lastRuntimeAt'];
    // Lag only means anything while Claude is demonstrably working (SEM-01).
    state['runtime'] = { claude: 'TOOL_RUNNING', tool: 'Grep', lastEventAt: state['lastRuntimeAt'] };
    writeFileSync(runtime.paths.stateFile(run.runId), JSON.stringify(state), 'utf8');

    const lagging = await doctor({ projectRoot: dir });
    const semantic = lagging.find((c) => c.name === 'semantic progress');
    assert.equal(semantic?.status, 'warn');
    assert.match(semantic?.detail ?? '', new RegExp(run.runId));
    assert.ok(!lagging.some((c) => c.status === 'fail'), 'lag is reported, never as a failure');

    writeFileSync(runtime.paths.stateFile(run.runId), '{ broken', 'utf8');
    const broken = await doctor({ projectRoot: dir });
    const runs = broken.find((c) => c.name === 'runs');
    assert.equal(runs?.status, 'fail');
    assert.match(runs?.detail ?? '', /CORRUPT/);

    // A structurally valid JSON object that is not a run is equally corrupt.
    writeFileSync(runtime.paths.stateFile(run.runId), JSON.stringify({ runId: run.runId, hello: 1 }), 'utf8');
    const structural = await doctor({ projectRoot: dir });
    assert.equal(structural.find((c) => c.name === 'runs')?.status, 'fail');
  } finally {
    cleanup();
  }
});

test('doctor reports a DEGRADED gate policy as a failure (HOOK-01)', async () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });

    const unproven = await doctor({ projectRoot: dir });
    assert.equal(unproven.find((c) => c.name === 'gate policy')?.status, 'warn');

    runtime.recordPolicyEvaluation(true);
    const healthy = await doctor({ projectRoot: dir });
    assert.equal(healthy.find((c) => c.name === 'gate policy')?.status, 'ok');

    runtime.recordPolicyEvaluation(false, new Error('cannot import runtimeUrl'));
    const degraded = await doctor({ projectRoot: dir });
    const check = degraded.find((c) => c.name === 'gate policy');
    assert.equal(check?.status, 'fail');
    assert.match(check?.detail ?? '', /DEGRADED/);
    assert.match(check?.detail ?? '', /cannot import runtimeUrl/);
  } finally {
    cleanup();
  }
});

test('a custom runtime directory is discoverable by every entry point (PORT-01)', async () => {
  const { dir, cleanup } = project();
  try {
    const result = install({ projectRoot: dir, runtimeDir: '.wf' });
    assert.ok(result.written.some((f) => f.endsWith(join('.claude', 'cw-runtime'))));
    assert.equal(readFileSync(join(dir, '.claude', 'cw-runtime'), 'utf8').trim(), '.wf');
    assert.equal(readJsonFile<{ runtimeDir: string }>(join(dir, '.wf', 'config.json'))?.runtimeDir, '.wf');

    // No flags anywhere: the runtime, doctor and update all still find `.wf`.
    const runtime = new WorkflowRuntime({ projectRoot: dir });
    assert.equal(runtime.paths.runtimeDir, join(dir, '.wf'));

    const checks = await doctor({ projectRoot: dir });
    assert.deepEqual(checks.filter((c) => c.status === 'fail'), []);

    install({ projectRoot: dir, mode: 'update' });
    assert.equal(readFileSync(join(dir, '.claude', 'cw-runtime'), 'utf8').trim(), '.wf');
    assert.ok(!existsSync(join(dir, '.ai-workflow')), 'update must not relocate the runtime');
  } finally {
    cleanup();
  }
});
