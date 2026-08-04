#!/usr/bin/env node
// End-to-end verification: install the kit into a copy of the demo project,
// drive a full feature-change run through the `cw` CLI and the hook script,
// and confirm the monitor server reports what actually happened.
//
// Run with: npm run e2e

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const demoSource = join(repoRoot, 'examples', 'demo-project');
const cwBin = join(repoRoot, 'packages', 'installer', 'bin', 'cw.mjs');
const kitBin = join(repoRoot, 'packages', 'installer', 'bin', 'claude-workflow-kit.mjs');

const project = mkdtempSync(join(tmpdir(), 'cwk-e2e-'));
let monitor;
let failed = false;

const steps = [];
function step(name, fn) {
  steps.push([name, fn]);
}

function run(bin, args, options = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: project,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${bin} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function cw(...args) {
  return run(cwBin, ['--project', project, ...args]);
}

/**
 * Runs the installed hook script exactly as Claude Code would: payload on
 * stdin, project root only via CLAUDE_PROJECT_DIR, and a working directory that
 * is deliberately *not* the project — a hook that needs the cwd is broken.
 */
function hook(payload, options = {}) {
  return run(join(project, '.claude', 'hooks', 'cw-hook.mjs'), [], {
    input: JSON.stringify(payload),
    cwd: options.cwd ?? tmpdir(),
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
  });
}

/** The hook's PreToolUse verdict, as Claude Code would parse it. */
function hookDecision(payload) {
  const out = hook(payload).stdout.trim();
  if (!out) return { decision: 'allow' };
  const parsed = JSON.parse(out);
  return {
    decision: parsed.hookSpecificOutput?.permissionDecision ?? 'allow',
    reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? '',
  };
}

function state() {
  const runId = readFileSync(join(project, '.ai-workflow', 'current-run'), 'utf8').trim();
  return JSON.parse(readFileSync(join(project, '.ai-workflow', 'runs', runId, 'state.json'), 'utf8'));
}

function writeArtifact(name, body) {
  writeFileSync(join(project, '.ai-workflow', 'runs', state().runId, name), body ?? `# ${name}\n`);
}

// --- 1. install ------------------------------------------------------------

step('install into a clean project copy', () => {
  cpSync(demoSource, project, { recursive: true });
  const result = run(kitBin, ['init', '--project', project]);
  assert.match(result.stdout, /Installed preset "senior-dev"/);

  assert.ok(existsSync(join(project, '.claude', 'skills', 'feature-change', 'SKILL.md')));
  assert.ok(existsSync(join(project, '.claude', 'skills', 'wf-standard-change', 'SKILL.md')));
  assert.ok(existsSync(join(project, '.claude', 'hooks', 'cw-hook.mjs')));
  assert.ok(existsSync(join(project, '.ai-workflow', 'config.json')));
  assert.ok(existsSync(join(project, '.ai-workflow', 'templates', 'implementation-report.md')));

  const claudeMd = readFileSync(join(project, 'CLAUDE.md'), 'utf8');
  assert.ok(claudeMd.includes('This line exists to prove the installer merges'), 'user content survived');
  assert.ok(claudeMd.includes('NO BUSINESS DECISION = NO CODING in an L3 run.'), 'managed block injected');

  // The output policy must stand on its own: no external plugin dependency.
  assert.ok(!claudeMd.includes('caveman'), 'no dependency on an external compression plugin');
  assert.ok(claudeMd.includes('COMPRESS WORDING, NOT SUBSTANCE.'), 'built-in policy present');

  // Routing target for /work must be model-invocable.
  const workflowBody = readFileSync(
    join(project, '.claude', 'skills', 'wf-feature-change', 'SKILL.md'),
    'utf8',
  );
  assert.ok(!workflowBody.includes('disable-model-invocation'), '/work can reach the workflow body');
});

step('a session that only starts leaves no run behind', () => {
  hook({ hook_event_name: 'SessionStart', session_id: 'boot' });
  assert.ok(
    !existsSync(join(project, '.ai-workflow', 'current-run')),
    'SessionStart alone must not open a run',
  );
});

// --- 2. semantic run -------------------------------------------------------

step('start a feature-change run', () => {
  cw('run', 'start', 'feature-change', '--label', 'edit history standalone communication');
  const run = state();
  assert.equal(run.workflow, 'feature-change');
  assert.equal(run.currentNode, 'prompt');
});

step('a second run is refused instead of orphaning the first', () => {
  const blocked = run(cwBin, ['--project', project, 'run', 'start', 'feature-change'], {
    allowFailure: true,
  });
  assert.equal(blocked.status, 1, 'a second concurrent run must fail');
  assert.match(blocked.stderr, /still active/);
  assert.match(blocked.stderr, /cw run abandon/);
  assert.equal(cw('run', 'list').stdout.trim().split('\n').length, 1, 'still exactly one run');
});

step('1. direct writes to source are denied while BUSINESS_READY is open', () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    const denied = hookDecision({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: tool,
      tool_input: { file_path: join(project, 'src', 'orders.js') },
    });
    assert.equal(denied.decision, 'deny', `${tool} must not reach source before the decision`);
    assert.match(denied.reason, /BUSINESS_READY/);
  }
  // A relative path resolves against the project root, not the hook's cwd.
  assert.equal(
    hookDecision({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'Write',
      tool_input: { file_path: 'src/orders.js' },
    }).decision,
    'deny',
  );
});

step('4/5/6/7. no command tool can write a file behind the gate', () => {
  const probes = [
    ['Bash', 'echo hacked > src/orders.js', 'shell redirection'],
    ['Bash', 'printf x | tee src/orders.js', 'pipe into a writer'],
    ['Bash', "python -c \"open('src/orders.js','w').write('x')\"", 'python one-liner'],
    ['Bash', 'python3 tools/write.py', 'python script'],
    ['Bash', 'node -e "require(\'fs\').writeFileSync(\'src/orders.js\',\'x\')"', 'node one-liner'],
    ['Bash', "sed -i 's/a/b/' src/orders.js", 'in-place sed'],
    ['Bash', 'git apply patch.diff', 'git apply'],
    ['Bash', 'git checkout -- src/orders.js', 'git checkout --'],
    ['Bash', 'cp /tmp/x src/orders.js', 'copy over source'],
    ['Bash', 'git status && sed -i s/a/b/ src/orders.js', 'chained after a safe command'],
    ['PowerShell', 'Set-Content -Path src/orders.js -Value x', 'Set-Content'],
    ['PowerShell', '"x" | Out-File src/orders.js', 'Out-File'],
    ['PowerShell', 'New-Item -ItemType File src/new.js', 'New-Item'],
    ['Monitor', 'sed -i s/a/b/ src/orders.js', 'the command-running Monitor tool'],
  ];
  for (const [tool, command, what] of probes) {
    const decision = hookDecision({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: tool,
      tool_input: { command },
    });
    assert.equal(decision.decision, 'deny', `${what} must be denied: ${tool} ${command}`);
  }
});

step('read-only and test commands stay usable behind the gate', () => {
  for (const call of [
    { tool_name: 'Read', tool_input: { file_path: 'src/orders.js' } },
    { tool_name: 'Grep', tool_input: { pattern: 'canCancel' } },
    { tool_name: 'Bash', tool_input: { command: 'npm test' } },
    { tool_name: 'Bash', tool_input: { command: 'git diff HEAD' } },
    { tool_name: 'Bash', tool_input: { command: 'git status && git log --oneline -5' } },
    { tool_name: 'Bash', tool_input: { command: 'rg canCancel src' } },
    { tool_name: 'Bash', tool_input: { command: 'cw status' } },
    { tool_name: 'Bash', tool_input: { command: 'cw phase enter evidence' } },
    { tool_name: 'PowerShell', tool_input: { command: 'Get-Content package.json' } },
  ]) {
    const allowed = hookDecision({ hook_event_name: 'PreToolUse', session_id: 's1', ...call });
    assert.equal(allowed.decision, 'allow', `must stay allowed: ${JSON.stringify(call)}`);
  }
});

step('2/3. workflow artifact writes are allowed, everything else in the runtime is not', () => {
  cw('phase', 'enter', 'evidence');
  const runDir = join(project, '.ai-workflow', 'runs', state().runId);

  const allowed = hookDecision({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_name: 'Write',
    tool_input: { file_path: join(runDir, 'evidence.md') },
  });
  assert.equal(allowed.decision, 'allow', 'the phase that produces the evidence cannot be blocked by it');

  mkdirSync(join(runDir, 'sub'), { recursive: true });
  for (const target of [
    join(runDir, 'business-decision.md'), // declared by another phase
    join(runDir, 'state.json'), // machine-owned
    join(runDir, 'events.jsonl'),
    join(runDir, 'sub', 'evidence.md'), // nested: not the declared path
    join(runDir, '..', '..', 'config.json'), // escapes the run directory
    join(project, '.ai-workflow', 'config.json'),
    join(project, 'evidence.md'), // same name, repository content
  ]) {
    const denied = hookDecision({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'Write',
      tool_input: { file_path: target },
    });
    assert.equal(denied.decision, 'deny', `must be denied: ${target}`);
  }
  rmSync(join(runDir, 'sub'), { recursive: true, force: true });
});

step('13/14. an empty file and a directory are not evidence', () => {
  const runDir = join(project, '.ai-workflow', 'runs', state().runId);

  writeArtifact('evidence.md', '');
  let blocked = run(cwBin, ['--project', project, 'phase', 'complete'], { allowFailure: true });
  assert.equal(blocked.status, 1, 'an empty artifact does not satisfy the contract');
  assert.match(blocked.stderr, /evidence\.md/);

  rmSync(join(runDir, 'evidence.md'));
  mkdirSync(join(runDir, 'evidence.md'), { recursive: true });
  blocked = run(cwBin, ['--project', project, 'phase', 'complete'], { allowFailure: true });
  assert.equal(blocked.status, 1, 'a directory named like the artifact is not the artifact');
  const status = run(cwBin, ['--project', project, 'status']);
  assert.match(status.stdout, /unusable\s+evidence\.md \(is a directory/);
  rmSync(join(runDir, 'evidence.md'), { recursive: true });
});

step('evidence phase', () => {
  writeArtifact('evidence.md', '# Evidence\n\nC-001: document says aggregate, code stores per entity.\n');
  cw('artifact', 'evidence.md');
  cw('phase', 'complete');
  assert.equal(state().nodes.evidence.status, 'COMPLETED');
  assert.deepEqual(state().artifacts, ['evidence.md']);
});

step('12. gate wait cannot be reached from an unrelated phase', () => {
  // Still at `evidence`: the business gate is not this phase's to park.
  const teleport = run(
    cwBin,
    ['--project', project, 'gate', 'wait', 'BUSINESS_READY', '--message', 'skip ahead'],
    { allowFailure: true },
  );
  assert.equal(teleport.status, 1, 'a waiting node must be walked into, not jumped to');
  assert.match(teleport.stderr, /owning phase "business"/);
  assert.equal(state().currentNode, 'evidence');
  assert.equal(state().status, 'RUNNING');
});

step('the business gate blocks implementation', () => {
  cw('phase', 'enter', 'business');
  const blocked = run(cwBin, ['--project', project, 'phase', 'enter', 'implementation'], {
    allowFailure: true,
  });
  assert.equal(blocked.status, 1, 'entering implementation before BUSINESS_READY must fail');
  assert.match(blocked.stderr, /no edge business -> implementation/);
});

step('the gate refuses to open without its evidence artifact', () => {
  const noEvidence = run(cwBin, ['--project', project, 'gate', 'pass', 'BUSINESS_READY'], {
    allowFailure: true,
  });
  assert.equal(noEvidence.status, 1, 'a gate is not a formality');
  assert.match(noEvidence.stderr, /business-decision\.md/);
  assert.equal(state().gates.BUSINESS_READY, 'OPEN');
});

step('waiting for the user parks the run without ending it', () => {
  cw('gate', 'wait', 'BUSINESS_READY', '--message', 'aggregate or per-entity ownership?');
  const run = state();
  assert.equal(run.status, 'WAITING_USER');
  assert.equal(run.currentNode, 'await-business');
  assert.equal(run.nodes['await-business'].status, 'WAITING_USER');
});

step('a follow-up prompt continues the same run', () => {
  const before = state().runId;
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'per entity, please' });
  const after = state();
  assert.equal(after.runId, before, 'no new run was created');
  assert.equal(after.runtime.claude, 'ACTIVE');
  assert.equal(after.status, 'WAITING_USER', 'a hook must not change the semantic phase');
  assert.equal(after.ownerSessionId, 's1', 'the run is now owned by this session');
});

step('8. a second Claude session may neither mutate the repo nor this run', () => {
  const before = state();
  hook({ hook_event_name: 'PreToolUse', session_id: 'other', tool_name: 'Bash' });
  const after = state();
  assert.equal(after.runtime.tool, before.runtime.tool, "another session's tool is not recorded here");
  assert.equal(after.ownerSessionId, 's1');
  assert.equal(cw('run', 'list').stdout.trim().split('\n').length, 1, 'and it did not fork a run');

  // Authorisation is a property of the project: session B is behind A's gate too.
  const denied = hookDecision({
    hook_event_name: 'PreToolUse',
    session_id: 'other',
    tool_name: 'Edit',
    tool_input: { file_path: join(project, 'src', 'orders.js') },
  });
  assert.equal(denied.decision, 'deny', "another session must not bypass session A's open gate");
  assert.match(denied.reason, /BUSINESS_READY/);
});

step('9. a non-owner session cannot run a semantic cw command', () => {
  const denied = hookDecision({
    hook_event_name: 'PreToolUse',
    session_id: 'other',
    tool_name: 'Bash',
    tool_input: { command: 'cw run abandon --message "not mine"' },
  });
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /owned by Claude session s1/);
  assert.match(denied.reason, /cw run claim/);
  assert.equal(state().status, 'WAITING_USER', 'the run is untouched');

  // Reporting is never owned.
  assert.equal(
    hookDecision({
      hook_event_name: 'PreToolUse',
      session_id: 'other',
      tool_name: 'Bash',
      tool_input: { command: 'cw status --json' },
    }).decision,
    'allow',
  );
});

step('runtime hooks report tool and subagent activity', () => {
  hook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Grep' });
  assert.equal(state().runtime.claude, 'TOOL_RUNNING');
  assert.equal(state().runtime.tool, 'Grep');

  hook({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Grep' });
  assert.equal(state().runtime.claude, 'ACTIVE');

  hook({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', subagent_type: 'independent-reviewer' });
  assert.equal(state().runtime.claude, 'SUBAGENT_RUNNING');
  assert.equal(state().agents.a1.status, 'RUNNING');

  hook({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1' });
  assert.equal(state().agents.a1.status, 'STOPPED');

  assert.ok(!existsSync(join(project, '.ai-workflow', 'hook-errors.log')), 'no hook errors');
});

step('passing the gate releases the run and unblocks mutation', () => {
  cw('phase', 'enter', 'business');
  writeArtifact('business-decision.md', '# Resolved\n\nPer-entity edit history.\n');
  cw('artifact', 'business-decision.md');
  cw('gate', 'pass', 'BUSINESS_READY');
  const run = state();
  assert.equal(run.gates.BUSINESS_READY, 'PASSED');
  assert.equal(run.status, 'RUNNING');

  const allowed = hookDecision({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_name: 'Edit',
    tool_input: { file_path: join(project, 'src', 'orders.js') },
  });
  assert.equal(allowed.decision, 'allow', 'the same edit is allowed once the gate passed');
});

step('run the remaining phases including a review loop', () => {
  for (const name of ['implementation-plan.md', 'impact-risk-scope.md', 'test-strategy.md']) {
    writeArtifact(name);
  }
  writeArtifact('validation.md');
  writeArtifact('review.md');
  for (const node of ['readiness', 'conventions', 'implementation', 'validation', 'e2e', 'review']) {
    cw('phase', 'enter', node);
    cw('phase', 'complete');
  }
  // Reviewer found something: legal back edge to implementation.
  cw('phase', 'enter', 'implementation');
  cw('phase', 'complete');
  cw('phase', 'enter', 'validation');
  cw('phase', 'complete');
  cw('phase', 'enter', 'e2e');
  cw('phase', 'complete');
  cw('phase', 'enter', 'review');
  cw('phase', 'complete');
  writeArtifact('assessment.md');
  cw('phase', 'enter', 'assessment');
  cw('phase', 'complete');
  writeArtifact('final-report.md');
  cw('phase', 'enter', 'report');
  cw('phase', 'complete');

  assert.equal(state().nodes.implementation.visits, 2, 'review loop re-entered implementation');
  assert.equal(
    cw('status').stderr.includes('missing'),
    false,
    'every declared artifact was written, so no warning',
  );
});

step('21. the review loop records the path actually taken', () => {
  const transitions = state().transitions;
  assert.ok(Array.isArray(transitions) && transitions.length > 8, 'the traversed path is recorded');
  const last = transitions.at(-1);
  assert.deepEqual({ from: last.from, to: last.to }, { from: 'assessment', to: 'report' });
  // Both directions of the loop happened, in order, exactly once each per pass.
  const hops = transitions.map((t) => `${t.from}->${t.to}`);
  assert.equal(hops.filter((h) => h === 'review->implementation').length, 1);
  assert.ok(hops.indexOf('review->implementation') < hops.lastIndexOf('e2e->review'));
});

step('11. a premature run complete is refused', () => {
  // The run is at `report` but the report artifact is the last thing missing.
  const runDir = join(project, '.ai-workflow', 'runs', state().runId);
  const saved = readFileSync(join(runDir, 'final-report.md'), 'utf8');
  rmSync(join(runDir, 'final-report.md'));
  const refused = run(cwBin, ['--project', project, 'run', 'complete'], { allowFailure: true });
  assert.equal(refused.status, 1, 'COMPLETED is a claim, so it is verified');
  assert.match(refused.stderr, /final-report\.md/);
  assert.match(refused.stderr, /cw run abandon/);
  assert.notEqual(state().status, 'COMPLETED');
  writeFileSync(join(runDir, 'final-report.md'), saved);
});

step('completing the run clears the active pointer', () => {
  const runId = state().runId;
  cw('run', 'complete');
  const run = JSON.parse(
    readFileSync(join(project, '.ai-workflow', 'runs', runId, 'state.json'), 'utf8'),
  );
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.currentNode, 'done');
  assert.ok(!existsSync(join(project, '.ai-workflow', 'current-run')));
});

// --- 3. monitor ------------------------------------------------------------

step('the monitor server reports the run', async () => {
  const { startMonitor } = await import(
    pathToFileURL(join(repoRoot, 'packages', 'monitor-server', 'dist', 'index.js')).href
  );
  monitor = startMonitor({ projectRoot: project, port: 4899, pollMs: 200 });

  const health = await fetch('http://127.0.0.1:4899/api/health').then((r) => r.json());
  assert.equal(health.ok, true);

  const snapshot = await fetch('http://127.0.0.1:4899/api/state').then((r) => r.json());
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].derivedStatus, 'COMPLETED');
  assert.ok(snapshot.workflows.some((w) => w.id === 'feature-change'));

  const detail = await fetch(
    `http://127.0.0.1:4899/api/runs/${snapshot.runs[0].runId}`,
  ).then((r) => r.json());
  assert.ok(detail.events.length > 20, `expected a full event log, got ${detail.events.length}`);
  assert.equal(detail.events[0].type, 'RUN_STARTED');
  assert.ok(detail.events.some((e) => e.type === 'GATE_WAIT'));
  assert.ok(detail.events.some((e) => e.type === 'GATE_PASS'));
  assert.ok(detail.events.some((e) => e.type === 'TOOL_START'));
  assert.ok(detail.events.some((e) => e.type === 'MUTATION_DENIED'), 'the denial is in the log');
  assert.ok(detail.artifacts.includes('evidence.md'));
  assert.ok(detail.artifacts.includes('business-decision.md'));
  assert.equal(detail.run.derivedSemantic, 'OK');

  const artifact = await fetch(
    `http://127.0.0.1:4899/api/runs/${snapshot.runs[0].runId}/artifacts/evidence.md`,
  ).then((r) => r.text());
  assert.match(artifact, /C-001/);
});

step('the SSE stream pushes a new run', async () => {
  const res = await fetch('http://127.0.0.1:4899/api/stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  const readFrame = async () => {
    let buffer = '';
    while (!buffer.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed');
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer;
  };

  const first = await readFrame();
  assert.match(first, /event: snapshot/);

  cw('run', 'start', 'bug-fix', '--label', 'cancel button does nothing');
  const pushed = await readFrame();
  const payload = JSON.parse(pushed.slice(pushed.indexOf('data: ') + 6).split('\n')[0]);
  assert.equal(payload.runs.length, 2);
  assert.ok(payload.runs.some((r) => r.workflow === 'bug-fix'));

  await reader.cancel();
});

step('18. a time-only status change is pushed to the browser', async () => {
  // POSSIBLY_STALLED and SEMANTIC_LAG are functions of elapsed time: they flip
  // with no new event at all. If they are not in the change signature, the
  // server goes stale and the browser never hears about it.
  await monitor.close();
  const configFile = join(project, '.ai-workflow', 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(
    configFile,
    JSON.stringify({ ...config, stallThresholdSeconds: 1, semanticLagThresholdSeconds: 1 }, null, 2),
  );

  const { startMonitor } = await import(
    pathToFileURL(join(repoRoot, 'packages', 'monitor-server', 'dist', 'index.js')).href
  );
  monitor = startMonitor({ projectRoot: project, port: 4900, pollMs: 200 });

  cw('note', 'about to go quiet');
  const res = await fetch('http://127.0.0.1:4900/api/stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  const deadline = Date.now() + 8000;
  let sawStalled = false;
  let buffer = '';
  while (Date.now() < deadline && !sawStalled) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const frame of buffer.split('\n\n')) {
      const marker = frame.indexOf('data: ');
      if (marker === -1) continue;
      const payload = JSON.parse(frame.slice(marker + 6).split('\n')[0]);
      if (payload.runs?.some((r) => r.derivedStatus === 'POSSIBLY_STALLED')) sawStalled = true;
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
  }
  await reader.cancel();
  assert.ok(sawStalled, 'the derived stall must be pushed without any new event');

  writeFileSync(configFile, JSON.stringify(config, null, 2));
  await monitor.close();
  monitor = startMonitor({ projectRoot: project, port: 4901, pollMs: 200 });
});

step('19. a stopped runtime never reports SEMANTIC_LAG', () => {
  const stateFile = join(project, '.ai-workflow', 'runs', state().runId, 'state.json');
  const patch = (claude) => {
    const current = JSON.parse(readFileSync(stateFile, 'utf8'));
    current.lastSemanticAt = new Date(Date.now() - 3_600_000).toISOString();
    current.lastRuntimeAt = new Date().toISOString();
    current.lastActivityAt = current.lastRuntimeAt;
    current.runtime = { ...current.runtime, claude, lastEventAt: current.lastRuntimeAt };
    writeFileSync(stateFile, JSON.stringify(current, null, 2));
    return JSON.parse(run(cwBin, ['--project', project, 'status', '--json']).stdout).derivedSemantic;
  };

  for (const claude of ['IDLE', 'STOPPED', 'FAILED', 'UNKNOWN']) {
    assert.equal(patch(claude), 'OK', `${claude} is not "working without reporting"`);
  }
  for (const claude of ['ACTIVE', 'TOOL_RUNNING', 'SUBAGENT_RUNNING']) {
    assert.equal(patch(claude), 'SEMANTIC_LAG', `${claude} with a frozen diagram is real lag`);
  }
  patch('ACTIVE');
  // Restore a sane activity clock so later steps are not reported as stalled.
  cw('note', 'resuming');
});

// --- 3b. failure modes -----------------------------------------------------

step('the bug workflow needs both gates before any edit', () => {
  // A bug-fix run is active from the SSE step.
  assert.equal(state().workflow, 'bug-fix');
  const noGates = hookDecision({
    hook_event_name: 'PreToolUse',
    session_id: 'bug',
    tool_name: 'Write',
    tool_input: { file_path: 'src/orders.js' },
  });
  assert.equal(noGates.decision, 'deny');
  assert.match(noGates.reason, /ROOT_CAUSE_READY/);

  cw('phase', 'enter', 'root-cause');
  writeArtifact('root-cause.md');
  cw('gate', 'pass', 'ROOT_CAUSE_READY');

  const stillDenied = hookDecision({
    hook_event_name: 'PreToolUse',
    session_id: 'bug',
    tool_name: 'Write',
    tool_input: { file_path: 'src/orders.js' },
  });
  assert.equal(stillDenied.decision, 'deny', 'root cause alone does not authorise a fix');
  assert.match(stillDenied.reason, /BUSINESS_READY/);
});

step('15/16. corrupt state is CORRUPT everywhere and blocks a replacement run', () => {
  const runId = state().runId;
  const stateFile = join(project, '.ai-workflow', 'runs', runId, 'state.json');
  const good = readFileSync(stateFile, 'utf8');

  // Both flavours: unparseable, and parseable-but-not-a-run.
  const corruptions = [
    '{ "runId": broken',
    JSON.stringify({ runId, workflow: 'bug-fix', status: 'RUNNING', currentNode: 'root-cause' }),
    JSON.stringify({ ...JSON.parse(good), status: 'ALMOST_DONE' }),
    JSON.stringify({ ...JSON.parse(good), nodes: [] }),
  ];
  for (const corruption of corruptions) {
    writeFileSync(stateFile, corruption);

    const status = run(cwBin, ['--project', project, 'status'], { allowFailure: true });
    assert.equal(status.status, 2, `status must exit 2, not 0: ${corruption.slice(0, 40)}`);
    assert.match(status.stderr, /CORRUPT/);
    assert.doesNotMatch(status.stdout, /no active run/);

    const list = run(cwBin, ['--project', project, 'run', 'list'], { allowFailure: true });
    assert.equal(list.status, 1, 'run list reports it as unreadable');

    const doctorOut = run(kitBin, ['doctor', '--project', project, '--json'], { allowFailure: true });
    const runsCheck = JSON.parse(doctorOut.stdout).find((c) => c.name === 'runs');
    assert.equal(runsCheck.status, 'fail', 'doctor agrees');
    assert.match(runsCheck.detail, /CORRUPT/);

    // A new run must not quietly replace the broken one.
    const blocked = run(cwBin, ['--project', project, 'run', 'start', 'feature-change'], {
      allowFailure: true,
    });
    assert.equal(blocked.status, 1, 'a new run must not orphan an unreadable one');
    assert.match(blocked.stderr, /CORRUPT|unreadable/);
    assert.match(blocked.stderr, /quarantine-current/);

    // A broken kit still must not block the user's editor.
    const decision = hookDecision({ hook_event_name: 'PreToolUse', session_id: 'bug', tool_name: 'Edit' });
    assert.equal(decision.decision, 'allow');
  }

  writeFileSync(stateFile, good);
  assert.equal(run(cwBin, ['--project', project, 'status']).status, 0, 'recovered');
});

step('quarantine retires an unreadable run without destroying the evidence', () => {
  const runId = state().runId;
  const runDir = join(project, '.ai-workflow', 'runs', runId);
  const stateFile = join(runDir, 'state.json');
  const good = readFileSync(stateFile, 'utf8');
  writeFileSync(stateFile, '{ "runId": broken');

  const needsReason = run(cwBin, ['--project', project, 'run', 'quarantine-current'], {
    allowFailure: true,
  });
  assert.equal(needsReason.status, 1, 'quarantine is deliberate: it needs a reason');

  const out = cw('run', 'quarantine-current', '--reason', 'corrupt state during e2e');
  assert.match(out.stdout, new RegExp(`quarantined ${runId}`));
  assert.equal(readFileSync(stateFile, 'utf8'), '{ "runId": broken', 'the corrupt file is preserved');
  assert.ok(existsSync(join(runDir, 'root-cause.md')), 'so is the evidence');
  assert.ok(existsSync(join(runDir, 'QUARANTINED')));
  assert.ok(!existsSync(join(project, '.ai-workflow', 'current-run')));

  const audit = readFileSync(join(project, '.ai-workflow', 'quarantine.jsonl'), 'utf8').trim();
  assert.match(audit, /corrupt state during e2e/);

  // Only now does a fresh run start.
  cw('run', 'start', 'bug-fix', '--label', 'cancel button, second attempt');
  assert.equal(state().workflow, 'bug-fix');

  // The quarantined run is reported as retired, not as an open failure.
  const checks = JSON.parse(run(kitBin, ['doctor', '--project', project, '--json'], { allowFailure: true }).stdout);
  const runsCheck = checks.find((c) => c.name === 'runs');
  assert.notEqual(runsCheck.status, 'fail');
  assert.match(runsCheck.detail, /quarantined/);

  // Restore the file so the artifacts remain inspectable; it stays quarantined.
  writeFileSync(stateFile, good);
});

step('20. a FAILED run leaves no live node in the diagram', async () => {
  const runId = state().runId;
  cw('phase', 'enter', 'root-cause');
  writeArtifact('root-cause.md');
  cw('gate', 'pass', 'ROOT_CAUSE_READY');
  cw('phase', 'enter', 'business');
  writeArtifact('business-decision.md');
  cw('gate', 'wait', 'BUSINESS_READY', '--message', 'is the old behaviour intended?');
  assert.equal(state().status, 'WAITING_USER');

  cw('run', 'fail', '--message', 'user cannot answer; parking the defect');
  const failed = JSON.parse(
    readFileSync(join(project, '.ai-workflow', 'runs', runId, 'state.json'), 'utf8'),
  );
  assert.equal(failed.status, 'FAILED');
  const live = Object.entries(failed.nodes).filter(
    ([, n]) => n.status === 'ACTIVE' || n.status === 'WAITING_USER',
  );
  assert.deepEqual(live, [], 'nothing may still look live under a FAILED header');
  assert.equal(failed.nodes[failed.currentNode].status, 'FAILED');

  const snapshot = await fetch(`${monitor.url}/api/state`).then((r) => r.json());
  const view = snapshot.runs.find((r) => r.runId === runId);
  assert.equal(view.derivedStatus, 'FAILED');
  assert.equal(view.derivedSemantic, 'OK', 'a failed run does not also report lag');
});

step('the workflow keeps running with the monitor stopped', async () => {
  const url = monitor.url;
  await monitor.close();
  monitor = undefined;
  await assert.rejects(fetch(`${url}/api/health`), 'monitor is really down');

  cw('run', 'start', 'bug-fix', '--label', 'gate enforcement without a monitor');
  cw('phase', 'enter', 'root-cause');
  writeArtifact('root-cause.md');
  cw('gate', 'pass', 'ROOT_CAUSE_READY');

  const stillDenied = hookDecision({
    hook_event_name: 'PreToolUse',
    session_id: 'bug2',
    tool_name: 'Edit',
    tool_input: { file_path: 'src/orders.js' },
  });
  assert.equal(stillDenied.decision, 'deny', 'the gate does not need the monitor to hold');

  cw('phase', 'enter', 'business');
  writeArtifact('business-decision.md');
  cw('gate', 'pass', 'BUSINESS_READY');
  assert.equal(state().gates.BUSINESS_READY, 'PASSED');

  const allowed = hookDecision({
    hook_event_name: 'PreToolUse',
    session_id: 'bug2',
    tool_name: 'Edit',
    tool_input: { file_path: 'src/orders.js' },
  });
  assert.equal(allowed.decision, 'allow', 'gate enforcement does not depend on the monitor');
  cw('run', 'abandon', '--message', 'e2e cleanup');
  assert.ok(!existsSync(join(project, '.ai-workflow', 'current-run')));
});

step('10. CW_STRICT=0 relaxes transitions and nothing else', () => {
  cw('run', 'start', 'feature-change', '--label', 'strict-mode probe');
  const env = { ...process.env, CW_STRICT: '0' };

  const gate = run(cwBin, ['--project', project, 'gate', 'pass', 'BUSINESS_READY'], {
    allowFailure: true,
    env,
  });
  assert.equal(gate.status, 1, 'CW_STRICT must never pass a gate');
  assert.equal(state().gates.BUSINESS_READY, 'OPEN');

  const complete = run(cwBin, ['--project', project, 'run', 'complete'], { allowFailure: true, env });
  assert.equal(complete.status, 1, 'CW_STRICT must never complete a run');
  assert.notEqual(state().status, 'COMPLETED');

  // A repository write is still denied while the gate is open.
  assert.equal(
    hookDecision({
      hook_event_name: 'PreToolUse',
      session_id: 'strict',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/orders.js' },
    }).decision,
    'deny',
  );

  // What it does relax: an illegal transition, recorded as forced.
  const forced = run(cwBin, ['--project', project, 'phase', 'enter', 'implementation'], { env });
  assert.equal(forced.status, 0);
  const events = readFileSync(
    join(project, '.ai-workflow', 'runs', state().runId, 'events.jsonl'),
    'utf8',
  );
  assert.match(events, /FORCED_TRANSITION/);

  // And `cw gate pass --force` no longer exists: an override is its own command.
  const noForce = run(cwBin, ['--project', project, 'gate', 'pass', 'BUSINESS_READY', '--force'], {
    allowFailure: true,
  });
  assert.equal(noForce.status, 1);
  assert.match(noForce.stderr, /cw gate override/);

  const overridden = run(
    cwBin,
    ['--project', project, 'gate', 'override', 'BUSINESS_READY', '--reason', 'decided in the standup'],
    {},
  );
  assert.equal(overridden.status, 0);
  assert.match(overridden.stderr, /OVERRIDDEN, not earned/);
  const state1 = state();
  assert.equal(state1.gates.BUSINESS_READY, 'PASSED');
  assert.equal(state1.gateProvenance.BUSINESS_READY.overrideReason, 'decided in the standup');
  assert.match(
    readFileSync(join(project, '.ai-workflow', 'runs', state1.runId, 'events.jsonl'), 'utf8'),
    /GATE_OVERRIDE/,
  );
  cw('run', 'abandon', '--message', 'strict probe done');
});

// --- 4. doctor and uninstall ----------------------------------------------

step('doctor passes on a live install', () => {
  const result = run(kitBin, ['doctor', '--project', project, '--json'], { allowFailure: true });
  const checks = JSON.parse(result.stdout);
  const failures = checks.filter((c) => c.status === 'fail');
  assert.deepEqual(failures, [], `doctor reported failures: ${JSON.stringify(failures)}`);
  assert.ok(checks.some((c) => c.name === 'semantic progress'));
  assert.ok(checks.some((c) => c.name === 'conventions'));
  assert.ok(!existsSync(join(project, '.ai-workflow', 'hook-errors.log')), 'no hook errors all run');
});

step('conventions status reports an un-bootstrapped cache', () => {
  const result = run(cwBin, ['--project', project, 'conventions', 'status', '--json']);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.refreshNeeded, ['code', 'comments', 'testing', 'database']);
  assert.equal(report.areas.length, 4);
});

step('the gate cannot be escaped by retiring the run', () => {
  cw('run', 'start', 'feature-change', '--label', 'gate escape probe');
  assert.equal(state().gates.BUSINESS_READY, 'OPEN');

  // Abandoning a gated run is legitimate (the task is withdrawn) but it is the
  // one way past the gate, so it is refused as a bare command.
  const bare = run(cwBin, ['--project', project, 'run', 'abandon'], { allowFailure: true });
  assert.equal(bare.status, 1, 'a silent gate escape is refused');
  assert.match(bare.stderr, /needs a stated reason/);
  assert.equal(state().gates.BUSINESS_READY, 'OPEN');

  // Nor by superseding it with a gateless run.
  const superseded = run(
    cwBin,
    ['--project', project, 'run', 'start', 'generic', '--force'],
    { allowFailure: true },
  );
  assert.equal(superseded.status, 1, 'a gateless run must not be a way out of a gate');
  assert.match(superseded.stderr, /still behind unpassed gate/);
  assert.equal(
    hookDecision({
      hook_event_name: 'PreToolUse',
      session_id: 'escape',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/orders.js' },
    }).decision,
    'deny',
    'and the gate still holds',
  );

  // With a reason it goes through, and the escape is on the record.
  const runId = state().runId;
  cw('run', 'abandon', '--message', 'requirement withdrawn by the user');
  const events = readFileSync(join(project, '.ai-workflow', 'runs', runId, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const abandoned = events.find((e) => e.type === 'RUN_ABANDONED');
  assert.match(abandoned.message, /requirement withdrawn by the user/);
  assert.match(abandoned.message, /unpassed gate\(s\): BUSINESS_READY/);
  assert.deepEqual(abandoned.data.unpassedGates, ['BUSINESS_READY']);
});

step('22. a policy hook failure is visibly DEGRADED, never a silent allow', () => {
  const configFile = join(project, '.ai-workflow', 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, runtimeUrl: undefined }, null, 2));

  cw('run', 'start', 'feature-change', '--label', 'degraded probe');
  // The hook cannot load the runtime, so it fails open — which is correct, and
  // which is exactly why it has to say so out loud.
  const decision = hookDecision({
    hook_event_name: 'PreToolUse',
    session_id: 'degraded',
    tool_name: 'Edit',
    tool_input: { file_path: join(project, 'src', 'orders.js') },
  });
  assert.equal(decision.decision, 'allow', 'a broken kit must not block the user');

  const health = JSON.parse(readFileSync(join(project, '.ai-workflow', 'policy-health.json'), 'utf8'));
  assert.equal(health.status, 'DEGRADED');
  assert.ok(health.lastError.includes('runtimeUrl'));

  const checks = JSON.parse(run(kitBin, ['doctor', '--project', project, '--json'], { allowFailure: true }).stdout);
  const policy = checks.find((c) => c.name === 'gate policy');
  assert.equal(policy.status, 'fail');
  assert.match(policy.detail, /DEGRADED/);
  assert.match(run(cwBin, ['--project', project, 'status']).stdout, /policy\s+DEGRADED/);

  // The monitor says it too.
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  hookDecision({ hook_event_name: 'PreToolUse', session_id: 'degraded', tool_name: 'Read' });
  const recovered = JSON.parse(readFileSync(join(project, '.ai-workflow', 'policy-health.json'), 'utf8'));
  assert.equal(recovered.status, 'OK', 'a working policy reports OK again');
  cw('run', 'abandon', '--message', 'degraded probe done');
  rmSync(join(project, '.ai-workflow', 'hook-errors.log'), { force: true });
});

step('17. a project installed with --runtime <dir> enforces its gates too', async () => {
  const custom = mkdtempSync(join(tmpdir(), 'cwk-e2e-runtime-'));
  try {
    cpSync(demoSource, custom, { recursive: true });
    run(kitBin, ['init', '--project', custom, '--runtime', '.wf'], { cwd: custom });

    assert.ok(existsSync(join(custom, '.wf', 'config.json')));
    assert.ok(!existsSync(join(custom, '.ai-workflow')), 'the default directory is not created');
    assert.equal(readFileSync(join(custom, '.claude', 'cw-runtime'), 'utf8').trim(), '.wf');

    // The CLI finds it with no --runtime flag at all.
    const started = run(cwBin, ['--project', custom, 'run', 'start', 'feature-change'], { cwd: custom });
    assert.equal(started.status, 0);
    assert.ok(existsSync(join(custom, '.wf', 'current-run')));

    // And so does the hook, which gets nothing but CLAUDE_PROJECT_DIR.
    const hookOut = run(join(custom, '.claude', 'hooks', 'cw-hook.mjs'), [], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'custom',
        tool_name: 'Edit',
        tool_input: { file_path: join(custom, 'src', 'orders.js') },
      }),
      cwd: tmpdir(),
      env: { ...process.env, CLAUDE_PROJECT_DIR: custom },
    });
    const parsed = JSON.parse(hookOut.stdout.trim());
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /BUSINESS_READY/);

    // Runtime telemetry lands in the custom directory, and doctor is clean.
    run(join(custom, '.claude', 'hooks', 'cw-hook.mjs'), [], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'custom', tool_name: 'Grep' }),
      cwd: tmpdir(),
      env: { ...process.env, CLAUDE_PROJECT_DIR: custom },
    });
    const runId = readFileSync(join(custom, '.wf', 'current-run'), 'utf8').trim();
    const customState = JSON.parse(readFileSync(join(custom, '.wf', 'runs', runId, 'state.json'), 'utf8'));
    assert.equal(customState.runtime.tool, 'Grep');
    assert.ok(!existsSync(join(custom, '.wf', 'hook-errors.log')), 'no hook errors');

    const checks = JSON.parse(
      run(kitBin, ['doctor', '--project', custom, '--json'], { allowFailure: true, cwd: custom }).stdout,
    );
    assert.deepEqual(
      checks.filter((c) => c.status === 'fail'),
      [],
      `doctor failed on a custom runtime dir: ${JSON.stringify(checks.filter((c) => c.status === 'fail'))}`,
    );
    assert.equal(checks.find((c) => c.name === 'gate policy')?.status, 'ok');

    // The monitor reads the same directory with no flags.
    const { startMonitor } = await import(
      pathToFileURL(join(repoRoot, 'packages', 'monitor-server', 'dist', 'index.js')).href
    );
    const customMonitor = startMonitor({ projectRoot: custom, port: 4902, pollMs: 200 });
    try {
      const snapshot = await fetch('http://127.0.0.1:4902/api/state').then((r) => r.json());
      assert.equal(snapshot.runtimeDir, join(custom, '.wf'));
      assert.equal(snapshot.runs.length, 1);
      assert.equal(snapshot.policyHealth.status, 'OK');
    } finally {
      await customMonitor.close();
    }
  } finally {
    rmSync(custom, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// --- quick-fix: the short workflow ----------------------------------------

step('quick-fix is installed and stays short', () => {
  for (const skill of ['quick-fix', 'wf-quick-fix']) {
    assert.ok(
      existsSync(join(project, '.claude', 'skills', skill, 'SKILL.md')),
      `${skill} must be installed`,
    );
  }
  assert.match(cw('workflows').stdout, /quick-fix/);

  // Superseding whatever the previous steps left behind is deliberate here.
  cw('run', 'start', 'quick-fix', '--force', '--reason', 'e2e quick-fix probe', '--label', 'small fix');
  const opened = state();
  assert.equal(opened.workflow, 'quick-fix');
  assert.deepEqual(opened.gates, {}, 'quick-fix must carry no gates');

  // The point of the short workflow: no gate to earn, so source edits are allowed.
  assert.equal(
    hookDecision({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'Edit',
      tool_input: { file_path: join(project, 'src', 'orders.js') },
    }).decision,
    'allow',
    'a quick fix must not be blocked by a gate it does not have',
  );

  for (const phase of ['triage', 'fix', 'validate']) {
    cw('phase', 'enter', phase);
    cw('phase', 'complete');
  }
  cw('run', 'complete');

  const finished = JSON.parse(
    cw('run', 'show', '--run', opened.runId, '--json').stdout,
  );
  assert.equal(finished.status, 'COMPLETED');
  assert.equal(finished.currentNode, 'done');
  assert.deepEqual(finished.artifacts, [], 'no evidence artifacts are required');
});

step('standard-change is installed as the gate-free L2 path', () => {
  assert.match(cw('workflows').stdout, /standard-change/);
  cw('run', 'start', 'standard-change', '--force', '--reason', 'e2e L2 topology probe', '--label', 'medium change');
  const opened = state();
  assert.equal(opened.workflow, 'standard-change');
  assert.deepEqual(opened.gates, {});
  for (const phase of ['impact', 'implementation', 'validation']) {
    cw('phase', 'enter', phase);
    cw('phase', 'complete');
  }
  cw('run', 'complete');
});

step('uninstall leaves the project clean', () => {
  run(kitBin, ['uninstall', '--project', project]);
  assert.ok(!existsSync(join(project, '.claude', 'skills', 'feature-change', 'SKILL.md')));
  const claudeMd = readFileSync(join(project, 'CLAUDE.md'), 'utf8');
  assert.ok(claudeMd.includes('This line exists to prove the installer merges'));
  assert.ok(!claudeMd.includes('CW:START'));
});

// --- driver ----------------------------------------------------------------

for (const [name, fn] of steps) {
  try {
    await fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failed = true;
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
    break;
  }
}

if (monitor) await monitor.close();
rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

process.stdout.write(failed ? '\nE2E FAILED\n' : '\nE2E PASSED\n');
process.exit(failed ? 1 : 0);
