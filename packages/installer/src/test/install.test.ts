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
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'solution-analysis', 'SKILL.md')));
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'wf-feature-from-analysis', 'SKILL.md')));
    assert.ok(existsSync(join(dir, '.claude', 'agents', 'independent-reviewer.md')));
    assert.ok(existsSync(join(dir, '.claude', 'hooks', 'cw-hook.mjs')));
    assert.ok(existsSync(join(dir, '.ai-workflow', 'config.json')));
    assert.ok(existsSync(join(dir, '.ai-workflow', 'runs')));
    assert.ok(existsSync(join(dir, '.ai-workflow', 'templates', 'bug-report.md')));
    assert.ok(existsSync(join(dir, '.ai-workflow', 'templates', 'business-change-report.md')));
    assert.ok(existsSync(join(dir, '.ai-workflow', 'templates', 'recommended-solution.md')));
    assert.ok(existsSync(join(dir, 'CLAUDE.md.cw-backup')));

    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.includes('Project rule stays.'));
    assert.ok(claudeMd.includes('NO BUSINESS DECISION = NO CODING in an L3 run.'));
    assert.ok(claudeMd.includes('Classify every engineering task first'));

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

    assert.ok(!existsSync(join(dir, '.claude', 'skills', 'feature-change', 'SKILL.md')));
    assert.ok(!existsSync(join(dir, '.claude', 'hooks', 'cw-hook.mjs')));
    assert.ok(existsSync(join(dir, '.ai-workflow')));
    assert.ok(existsSync(join(dir, '.ai-workflow', 'templates', 'bug-report.md')));
    assert.match(result.kept.join('\n'), /run evidence, conventions, and report templates/);

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

test('machine-local runtime files are gitignored, shared conventions and templates are not', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const ignore = readFileSync(join(dir, '.ai-workflow', '.gitignore'), 'utf8');
    for (const entry of ['current-run', 'sessions.json', 'hook-errors.log', 'config.json']) {
      assert.ok(ignore.includes(entry), `${entry} must be gitignored`);
    }
    assert.ok(!ignore.includes('conventions'), 'shared repository knowledge stays committable');
    assert.ok(!ignore.includes('templates'), 'shared report templates stay committable');
    const runtimeReadme = readFileSync(join(dir, '.ai-workflow', 'README.md'), 'utf8');
    assert.match(runtimeReadme, /Commit `conventions\/` and `templates\/`/);
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
    for (const skill of [
      'work',
      'feature-change',
      'bug-fix',
      'wf-quick-fix',
      'wf-standard-change',
      'wf-feature-change',
      'solution-analysis',
      'wf-solution-analysis',
      'wf-feature-from-analysis',
      'wf-bug-fix',
    ]) {
      assert.ok(existsSync(join(skills, skill, 'SKILL.md')), `${skill} installed`);
    }
    // The entry points stay user-only; the bodies must be model-invocable, or
    // /work cannot route to them.
    const entry = readFileSync(join(skills, 'feature-change', 'SKILL.md'), 'utf8');
    assert.ok(entry.includes('disable-model-invocation: true'));
    assert.ok(entry.includes('wf-quick-fix'));
    assert.ok(entry.includes('wf-standard-change'));
    assert.ok(entry.includes('wf-feature-change'));
    const body = readFileSync(join(skills, 'wf-feature-change', 'SKILL.md'), 'utf8');
    assert.ok(!body.includes('disable-model-invocation'));
    assert.ok(body.includes('user-invocable: false'));
    const work = readFileSync(join(skills, 'work', 'SKILL.md'), 'utf8');
    for (const body of ['wf-solution-analysis', 'wf-feature-from-analysis', 'wf-quick-fix', 'wf-standard-change', 'wf-bug-fix', 'wf-feature-change']) {
      assert.ok(work.includes(body), `${body} is routable`);
    }
  } finally {
    cleanup();
  }
});

test('report templates are complete, reusable, and preserved on update', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const templates = join(dir, '.ai-workflow', 'templates');
    const names = [
      'bug-report.md',
      'implementation-report.md',
      'feature-report.md',
      'impact-analysis.md',
      'test-report.md',
      'code-review-report.md',
      'change-report.md',
      'release-note.md',
      'business-change-report.md',
      'business-analysis.md',
      'solution-options.md',
      'recommended-solution.md',
      'implementation-plan.md',
      'test-strategy.md',
      'spec-map.md',
      'task-intake.md',
    ];
    for (const name of names) assert.ok(existsSync(join(templates, name)), `${name} installed`);

    const headings = (name: string) =>
      readFileSync(join(templates, name), 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.startsWith('## '));
    assert.deepEqual(headings('bug-report.md'), [
      '## 1. Summary', '## 2. Reproduction', '## 3. Current Flow', '## 4. Root Cause',
      '## 5. Solution', '## 6. Changed Files', '## 7. Impact', '## 8. Verification',
      '## 9. Manual Verification', '## 10. Regression Risk', '## 11. Remaining Issues',
      '## 12. Conclusion',
    ]);
    assert.deepEqual(headings('implementation-report.md'), [
      '## 1. Objective', '## 2. Scope', '## 3. Previous Behavior', '## 4. New Behavior',
      '## 5. Technical Design', '## 6. Implementation Details', '## 7. Files Changed',
      '## 8. Business Rules Affected', '## 9. Compatibility', '## 10. Verification',
      '## 11. Risks', '## 12. Follow-up', '## 13. Final Status',
    ]);
    assert.deepEqual(headings('feature-report.md'), [
      '## 1. Feature Summary', '## 2. Objective', '## 3. Scope', '## 4. Previous Behavior',
      '## 5. New Behavior', '## 6. User Flow', '## 7. Business Rules',
      '## 8. Technical Implementation', '## 9. Files Changed', '## 10. Impact',
      '## 11. Compatibility', '## 12. Verification', '## 13. Risks',
      '## 14. Follow-up', '## 15. Final Status',
    ]);
    assert.deepEqual(headings('impact-analysis.md'), [
      '## 1. Requested Change', '## 2. Current Behavior', '## 3. Expected Behavior',
      '## 4. Affected Areas', '## 5. Business Impact', '## 6. Technical Impact',
      '## 7. Data Impact', '## 8. Compatibility', '## 9. Risks / Edge Cases',
      '## 10. Recommended Implementation Scope', '## 11. Verification Strategy',
      '## 12. Decision / Open Questions',
    ]);
    assert.deepEqual(headings('test-report.md'), [
      '## 1. Change Under Test', '## 2. Test Scope', '## 3. Automated Checks',
      '## 4. Functional Scenarios', '## 5. Regression Areas', '## 6. Not Tested',
      '## 7. Manual Verification Required', '## 8. Final Assessment',
    ]);
    assert.deepEqual(headings('code-review-report.md'), [
      '## 1. Scope Reviewed', '## 2. Summary', '## 3. Findings',
      '## 4. Good Decisions', '## 5. Missing Verification', '## 6. Final Assessment',
    ]);
    assert.deepEqual(headings('change-report.md'), [
      '## 1. Change Summary', '## 2. Reason for Change', '## 3. Previous Behavior',
      '## 4. New Behavior', '## 5. User-visible Impact', '## 6. Business Impact',
      '## 7. Technical Impact', '## 8. Data Impact', '## 9. Compatibility',
      '## 10. Verification', '## 11. Manual Verification', '## 12. Risks',
      '## 13. Follow-up', '## 14. Final Status',
    ]);
    assert.deepEqual(headings('release-note.md'), [
      '## 1. Release Summary', '## 2. Changes Included', '## 3. Reason for Release',
      '## 4. Upgrade / Data / Configuration Actions', '## 5. Compatibility',
      '## 6. Verification', '## 7. Known Issues / Limitations',
      '## 8. Rollout and Rollback Notes', '## 9. Release Status',
    ]);
    assert.deepEqual(headings('business-change-report.md'), [
      '## 1. Bối cảnh', '## 2. Vấn đề trước thay đổi', '## 3. Thay đổi lần này',
      '## 4. Luồng nghiệp vụ sau thay đổi', '## 5. Quy tắc áp dụng',
      '## 6. Vai trò và quyền thao tác', '## 7. Các trường hợp đặc biệt',
      '## 8. Ảnh hưởng tới dữ liệu cũ', '## 9. Những gì không thay đổi',
      '## 10. Kịch bản BA/Test cần kiểm tra', '## 11. Lưu ý khi sử dụng',
    ]);

    const testReport = readFileSync(join(templates, 'test-report.md'), 'utf8');
    assert.ok(testReport.includes('## 6. Not Tested'));
    assert.ok(testReport.includes('PASS WITH MANUAL VERIFICATION'));

    const review = readFileSync(join(templates, 'code-review-report.md'), 'utf8');
    for (const value of ['P0 — Critical', 'P1 — High', 'P2 — Medium', 'P3 — Improvement']) {
      assert.ok(review.includes(value));
    }
    for (const value of ['READY', 'READY WITH FOLLOW-UP', 'NOT READY']) assert.ok(review.includes(value));

    const customized = join(templates, 'bug-report.md');
    writeFileSync(customized, '# Project Bug Report\n\nCustom section\n', 'utf8');
    rmSync(join(templates, 'release-note.md'));

    install({ projectRoot: dir, mode: 'update' });
    assert.equal(readFileSync(customized, 'utf8'), '# Project Bug Report\n\nCustom section\n');
    assert.ok(existsSync(join(templates, 'release-note.md')), 'a deleted default is restored');
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
    assert.ok(rules.includes('Verification is proportional to risk'));
    assert.ok(rules.includes('Reporting mode is independent of task level'));
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
    assert.equal(byName.get('report templates')?.status, 'ok');
    assert.equal(byName.get('analysis artifact templates')?.status, 'ok');
    assert.equal(byName.get('solution-analysis workflow')?.status, 'ok');
    assert.equal(byName.get('analysis handoff config')?.status, 'ok');
    assert.equal(byName.get('managed file ownership')?.status, 'ok');
    assert.equal(byName.get('settings.json hooks')?.status, 'ok');
    assert.equal(byName.get('CLAUDE.md')?.status, 'ok');
    assert.equal(byName.get('semantic progress')?.status, 'ok');
    assert.ok(byName.has('conventions'), 'the convention cache is inspected');
    assert.ok(!after.some((c) => c.status === 'fail'));
  } finally {
    cleanup();
  }
});

test('update adds solution-analysis to a legacy project and preserves ambiguous files', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const runtime = join(dir, '.ai-workflow');
    const legacyManifestFile = join(runtime, 'installed.json');
    const legacy = JSON.parse(readFileSync(legacyManifestFile, 'utf8')) as Record<string, unknown>;
    delete legacy['fileHashes'];
    writeFileSync(legacyManifestFile, JSON.stringify(legacy, null, 2), 'utf8');

    const work = join(dir, '.claude', 'skills', 'work', 'SKILL.md');
    writeFileSync(work, '# Legacy project-owned work routing\n', 'utf8');
    rmSync(join(dir, '.claude', 'skills', 'solution-analysis'), { recursive: true, force: true });
    rmSync(join(dir, '.claude', 'skills', 'wf-solution-analysis'), { recursive: true, force: true });
    rmSync(join(dir, '.ai-workflow', 'templates', 'recommended-solution.md'));

    const result = install({ projectRoot: dir, mode: 'update' });
    assert.equal(readFileSync(work, 'utf8'), '# Legacy project-owned work routing\n');
    assert.ok(result.conflicts.some((item) => item.includes('.claude/skills/work/SKILL.md')));
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'solution-analysis', 'SKILL.md')));
    assert.ok(existsSync(join(dir, '.claude', 'skills', 'wf-solution-analysis', 'SKILL.md')));
    assert.ok(existsSync(join(dir, '.ai-workflow', 'templates', 'recommended-solution.md')));
  } finally {
    cleanup();
  }
});

test('update preserves a hash-detected customized managed skill', () => {
  const { dir, cleanup } = project();
  try {
    install({ projectRoot: dir });
    const skill = join(dir, '.claude', 'skills', 'wf-feature-change', 'SKILL.md');
    const custom = `${readFileSync(skill, 'utf8')}\nProject customization stays.\n`;
    writeFileSync(skill, custom, 'utf8');

    const result = install({ projectRoot: dir, mode: 'update' });
    assert.equal(readFileSync(skill, 'utf8'), custom);
    assert.ok(result.conflicts.some((item) => item.includes('wf-feature-change')));
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
    assert.ok(existsSync(join(dir, '.wf', 'templates', 'implementation-report.md')));

    // No flags anywhere: the runtime, doctor and update all still find `.wf`.
    const runtime = new WorkflowRuntime({ projectRoot: dir });
    assert.equal(runtime.paths.runtimeDir, join(dir, '.wf'));
    const installedRules = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(installedRules, /<runtimeDir>.*\.claude\/cw-runtime/s);
    assert.ok(!installedRules.includes('`.ai-workflow/runs/'));
    assert.ok(!installedRules.includes('`.ai-workflow/conventions/'));

    for (const skill of [
      'wf-feature-change',
      'wf-bug-fix',
      'wf-evidence-reconciliation',
      'wf-bug-root-cause',
      'wf-business-decision',
      'wf-change-readiness',
      'wf-validation-e2e',
      'wf-product-assessment',
      'wf-final-report',
    ]) {
      const instructions = readFileSync(
        join(dir, '.claude', 'skills', skill, 'SKILL.md'),
        'utf8',
      );
      assert.ok(instructions.includes('<runtimeDir>/runs/'), `${skill} uses the discovered runtime`);
      assert.ok(!instructions.includes('`.ai-workflow/runs/'), `${skill} has no hardcoded run path`);
    }

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
