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

    assert.ok(existsSync(join(dir, '.claude', 'skills', 'root-cause-analysis', 'SKILL.md')));
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'sql-compare', 'SKILL.md')));
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'deep-change', 'SKILL.md')));
    assert.ok(existsSync(join(dir, '.claude', 'agents', 'adversarial-reviewer.md')));
    assert.ok(existsSync(join(dir, '.claude', 'hooks', 'cw-hook.mjs')));
    assert.ok(existsSync(join(dir, '.claude', 'instructions', 'README.md')));
    assert.ok(existsSync(join(dir, '.claude', 'prompts', 'bug-report.prompt.md')));
    assert.ok(existsSync(join(dir, '.ai-workflow', 'config.json')));
    assert.ok(existsSync(join(dir, '.ai-workflow', 'runs')));
    assert.ok(existsSync(join(dir, 'CLAUDE.md.cw-backup')));

    // The instructions layer ships its contract and none of its content: how a
    // repository does an area can only come from that repository.
    assert.equal(existsSync(join(dir, '.claude', 'instructions', 'database.instructions.md')), false);

    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.includes('Project rule stays.'));
    assert.ok(claudeMd.includes('Depth is chosen by three facts'));
    assert.ok(claudeMd.includes('Escalation triggers'));
    assert.ok(claudeMd.includes('Stop rules'));

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

test('uninstall removes managed content and keeps runtime evidence and shared assets by default', () => {
  const { dir, cleanup } = project();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Existing\n\nProject rule stays.\n', 'utf8');
    install({ projectRoot: dir });
    const result = uninstall({ projectRoot: dir });

    assert.ok(!existsSync(join(dir, '.claude', 'skills', 'root-cause-analysis', 'SKILL.md')));
    assert.ok(!existsSync(join(dir, '.claude', 'prompts', 'bug-report.prompt.md')));
    assert.ok(!existsSync(join(dir, '.claude', 'hooks', 'cw-hook.mjs')));
    assert.ok(existsSync(join(dir, '.ai-workflow')));
    assert.match(result.kept.join('\n'), /run evidence and runtime config/);

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

test('machine-local runtime files are gitignored; shared knowledge lives outside them', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const ignore = readFileSync(join(dir, '.ai-workflow', '.gitignore'), 'utf8');
    for (const entry of ['current-run', 'sessions.json', 'hook-errors.log', 'config.json']) {
      assert.ok(ignore.includes(entry), `${entry} must be gitignored`);
    }
    const runtimeReadme = readFileSync(join(dir, '.ai-workflow', 'README.md'), 'utf8');
    assert.match(runtimeReadme, /`\.claude\/instructions\/`/);
    assert.match(runtimeReadme, /`\.claude\/prompts\/`/);
    assert.ok(existsSync(join(dir, '.ai-workflow', 'runs', '.gitignore')));
  } finally {
    cleanup();
  }
});

test('the installed preset carries specialist capabilities, not workflow phases', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const skills = join(dir, '.claude', 'skills');

    for (const skill of [
      'root-cause-analysis',
      'impact-analysis',
      'feature-analysis',
      'sql-compare',
      'legacy-parity',
      'schema-migration',
      'api-contract-review',
      'performance-investigation',
      'map-repo',
      'deep-change',
    ]) {
      assert.ok(existsSync(join(skills, skill, 'SKILL.md')), `${skill} installed`);
    }

    // The v1 process framework is gone: a skill named after a workflow phase or
    // a task category is exactly the thing that made ordinary tasks slow.
    for (const gone of [
      'work',
      'quick-fix',
      'standard-change',
      'feature-change',
      'bug-fix',
      'solution-analysis',
      'wf-quick-fix',
      'wf-standard-change',
      'wf-feature-change',
      'wf-bug-fix',
      'wf-implement',
      'wf-checkpoint',
      'wf-final-report',
    ]) {
      assert.equal(existsSync(join(skills, gone, 'SKILL.md')), false, `${gone} must not exist`);
    }

    // Capabilities load when the task needs them, so none may be model-blocked.
    for (const skill of ['root-cause-analysis', 'sql-compare', 'impact-analysis']) {
      const body = readFileSync(join(skills, skill, 'SKILL.md'), 'utf8');
      assert.ok(!body.includes('disable-model-invocation'), `${skill} is auto-loadable`);
      assert.ok(!body.includes('user-invocable: false'), `${skill} is also user-invocable`);
    }

    // Every escalation trigger in the rules names a skill that is installed.
    const rules = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    for (const skill of ['root-cause-analysis', 'impact-analysis', 'sql-compare', 'deep-change']) {
      assert.ok(rules.includes(skill), `${skill} is reachable from the rules`);
    }
  } finally {
    cleanup();
  }
});

test('every analytical skill carries the depth contract, not generic advice', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const skills = join(dir, '.claude', 'skills');

    // `deep-change` is a safety capability, not a reasoning methodology, so it
    // is deliberately exempt from the analytical contract.
    const analytical = [
      'root-cause-analysis',
      'impact-analysis',
      'feature-analysis',
      'sql-compare',
      'legacy-parity',
      'schema-migration',
      'api-contract-review',
      'performance-investigation',
      'map-repo',
    ];

    for (const skill of analytical) {
      const body = readFileSync(join(skills, skill, 'SKILL.md'), 'utf8');
      // What vanilla reasoning misses — if this cannot be written, the skill is
      // not carrying its weight.
      assert.match(body, /## Why this skill exists/, `${skill} states its vanilla gap`);
      // Guards against confident-but-wrong conclusions, written as `X != Y`.
      assert.match(body, /must not reach/, `${skill} names its false conclusions`);
      assert.match(body, /!=/, `${skill} spells out at least one false conclusion`);
      // A bound, so investigation cannot run forever.
      assert.match(body, /## Stop when/, `${skill} has a stop condition`);
      // Auto-loadable and typeable: neither frontmatter switch may appear.
      assert.ok(!body.includes('disable-model-invocation'), `${skill} is auto-loadable`);
      assert.ok(!body.includes('user-invocable: false'), `${skill} is user-invocable`);
    }

    // The gated path stays a safety capability: no analysis ceremony bolted on.
    const gated = readFileSync(join(skills, 'deep-change', 'SKILL.md'), 'utf8');
    assert.match(gated, /safety capability, not a reasoning methodology/);
    assert.match(gated, /Do \*\*not\*\* use it for/, 'the trigger names what must not fire it');

    // The reviewer classifies by evidence instead of emitting speculation.
    const reviewer = readFileSync(join(dir, '.claude', 'agents', 'adversarial-reviewer.md'), 'utf8');
    for (const level of ['CONFIRMED DEFECT', 'PLAUSIBLE RISK', 'UNVERIFIED ASSUMPTION']) {
      assert.ok(reviewer.includes(level), `reviewer classifies ${level}`);
    }
  } finally {
    cleanup();
  }
});

test('output contracts are installed, load-on-demand, and preserved on update', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const prompts = join(dir, '.claude', 'prompts');
    const names = [
      'README.md',
      'change-report.prompt.md',
      'bug-report.prompt.md',
      'impact-report.prompt.md',
      'test-report.prompt.md',
      'review-report.prompt.md',
      'analysis-report.prompt.md',
      'parity-report.prompt.md',
      'migration-plan.prompt.md',
      'business-summary.prompt.md',
      'decision-record.prompt.md',
      'release-note.prompt.md',
    ];
    for (const name of names) assert.ok(existsSync(join(prompts, name)), `${name} installed`);

    // The index is what makes selective loading possible: one read picks the
    // contract, instead of every template shape sitting in context all session.
    const index = readFileSync(join(prompts, 'README.md'), 'utf8');
    for (const name of names.slice(1)) {
      assert.ok(index.includes(name), `${name} is selectable from the index`);
    }

    // The vocabulary the rules promise has to exist where the report is written.
    const review = readFileSync(join(prompts, 'review-report.prompt.md'), 'utf8');
    for (const value of ['P0 — Critical', 'P1 — High', 'P2 — Medium', 'P3 — Improvement']) {
      assert.ok(review.includes(value));
    }
    for (const value of ['READY', 'READY WITH FOLLOW-UP', 'NOT READY']) assert.ok(review.includes(value));
    const testReport = readFileSync(join(prompts, 'test-report.prompt.md'), 'utf8');
    assert.ok(testReport.includes('PASS WITH MANUAL VERIFICATION'));
    assert.ok(testReport.includes('## Not verified'));

    // A business deliverable must not leak implementation vocabulary.
    const business = readFileSync(join(prompts, 'business-summary.prompt.md'), 'utf8');
    assert.ok(business.includes('No class, method, controller, repository, SQL, file path'));

    // Reports are the user's, not the kit's: a customized contract survives.
    const customized = join(prompts, 'bug-report.prompt.md');
    const projectOwned = '# Project bug report\n\nCustom section\n';
    writeFileSync(customized, projectOwned, 'utf8');
    rmSync(join(prompts, 'release-note.prompt.md'));

    install({ projectRoot: dir, mode: 'update' });
    assert.equal(readFileSync(customized, 'utf8'), projectOwned);
    assert.ok(existsSync(join(prompts, 'release-note.prompt.md')), 'a deleted default is restored');
  } finally {
    cleanup();
  }
});

test('no skill or rule depends on an external output-compression plugin', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const files = [join(dir, 'CLAUDE.md')];
    for (const skill of ['deep-change', 'root-cause-analysis', 'map-repo']) {
      files.push(join(dir, '.claude', 'skills', skill, 'SKILL.md'));
    }
    for (const file of files) {
      assert.ok(!readFileSync(file, 'utf8').includes('caveman'), `${file} must not depend on caveman`);
    }
    const rules = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(rules.includes('Do not narrate reading, searching, editing'));
    assert.ok(rules.includes('Verification is proportional to risk'));
    assert.ok(rules.includes('.claude/prompts/'));
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
    assert.equal(byName.get('state schema')?.status, 'ok');
    assert.equal(byName.get('runtimeUrl')?.status, 'ok');
    assert.equal(byName.get('skills')?.status, 'ok');
    assert.equal(byName.get('output contracts')?.status, 'ok');
    assert.equal(byName.get('instructions layer')?.status, 'ok');
    assert.equal(byName.get('solution-analysis workflow')?.status, 'ok');
    assert.equal(byName.get('analysis handoff config')?.status, 'ok');
    assert.equal(byName.get('managed file ownership')?.status, 'ok');
    assert.equal(byName.get('settings.json hooks')?.status, 'ok');
    assert.equal(byName.get('CLAUDE.md')?.status, 'ok');
    assert.equal(byName.get('semantic progress')?.status, 'ok');
    assert.ok(byName.has('repository instructions'), 'the scoped-knowledge layer is inspected');
    assert.ok(!after.some((c) => c.status === 'fail'));
  } finally {
    cleanup();
  }
});

test('update restores deleted capabilities and preserves ambiguous files', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const runtime = join(dir, '.ai-workflow');
    const legacyManifestFile = join(runtime, 'installed.json');
    const legacy = JSON.parse(readFileSync(legacyManifestFile, 'utf8')) as Record<string, unknown>;
    delete legacy['fileHashes'];
    writeFileSync(legacyManifestFile, JSON.stringify(legacy, null, 2), 'utf8');

    const customized = join(dir, '.claude', 'skills', 'root-cause-analysis', 'SKILL.md');
    const projectOwned = '# Project-owned root cause method\n';
    writeFileSync(customized, projectOwned, 'utf8');
    rmSync(join(dir, '.claude', 'skills', 'sql-compare'), { recursive: true, force: true });
    rmSync(join(dir, '.claude', 'prompts', 'parity-report.prompt.md'));

    const result = install({ projectRoot: dir, mode: 'update' });
    assert.equal(readFileSync(customized, 'utf8'), projectOwned);
    assert.ok(result.conflicts.some((item) => item.includes('.claude/skills/root-cause-analysis/SKILL.md')));
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'sql-compare', 'SKILL.md')));
    assert.ok(existsSync(join(dir, '.claude', 'prompts', 'parity-report.prompt.md')));
  } finally {
    cleanup();
  }
});

test('update preserves a hash-detected customized managed skill', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const skill = join(dir, '.claude', 'skills', 'deep-change', 'SKILL.md');
    const custom = `${readFileSync(skill, 'utf8')}\nProject customization stays.\n`;
    writeFileSync(skill, custom, 'utf8');

    const result = install({ projectRoot: dir, mode: 'update' });
    assert.equal(readFileSync(skill, 'utf8'), custom);
    assert.ok(result.conflicts.some((item) => item.includes('deep-change')));
  } finally {
    cleanup();
  }
});

test('doctor detects a legacy state schema without rewriting it', async () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const configFile = join(dir, '.ai-workflow', 'config.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    delete config['stateSchemaVersion'];
    writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');

    const checks = await doctor({ projectRoot: dir });
    assert.equal(checks.find((check) => check.name === 'state schema')?.status, 'warn');
    const after = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    assert.equal(after['stateSchemaVersion'], undefined, 'doctor is read-only');

    install({ projectRoot: dir, mode: 'update' });
    const upgraded = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    assert.equal(upgraded['stateSchemaVersion'], 2);
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
    assert.ok(existsSync(join(dir, '.claude', 'prompts', 'change-report.prompt.md')));

    // No flags anywhere: the runtime, doctor and update all still find `.wf`.
    const runtime = new WorkflowRuntime({ projectRoot: dir });
    assert.equal(runtime.paths.runtimeDir, join(dir, '.wf'));
    const installedRules = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(installedRules, /<runtimeDir>.*\.claude\/cw-runtime/s);
    assert.ok(!installedRules.includes('`.ai-workflow/runs/'));

    // Only the gated path writes into a run directory at all, and it must reach
    // it through the discovered runtime rather than the default name.
    const gated = readFileSync(join(dir, '.claude', 'skills', 'deep-change', 'SKILL.md'), 'utf8');
    assert.ok(gated.includes('<runtimeDir>/runs/'), 'deep-change uses the discovered runtime');
    assert.ok(!gated.includes('`.ai-workflow/runs/'), 'deep-change has no hardcoded run path');

    const controlled = runtime.startRun('feature-change', { label: 'custom runtime evidence' });
    runtime.enterPhase('evidence');
    writeFileSync(join(runtime.paths.runDir(controlled.runId), 'evidence.md'), '# evidence\n');
    runtime.artifact('evidence.md');
    runtime.enterPhase('business');
    const decisionPath = join(runtime.paths.runDir(controlled.runId), 'business-decision.md');
    assert.equal(
      runtime.checkMutation({ toolName: 'Write', toolInput: { file_path: decisionPath } }).decision,
      'allow',
      'the current gate artifact is writable in the custom runtime directory',
    );
    writeFileSync(decisionPath, '# decision\n');
    runtime.artifact('business-decision.md');
    assert.equal(runtime.passGate('BUSINESS_READY').gates['BUSINESS_READY'], 'PASSED');

    const checks = await doctor({ projectRoot: dir });
    assert.deepEqual(checks.filter((c) => c.status === 'fail'), []);

    install({ projectRoot: dir, mode: 'update' });
    assert.equal(readFileSync(join(dir, '.claude', 'cw-runtime'), 'utf8').trim(), '.wf');
    assert.ok(!existsSync(join(dir, '.ai-workflow')), 'update must not relocate the runtime');
  } finally {
    cleanup();
  }
});
