import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyHook } from '../hooks.js';
import { loadWorkflow } from '../loader.js';
import {
  allowedArtifactNames,
  classifyCwCommand,
  evaluateCommand,
  evaluateMutation,
  isCommandTool,
  isFileWriteTool,
  missingGates,
  targetPaths,
  type MutationCheckInput,
  type RunGateContext,
} from '../policy.js';
import { WorkflowRuntime } from '../runtime.js';
import { initialRunState, passGate } from '../state-machine.js';
import { DEFAULT_CONFIG, type RunState, type WorkflowDefinition } from '../types.js';

const T0 = '2026-08-03T10:00:00.000Z';
const PROJECT = process.platform === 'win32' ? 'C:\\proj' : '/proj';
const RUNTIME = join(PROJECT, '.ai-workflow');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-policy-'));
  const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
  runtime.ensureRuntimeDir();
  return { dir, runtime, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

function artifact(runtime: WorkflowRuntime, runId: string, name: string, body = `# ${name}\n`): void {
  writeFileSync(join(runtime.paths.runDir(runId), name), body, 'utf8');
}

function ctx(def: WorkflowDefinition, run: RunState): RunGateContext {
  return { def, run, runDir: join(RUNTIME, 'runs', run.runId) };
}

function check(
  def: WorkflowDefinition,
  run: RunState,
  toolName: string,
  toolInput?: Record<string, unknown>,
  overrides: Partial<MutationCheckInput> = {},
) {
  return evaluateMutation({
    toolName,
    toolInput,
    config: DEFAULT_CONFIG,
    runs: [ctx(def, run)],
    sessionRunId: run.runId,
    projectRoot: PROJECT,
    runtimeDir: RUNTIME,
    ...overrides,
  });
}

// ---- tool classification ---------------------------------------------------

test('write tools, command tools and MCP writers are all recognised', () => {
  const cfg = DEFAULT_CONFIG;
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']) {
    assert.equal(isFileWriteTool(tool, cfg), true, tool);
  }
  for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'Task']) {
    assert.equal(isFileWriteTool(tool, cfg), false, tool);
  }
  // MCP filesystem servers name their own tools; the pattern is what covers them.
  assert.equal(isFileWriteTool('mcp__filesystem__write_file', cfg), true);
  assert.equal(isFileWriteTool('mcp__filesystem__read_file', cfg), false);

  for (const tool of ['Bash', 'PowerShell', 'Monitor']) {
    assert.equal(isCommandTool(tool, cfg), true, tool);
  }
  assert.equal(isCommandTool('Read', cfg), false);
});

test('targetPaths finds every path a write tool names, including nested edits', () => {
  assert.deepEqual(targetPaths({ file_path: 'a.ts' }), ['a.ts']);
  assert.deepEqual(targetPaths({ notebook_path: 'n.ipynb' }), ['n.ipynb']);
  assert.deepEqual(
    targetPaths({ edits: [{ file_path: 'a.ts' }, { file_path: 'b.ts' }] }).sort(),
    ['a.ts', 'b.ts'],
  );
  assert.deepEqual(targetPaths(undefined), []);
});

// ---- command allowlist -----------------------------------------------------

test('read-only commands survive an open gate', () => {
  for (const command of [
    'git status',
    'git diff HEAD~1',
    'git log --oneline -20',
    'git show abc123',
    'git ls-files',
    'grep -rn TODO src',
    'rg canCancel',
    'ls -la src',
    'cat package.json',
    'cw status',
    'cw phase enter evidence',
    'git diff && git status',
    'npm test',
    'npm run build',
    'pytest -q',
    'go test ./...',
    'cargo check',
    'Get-ChildItem src',
    'Get-Content package.json',
    'Select-String -Pattern TODO -Path src',
    'find . -name "*.test.ts"',
    'fd --extension ts',
    'sort -u',
    'git   status',
    '/usr/bin/git log -1',
  ]) {
    assert.equal(evaluateCommand(command, DEFAULT_CONFIG).safe, true, command);
  }
});

test('turning off the test-command exception makes the allowlist strictly read-only', () => {
  const strict = { ...DEFAULT_CONFIG, allowTestCommandsBehindGate: false };
  assert.equal(evaluateCommand('npm test', strict).safe, false);
  assert.equal(evaluateCommand('make install', strict).safe, false);
  assert.equal(evaluateCommand('git status', strict).safe, true);
});

test('every command that can write a file is refused behind a gate', () => {
  const cases: Array<[string, RegExp]> = [
    ['echo hacked > src/orders.js', /redirect/],
    ['cat evidence >> src/orders.js', /redirect/],
    ['printf x | tee src/orders.js', /allowlist/],
    ["python -c \"open('src/orders.js','w').write('x')\"", /allowlist/],
    ['python3 write.py', /allowlist/],
    ['node -e "require(\'fs\').writeFileSync(\'a.js\',\'x\')"', /allowlist/],
    ['npx tsx write.ts', /allowlist/],
    ["sed -i 's/a/b/' src/orders.js", /allowlist/],
    ['perl -pi -e s/a/b/ src/orders.js', /allowlist/],
    ['git apply patch.diff', /read-only git subcommand/],
    ['git checkout -- src/orders.js', /read-only git subcommand/],
    ['git commit -am wip', /read-only git subcommand/],
    ['git branch -D main', /modifies a branch/],
    ['Set-Content -Path src/orders.js -Value x', /allowlist/],
    ['Out-File -FilePath src/orders.js', /allowlist/],
    ['Get-Content a.txt | Set-Content b.txt', /allowlist/],
    ['New-Item -ItemType File src/x.js', /allowlist/],
    ['powershell -Command "Set-Content a b"', /allowlist/],
    ['bash -c "echo x > f"', /redirect/],
    ['git status; rm -rf src', /allowlist/],
    ['git status && sed -i s/a/b/ f', /allowlist/],
    ['cp evidence.md src/orders.js', /allowlist/],
    ['mv a b', /allowlist/],
    ['touch newfile.js', /allowlist/],
    ['npm install left-pad', /allowed test\/build command/],
    ['echo $(sed -i s/a/b/ f)', /redirect/],
    // Readers that turn into writers or executors when given the right flag.
    ['find . -name "*.js" -delete', /can write or execute/],
    ['find src -exec sed -i s/a/b/ {} ;', /can write or execute/],
    ['fd -x sed -i s/a/b/', /can write or execute/],
    ['fd --exec rm', /can write or execute/],
    ['sort -o src/orders.js src/orders.js', /can write or execute/],
    // Text utilities that can run arbitrary programs.
    ["awk 'BEGIN{system(\"rm -rf src\")}'", /allowlist/],
    ['env FOO=1 sed -i s/a/b/ f', /allowlist/],
    ['sh -c "sed -i s/a/b/ f"', /allowlist/],
    ['busybox sed -i s/a/b/ f', /allowlist/],
    ['xargs rm', /allowlist/],
    ['truncate -s 0 src/orders.js', /allowlist/],
    ['curl -o src/orders.js http://x', /allowlist/],
    ['Remove-Item src/orders.js', /allowlist/],
    ['Copy-Item a src/orders.js', /allowlist/],
    ['Invoke-WebRequest -OutFile src/x.js http://x', /allowlist/],
    ['git stash', /read-only git subcommand/],
    ['git restore src/orders.js', /read-only git subcommand/],
    ['git config core.hooksPath /tmp/x', /read-only git subcommand/],
  ];
  for (const [command, reason] of cases) {
    const verdict = evaluateCommand(command, DEFAULT_CONFIG);
    assert.equal(verdict.safe, false, `must be refused: ${command}`);
    assert.match(verdict.reason ?? '', reason, command);
  }
});

test('classifyCwCommand separates reporting from state changes', () => {
  assert.equal(classifyCwCommand('cw status')?.semantic, undefined);
  assert.equal(classifyCwCommand('cw run list'), undefined);
  assert.equal(classifyCwCommand('cw phase enter business')?.semantic, true);
  assert.equal(classifyCwCommand('cw gate pass BUSINESS_READY')?.semantic, true);
  assert.equal(classifyCwCommand('cw run complete')?.semantic, true);
  assert.equal(classifyCwCommand('cw run abandon --run fc-1')?.runId, 'fc-1');
  assert.equal(classifyCwCommand('cw run escalate feature-change --reason risk')?.semantic, true);
  assert.equal(classifyCwCommand('cw analysis approve --solution A --scope B')?.semantic, true);
  assert.equal(classifyCwCommand('cw note "x" --run=fc-2')?.runId, 'fc-2');
});

// ---- gate arithmetic -------------------------------------------------------

test('feature-change blocks repository mutation until BUSINESS_READY', () => {
  const def = loadWorkflow('feature-change');
  const run = initialRunState(def, 'fc-test-001', T0);
  assert.deepEqual(missingGates(def, run), ['BUSINESS_READY']);

  const denied = check(def, run, 'Edit', { file_path: 'src/orders.js' });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.kind, 'repository');
  assert.deepEqual(denied.missingGates, ['BUSINESS_READY']);

  assert.equal(check(def, run, 'Read', { file_path: 'src/orders.js' }).decision, 'allow');

  passGate(def, run, 'BUSINESS_READY', T0);
  assert.equal(check(def, run, 'Edit', { file_path: 'src/orders.js' }).decision, 'allow');
});

test('bug-fix needs both gates before anything may change', () => {
  const def = loadWorkflow('bug-fix');
  const run = initialRunState(def, 'bf-test-001', T0);
  assert.deepEqual(missingGates(def, run).sort(), ['BUSINESS_READY', 'ROOT_CAUSE_READY']);
  assert.equal(check(def, run, 'Write', { file_path: 'src/orders.js' }).decision, 'deny');

  passGate(def, run, 'ROOT_CAUSE_READY', T0);
  const still = check(def, run, 'Write', { file_path: 'src/orders.js' });
  assert.equal(still.decision, 'deny');
  assert.deepEqual(still.missingGates, ['BUSINESS_READY']);

  passGate(def, run, 'BUSINESS_READY', T0);
  assert.equal(check(def, run, 'Write', { file_path: 'src/orders.js' }).decision, 'allow');
});

test('a gateless workflow, a finished run and enforceGates=false never deny', () => {
  const generic = loadWorkflow('generic');
  const g = initialRunState(generic, 'g-test-001', T0);
  assert.equal(check(generic, g, 'Edit', { file_path: 'src/a.js' }).decision, 'allow');
  assert.equal(check(generic, g, 'Bash', { command: 'rm -rf src' }).decision, 'allow');

  const fc = loadWorkflow('feature-change');
  const done = initialRunState(fc, 'fc-test-002', T0);
  done.status = 'COMPLETED';
  assert.equal(check(fc, done, 'Edit', { file_path: 'src/a.js' }).decision, 'allow');

  const open = initialRunState(fc, 'fc-test-003', T0);
  assert.equal(
    evaluateMutation({
      toolName: 'Edit',
      toolInput: { file_path: 'src/a.js' },
      config: { ...DEFAULT_CONFIG, enforceGates: false },
      runs: [ctx(fc, open)],
      projectRoot: PROJECT,
      runtimeDir: RUNTIME,
    }).decision,
    'allow',
  );
});

// ---- workflow artifact writes (WF-01) --------------------------------------

test('the declared artifact of the current phase is writable behind its own gate', () => {
  const def = loadWorkflow('feature-change');
  const run = initialRunState(def, 'fc-test-004', T0);
  run.currentNode = 'business';
  run.nodes['business'] = { status: 'ACTIVE', visits: 1 };
  assert.deepEqual(allowedArtifactNames(def, run), ['business-decision.md']);

  const runDir = join(RUNTIME, 'runs', run.runId);
  const allowed = check(def, run, 'Write', { file_path: join(runDir, 'business-decision.md') });
  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.kind, 'workflow-artifact');

  // Another phase's artifact, the machine-owned state and an escape all fail.
  for (const target of [
    join(runDir, 'evidence.md'),
    join(runDir, 'state.json'),
    join(runDir, 'nested', 'business-decision.md'),
    join(runDir, '..', 'business-decision.md'),
    join(RUNTIME, 'config.json'),
  ]) {
    const denied = check(def, run, 'Write', { file_path: target });
    assert.equal(denied.decision, 'deny', target);
  }

  // Repository content that merely shares the filename is still repository content.
  const outside = check(def, run, 'Write', { file_path: join(PROJECT, 'business-decision.md') });
  assert.equal(outside.decision, 'deny');
  assert.equal(outside.kind, 'repository');
});

test('a waiting node may still write the gate owner evidence', () => {
  const def = loadWorkflow('feature-change');
  const run = initialRunState(def, 'fc-test-005', T0);
  run.currentNode = 'await-business';
  assert.deepEqual(allowedArtifactNames(def, run), ['business-decision.md']);
});

// ---- repository-level authority (HG-02) ------------------------------------

test('a second session may not mutate while another session owns an open gate', () => {
  const def = loadWorkflow('feature-change');
  const owned = initialRunState(def, 'fc-owned-001', T0);
  owned.ownerSessionId = 'session-a';

  const denied = evaluateMutation({
    toolName: 'Edit',
    toolInput: { file_path: join(PROJECT, 'src', 'orders.js') },
    config: DEFAULT_CONFIG,
    runs: [ctx(def, owned)],
    sessionRunId: undefined,
    sessionId: 'session-b',
    projectRoot: PROJECT,
    runtimeDir: RUNTIME,
  });
  assert.equal(denied.decision, 'deny', 'authorisation is a project property, not a session property');
  assert.equal(denied.runId, 'fc-owned-001');
});

test('a semantic cw command from a non-owner session is refused', () => {
  const def = loadWorkflow('feature-change');
  const run = initialRunState(def, 'fc-owned-002', T0);
  run.ownerSessionId = 'session-a';
  passGate(def, run, 'BUSINESS_READY', T0);

  const base = {
    config: DEFAULT_CONFIG,
    runs: [ctx(def, run)],
    projectRoot: PROJECT,
    runtimeDir: RUNTIME,
  };
  const denied = evaluateMutation({
    ...base,
    toolName: 'Bash',
    toolInput: { command: 'cw run complete' },
    sessionId: 'session-b',
  });
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason ?? '', /owned by Claude session session-a/);

  // Even with every gate passed, reporting stays open to anyone.
  assert.equal(
    evaluateMutation({ ...base, toolName: 'Bash', toolInput: { command: 'cw status' }, sessionId: 'session-b' })
      .decision,
    'allow',
  );
  // And the owner is not blocked from its own run.
  assert.equal(
    evaluateMutation({
      ...base,
      toolName: 'Bash',
      toolInput: { command: 'cw run complete' },
      sessionId: 'session-a',
    }).decision,
    'allow',
  );
});

// ---- through the real hook path -------------------------------------------

test('the PreToolUse hook denies Edit before the gate and allows it after', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change', { label: 'gate test' });

    const denied = applyHook(runtime, {
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/orders.js' },
    });
    assert.equal(denied.mutation?.decision, 'deny');
    assert.match(denied.mutation?.reason ?? '', /BUSINESS_READY/);
    assert.notEqual(runtime.run(run.runId).runtime.claude, 'TOOL_RUNNING');
    assert.ok(runtime.events(run.runId).some((e) => e.type === 'MUTATION_DENIED'));

    // The policy layer records that it actually ran.
    assert.equal(runtime.policyHealth()?.status, 'OK');

    const readAllowed = applyHook(runtime, {
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'Read',
      tool_input: { file_path: 'src/orders.js' },
    });
    assert.equal(readAllowed.mutation?.decision, 'allow');

    runtime.enterPhase('evidence');
    artifact(runtime, run.runId, 'evidence.md');
    runtime.enterPhase('business');
    artifact(runtime, run.runId, 'business-decision.md');
    runtime.passGate('BUSINESS_READY');

    const allowed = applyHook(runtime, {
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/orders.js' },
    });
    assert.equal(allowed.mutation?.decision, 'allow');
  } finally {
    cleanup();
  }
});

test('the hook refuses shell writes and allows the declared artifact write', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change', { label: 'shell test' });
    runtime.enterPhase('evidence');

    const pre = (tool: string, input: Record<string, unknown>) =>
      applyHook(runtime, {
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        tool_name: tool,
        tool_input: input,
      }).mutation;

    assert.equal(pre('Bash', { command: 'echo x > src/orders.js' })?.decision, 'deny');
    assert.equal(pre('Bash', { command: "python -c \"open('a','w')\"" })?.decision, 'deny');
    assert.equal(pre('PowerShell', { command: 'Set-Content src/orders.js x' })?.decision, 'deny');
    assert.equal(pre('Monitor', { command: 'sed -i s/a/b/ src/orders.js' })?.decision, 'deny');
    assert.equal(pre('Bash', { command: 'git status' })?.decision, 'allow');

    const artifactWrite = pre('Write', {
      file_path: join(runtime.paths.runDir(run.runId), 'evidence.md'),
    });
    assert.equal(artifactWrite?.decision, 'allow', 'the phase that produces evidence cannot be blocked by it');
    assert.equal(artifactWrite?.kind, 'workflow-artifact');

    // A directory inside the run directory is not a place to write either.
    mkdirSync(join(runtime.paths.runDir(run.runId), 'sub'), { recursive: true });
    assert.equal(
      pre('Write', { file_path: join(runtime.paths.runDir(run.runId), 'sub', 'evidence.md') })?.decision,
      'deny',
    );
  } finally {
    cleanup();
  }
});

test('with no active run nothing is ever denied', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const result = applyHook(runtime, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Edit' });
    assert.equal(result.mutation?.decision, 'allow');
  } finally {
    cleanup();
  }
});
