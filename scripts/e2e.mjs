#!/usr/bin/env node
// End-to-end verification: install the kit into a copy of the demo project,
// drive a full feature-change run through the `cw` CLI and the hook script,
// and confirm the monitor server reports what actually happened.
//
// Run with: npm run e2e

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
let app;
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

  assert.ok(existsSync(join(project, '.claude', 'skills', 'root-cause-analysis', 'SKILL.md')));
  assert.ok(existsSync(join(project, '.claude', 'skills', 'deep-change', 'SKILL.md')));
  assert.ok(existsSync(join(project, '.claude', 'hooks', 'cw-hook.mjs')));
  assert.ok(existsSync(join(project, '.ai-workflow', 'config.json')));

  // Capabilities load when a task needs them; output contracts only when the
  // user asks for a document. Both layers have to be on disk for that to work.
  for (const skill of ['sql-compare', 'schema-migration', 'api-contract-review', 'map-repo']) {
    assert.ok(existsSync(join(project, '.claude', 'skills', skill, 'SKILL.md')), `${skill} installed`);
  }
  for (const prompt of [
    'README.md',
    'change-report.prompt.md',
    'bug-report.prompt.md',
    'parity-report.prompt.md',
    'migration-plan.prompt.md',
    'business-summary.prompt.md',
    'decision-record.prompt.md',
  ]) {
    assert.ok(
      existsSync(join(project, '.claude', 'prompts', prompt)),
      `output contract ${prompt} installed`,
    );
  }
  assert.ok(existsSync(join(project, '.claude', 'instructions', 'README.md')));

  const claudeMd = readFileSync(join(project, 'CLAUDE.md'), 'utf8');
  assert.ok(claudeMd.includes('### Escalation triggers'), 'the capability router is in the managed block');
  assert.ok(claudeMd.includes('### Depth is chosen by three facts'), 'depth model injected');
  assert.ok(claudeMd.includes('This line exists to prove the installer merges'), 'user content survived');

  // The default path must stay native: no classification step, no mandatory run.
  assert.ok(!claudeMd.includes('Mission Header'), 'ordinary work opens no ceremony');
  assert.ok(!claudeMd.includes('caveman'), 'no dependency on an external compression plugin');
  assert.ok(claudeMd.includes('Do not narrate reading, searching, editing'), 'built-in policy present');

  // Capabilities have to be auto-loadable, or the escalation table is decorative.
  const capability = readFileSync(
    join(project, '.claude', 'skills', 'root-cause-analysis', 'SKILL.md'),
    'utf8',
  );
  assert.ok(!capability.includes('disable-model-invocation'), 'a capability loads when it is needed');
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

/**
 * A cancelled SSE stream leaves a dead socket in undici's keep-alive pool, so
 * the next request to the same origin can be reset once. That is a client-side
 * artefact of this script, not a server behaviour — retry once and move on.
 */
async function getJson(url) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url).then((r) => r.json());
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
}

step('23. tool calls become redacted telemetry, folded and served over the API', async () => {
  // The bug-fix run opened by the SSE step is live, so the hook records against
  // it. A terminal run records nothing, by design.
  const runId = state().runId;
  const secret = 'postgres://admin:hunter2@db.internal/prod';

  const both = (payload) => {
    hook({ hook_event_name: 'PreToolUse', session_id: 's1', ...payload });
    hook({ hook_event_name: 'PostToolUse', session_id: 's1', ...payload });
  };
  both({ tool_name: 'Read', tool_input: { file_path: join(project, 'src', 'orders.js') } });
  both({ tool_name: 'Write', tool_input: { file_path: 'src/orders.js', content: 'API_KEY=sk-live-nope' } });
  both({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
  both({ tool_name: 'Bash', tool_input: { command: `psql "${secret}" -c "select 1"` } });

  const log = readFileSync(join(project, '.ai-workflow', 'runs', runId, 'events.jsonl'), 'utf8');
  const types = log
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).type);
  assert.ok(types.includes('FILE_READ'), 'a read is a fact worth keeping');
  assert.ok(types.includes('FILE_CHANGED'), 'a write is recorded when it happened');
  assert.ok(types.includes('TEST_STARTED') && types.includes('TEST_PASSED'), 'a test command is a test event');
  // `psql` is denied by the open gate, so it never starts — and telemetry must
  // not claim it did. The completion event comes from the PostToolUse call.
  assert.ok(types.includes('COMMAND_COMPLETED'), 'commands that ran are recorded as commands');

  // The redaction boundary: normalised facts only. Nothing else may reach disk.
  assert.ok(!log.includes('hunter2'), 'a credential in a command argument must never be persisted');
  assert.ok(!log.includes(secret), 'the full command line must never be persisted');
  assert.ok(!log.includes('sk-live-nope'), 'file content must never be persisted');
  assert.ok(log.includes('"executable":"psql"'), 'the program name is what is kept');
  assert.ok(log.includes('"path":"src/orders.js"'), 'paths are project-relative');

  // Folded counts, from the CLI and over HTTP.
  const rollup = JSON.parse(cw('rollup', '--run', runId, '--json').stdout);
  assert.ok(rollup.files.read >= 1 && rollup.files.changed >= 1);
  assert.ok(rollup.tests.commandsStarted >= 1);
  assert.equal(rollup.tests.cases.available, false, 'test cases are not parsed, so they stay unavailable');
  assert.equal(rollup.usage.available, false, 'no transcript in the sandbox means N/A, never 0');
  assert.equal(rollup.usage.totalTokens, null);
  assert.ok(rollup.steps[state().currentNode], 'work is attributed to the phase it happened in');

  // History comes from the index, paged, without loading full run states.
  const page = await getJson('http://127.0.0.1:4899/api/runs?limit=1');
  assert.equal(page.runs.length, 1);
  assert.ok(page.total >= 2, `expected both runs in the index, got ${page.total}`);
  const filtered = await getJson('http://127.0.0.1:4899/api/runs?status=COMPLETED');
  assert.ok(filtered.runs.every((r) => r.status === 'COMPLETED'));

  const first = await getJson(`http://127.0.0.1:4899/api/runs/${runId}/events?after=0&limit=3`);
  assert.equal(first.events.length, 3);
  assert.ok(first.cursor > 0 && first.hasMore, 'a cursor walks forward through the log');
  const second = await getJson(`http://127.0.0.1:4899/api/runs/${runId}/events?after=${first.cursor}&limit=3`);
  assert.notDeepEqual(second.events[0], first.events[0], 'the next page is the next events');

  const analytics = await getJson('http://127.0.0.1:4899/api/analytics');
  assert.ok(analytics.totalRuns >= 2);
  assert.equal(analytics.usage.available, false);
  assert.equal(analytics.usage.totalTokens, null, 'unmeasured usage is null, never 0');
  assert.ok(analytics.workflows.some((w) => w.workflow === 'feature-change'));

  // Derived data is disposable: delete the index and rebuild it from the runs.
  const indexFile = join(project, '.ai-workflow', 'index', 'runs.jsonl');
  assert.ok(existsSync(indexFile));
  const before = readFileSync(indexFile, 'utf8').split('\n').filter(Boolean).length;
  rmSync(indexFile);
  cw('index', 'rebuild');
  const after = readFileSync(indexFile, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after, before, 'the index rebuilds identically from state.json');

  // Usage has no source inside the sandbox, and says so instead of inventing one.
  const usageOut = cw('usage', 'sync', '--run', runId).stdout;
  assert.match(usageOut, /usage unavailable|tokens/);
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
  assert.ok(checks.some((c) => c.name === 'repository instructions'));
  assert.ok(!existsSync(join(project, '.ai-workflow', 'hook-errors.log')), 'no hook errors all run');
});

step('instructions status reports an unmapped repository without inventing areas', () => {
  const result = run(cwBin, ['--project', project, 'instructions', 'status', '--json']);
  const report = JSON.parse(result.stdout);
  // A repository nobody has mapped has no areas — not four failing ones.
  assert.deepEqual(report.areas, []);
  assert.deepEqual(report.refreshNeeded, []);

  // The pre-0.2 command name still answers, so an installed project is not broken.
  const legacy = run(cwBin, ['--project', project, 'conventions', 'status', '--json']);
  assert.deepEqual(JSON.parse(legacy.stdout).areas, []);
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

step('quick-fix stays short and carries no gate', () => {
  // The preset no longer drives this topology — ordinary work runs natively —
  // but it stays available to projects that opt into it explicitly.
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

// --- deep-change: the one gated path --------------------------------------

step('deep-change holds every edit behind one decision, then releases it', () => {
  assert.match(cw('workflows').stdout, /deep-change/);
  cw('run', 'start', 'deep-change', '--force', '--reason', 'e2e gated path probe', '--label', 'drop legacy column');
  const opened = state();
  assert.equal(opened.workflow, 'deep-change');
  assert.equal(opened.gates.DECISION_READY, 'OPEN');

  const sourceEdit = {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_name: 'Edit',
    tool_input: { file_path: join(project, 'src', 'orders.js') },
  };
  assert.equal(hookDecision(sourceEdit).decision, 'deny', 'an irreversible change waits for its decision');

  cw('phase', 'enter', 'investigate');
  cw('phase', 'complete');
  cw('phase', 'enter', 'decide');

  // The gate's own evidence stays writable behind it — that is how it is earned.
  const decisionFile = join(project, '.ai-workflow', 'runs', opened.runId, 'decision.md');
  assert.equal(
    hookDecision({ ...sourceEdit, tool_name: 'Write', tool_input: { file_path: decisionFile } }).decision,
    'allow',
    'the decision record is the way through the gate',
  );
  writeArtifact('decision.md', '# Decision\n\nExpand/contract; drop deferred to the next release.\n');
  cw('artifact', 'decision.md');
  cw('gate', 'pass', 'DECISION_READY');

  assert.equal(hookDecision(sourceEdit).decision, 'allow', 'a decided change may be implemented');

  for (const phase of ['implement', 'verify']) {
    cw('phase', 'enter', phase);
    cw('phase', 'complete');
  }
  cw('phase', 'enter', 'review');
  writeArtifact('review.md', '# Review\n\nPASS\n');
  cw('artifact', 'review.md');
  cw('phase', 'complete');
  cw('run', 'complete');

  const finished = JSON.parse(cw('run', 'show', '--run', opened.runId, '--json').stdout);
  assert.equal(finished.status, 'COMPLETED');
  assert.equal(finished.currentNode, 'done');
});

// --- mission control (V2) -------------------------------------------------

step('a classified mission routes, checkpoints and blocks the editor', () => {
  cw('run', 'start', 'standard-change', '--force', '--reason', 'e2e mission probe', '--label', 'tenant export filter');

  // Routing: an API contract change floors at Standard and owes PLAN + DESIGN.
  const classified = cw(
    'mission',
    'classify',
    '--type',
    'api-change',
    '--complexity',
    'medium',
    '--flags',
    'api-contract-change',
  ).stdout;
  assert.match(classified, /workflow\s+STANDARD \(standard-change\)/);
  assert.match(classified, /checkpoints PLAN, DESIGN/);
  assert.match(classified, /template\s+change-report\.prompt\.md/);
  assert.equal(state().mission.state, 'PLANNING');

  cw(
    'mission',
    'plan',
    '--objective',
    'filter exports by tenant',
    '--scope',
    'export service,api',
    '--out-of-scope',
    'no schema change',
  );

  // A required checkpoint that was never opened denies repository writes, even
  // though this topology has no hard gate at all.
  const denied = hookDecision({
    hook_event_name: 'PreToolUse',
    session_id: 'mission',
    tool_name: 'Edit',
    tool_input: { file_path: join(project, 'src', 'orders.js') },
  });
  assert.equal(denied.decision, 'deny', 'a mission checkpoint must have the same teeth as a gate');
  assert.match(denied.reason, /required PLAN checkpoint was never opened/);
  assert.match(denied.reason, /cw board/);

  // Read-only work and `cw` itself stay available while the user is asked.
  assert.equal(
    hookDecision({
      hook_event_name: 'PreToolUse',
      session_id: 'mission',
      tool_name: 'Bash',
      tool_input: { command: 'git diff && cw board' },
    }).decision,
    'allow',
  );

  cw('checkpoint', 'open', 'PLAN', '--summary', 'scope of the export change', '--decision', 'approve the scope');
  cw('checkpoint', 'open', 'DESIGN', '--summary', 'two contracts', '--decision', 'rename or keep the legacy field');
  assert.equal(state().mission.checkpoints.length, 2);
  assert.equal(state().mission.state, 'WAITING_DESIGN_APPROVAL');

  const board = cw('board').stdout;
  assert.match(board, /CHECKPOINT CP-001 \[PLAN\] — decision required/);
  assert.match(board, /IMPLEMENTATION BLOCKED/);
  assert.match(cw('status').stdout, /waiting\s+checkpoint CP-001/);
});

step('the Mission Board answers a checkpoint over HTTP, and only same-origin', async () => {
  const { startMonitor } = await import(
    pathToFileURL(join(repoRoot, 'packages', 'monitor-server', 'dist', 'index.js')).href
  );
  const boardMonitor = startMonitor({ projectRoot: project, port: 4903, pollMs: 200 });
  try {
    const runId = state().runId;
    const snapshot = await fetch('http://127.0.0.1:4903/api/state').then((r) => r.json());
    const view = snapshot.runs.find((r) => r.runId === runId);
    assert.equal(view.missionSummary.state, 'WAITING_DESIGN_APPROVAL');
    assert.equal(view.missionSummary.pendingCheckpoints, 2);
    assert.equal(view.missionSummary.health, 'BLOCKED');

    const detail = await fetch(`http://127.0.0.1:4903/api/runs/${runId}`).then((r) => r.json());
    assert.equal(detail.board.pendingCheckpoints.length, 2);
    assert.equal(detail.board.readiness.ok, false);

    // Any page the user has open could POST to localhost, so a cross-origin
    // write is refused before it can approve anything on their behalf.
    const foreign = await fetch(`http://127.0.0.1:4903/api/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ action: 'checkpoint.approve', checkpointId: 'CP-001' }),
    });
    assert.equal(foreign.status, 403, 'cross-origin board actions must be refused');
    assert.equal(state().mission.checkpoints[0].status, 'PENDING');

    // Rejecting without a note is refused with the reason, not silently ignored.
    const noNote = await fetch(`http://127.0.0.1:4903/api/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4903' },
      body: JSON.stringify({ action: 'checkpoint.reject', checkpointId: 'CP-001' }),
    });
    assert.equal(noNote.status, 400);
    assert.match((await noNote.json()).error, /note/);

    for (const id of ['CP-001', 'CP-002']) {
      const res = await fetch(`http://127.0.0.1:4903/api/runs/${runId}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4903' },
        body: JSON.stringify({ action: 'checkpoint.approve', checkpointId: id, note: 'approved in review' }),
      });
      assert.equal(res.status, 200, `approving ${id} over HTTP`);
    }
    const answered = state();
    assert.deepEqual(
      answered.mission.checkpoints.map((c) => c.status),
      ['APPROVED', 'APPROVED'],
    );
    assert.equal(answered.mission.checkpoints[0].respondedVia, 'board');
    assert.equal(answered.mission.state, 'READY_TO_IMPLEMENT');

    // Pausing from the board stops the repository again.
    await fetch(`http://127.0.0.1:4903/api/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4903' },
      body: JSON.stringify({ action: 'mission.pause', reason: 'lunch' }),
    });
    const paused = hookDecision({
      hook_event_name: 'PreToolUse',
      session_id: 'mission',
      tool_name: 'Edit',
      tool_input: { file_path: join(project, 'src', 'orders.js') },
    });
    assert.equal(paused.decision, 'deny');
    assert.match(paused.reason, /mission is PAUSED: lunch/);

    await fetch(`http://127.0.0.1:4903/api/runs/${runId}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4903' },
      body: JSON.stringify({ action: 'mission.resume' }),
    });
    assert.equal(state().mission.state, 'READY_TO_IMPLEMENT');
  } finally {
    await boardMonitor.close();
  }
});

step('confidence thresholds gate the implementation phase, and are auditable', () => {
  cw('phase', 'enter', 'impact');
  const refused = run(cwBin, ['--project', project, 'phase', 'enter', 'implementation'], {
    allowFailure: true,
  });
  assert.equal(refused.status, 1, 'implementation without assessed confidence is refused');
  assert.match(refused.stderr, /confidence requirement has not been assessed/);
  assert.match(refused.stderr, /cw mission accept-risk/);

  for (const dimension of ['requirement', 'scope', 'businessRule', 'design', 'implementation']) {
    cw('mission', 'confidence', dimension, '88');
  }
  cw('phase', 'enter', 'implementation');
  assert.equal(state().currentNode, 'implementation');
  assert.equal(state().mission.state, 'IMPLEMENTING');
  assert.equal(
    hookDecision({
      hook_event_name: 'PreToolUse',
      session_id: 'mission',
      tool_name: 'Edit',
      tool_input: { file_path: join(project, 'src', 'orders.js') },
    }).decision,
    'allow',
    'an approved, confident mission may finally edit source',
  );

  // Deliverables are part of "done", so a missing required one blocks completion.
  cw('mission', 'deliverable', 'Manual test checklist', '--reason', 'UI verification is manual');
  cw('phase', 'complete');
  cw('phase', 'enter', 'validation');
  cw('phase', 'complete');
  const premature = run(cwBin, ['--project', project, 'run', 'complete'], { allowFailure: true });
  assert.equal(premature.status, 1);
  assert.match(premature.stderr, /required deliverable "Manual test checklist" is PENDING/);

  cw('mission', 'deliverable', 'Manual test checklist', '--status', 'DONE', '--location', 'final response');
  const runId = state().runId;
  cw('run', 'complete');
  const finished = JSON.parse(cw('run', 'show', '--run', runId, '--json').stdout);
  assert.equal(finished.status, 'COMPLETED');
  assert.equal(finished.mission.state, 'COMPLETED');
  assert.ok(!existsSync(join(project, '.ai-workflow', 'current-run')));
});

// --- the app: many projects, GUI provisioning, and starting a session --------

step('the app serves the project, its config and a launched session', async () => {
  const { startApp } = await import(
    pathToFileURL(join(repoRoot, 'packages', 'installer', 'dist', 'app.js')).href
  );

  // A workspace of its own, so the developer's real registry is never touched,
  // and a stand-in for Claude Code, so the launcher is exercised without needing
  // a real session (or a real API key) in CI.
  const home = mkdtempSync(join(tmpdir(), 'cwk-e2e-home-'));
  const fake = join(home, 'fake-claude.mjs');
  const NL = String.fromCharCode(10);
  writeFileSync(
    fake,
    [
      "import { readFileSync } from 'node:fs';",
      "const NL = String.fromCharCode(10);",
      "if (process.argv.includes('--version')) { process.stdout.write('0.0.0-e2e' + NL); process.exit(0); }",
      "let prompt = '';",
      "try { prompt = readFileSync(0, 'utf8'); } catch {}",
      "process.stdout.write(JSON.stringify({ type: 'user', prompt: prompt.trim() }) + NL);",
      "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + NL);",
    ].join(NL),
    'utf8',
  );
  let bin = fake;
  if (process.platform === 'win32') {
    bin = join(home, 'fake-claude.cmd');
    writeFileSync(bin, `@node "${fake}" %*${NL}`, 'utf8');
  } else {
    chmodSync(fake, 0o755);
  }
  process.env.CW_HOME = home;
  process.env.CW_CLAUDE_BIN = bin;

  app = startApp({ port: 0, workspaceFile: join(home, 'workspace.json'), add: [project] });
  await app.ready;

  const json = async (path, init) => {
    const res = await fetch(`${app.url}${path}`, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${body.error ?? ''}`);
    return body;
  };

  // The registry sees the project, and the CLI's installer is attached.
  const info = await json('/api/app');
  assert.equal(info.projects.length, 1, 'the project was registered by --add');
  assert.equal(info.capabilities.provisioning, true, 'the CLI injects install/doctor');
  assert.equal(info.capabilities.launcher, true, 'the stand-in binary is runnable');
  const projectId = info.projects[0].id;
  assert.equal(info.projects[0].installed, true);
  assert.ok(info.projects[0].totalRuns > 0, 'the runs from earlier steps are visible');

  // The same runtime routes the monitor serves, under the project prefix.
  const snapshot = await json(`/api/projects/${projectId}/state`);
  assert.equal(snapshot.projectRoot, project);
  const history = await json(`/api/projects/${projectId}/runs?limit=5`);
  assert.ok(history.total > 0, 'history is answered from the index');

  // Provisioning through the app, not the terminal.
  const health = await json(`/api/projects/${projectId}/doctor`);
  assert.ok(health.checks.some((c) => c.name === 'skills' && c.status === 'ok'), 'doctor ran');

  // Config edits are whitelisted and merged, never wholesale rewrites.
  const before = JSON.parse(readFileSync(join(project, '.ai-workflow', 'config.json'), 'utf8'));
  const patched = await json(`/api/projects/${projectId}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stallThresholdSeconds: 321 }),
  });
  assert.equal(patched.config.stallThresholdSeconds, 321);
  const after = JSON.parse(readFileSync(join(project, '.ai-workflow', 'config.json'), 'utf8'));
  assert.equal(after.preset, before.preset, 'the unmanaged keys survive');
  await assert.rejects(
    json(`/api/projects/${projectId}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mutationTools: [] }),
    }),
    /not editable/,
    'gate policy cannot be widened from a browser form',
  );

  // A session started from the app: default mode cannot edit, and the prompt
  // travels over stdin rather than argv.
  await assert.rejects(
    json(`/api/projects/${projectId}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'rewrite everything', mode: 'bypassPermissions' }),
    }),
    /confirmUnsafe/,
    'an edit-capable mode must be confirmed',
  );

  const started = await json(`/api/projects/${projectId}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'explain the order module' }),
  });
  assert.equal(started.task.mode, 'plan', 'the default mode is read-only');

  const deadline = Date.now() + 20_000;
  let task = started.task;
  while (task.status === 'RUNNING' && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
    task = (await json(`/api/projects/${projectId}/tasks/${task.id}`)).task;
  }
  assert.equal(task.status, 'DONE', `the session finished (${task.error ?? ''})`);

  const output = await json(`/api/projects/${projectId}/tasks/${task.id}/output`);
  assert.match(output.text, /explain the order module/, 'the prompt reached the session over stdin');

  await app.close();
  app = undefined;
  delete process.env.CW_CLAUDE_BIN;
  delete process.env.CW_HOME;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    // `fetch failed` on its own says nothing; the cause is where the reason is.
    const cause = error.cause ? `\n       cause: ${error.cause.message ?? error.cause}` : '';
    process.stdout.write(`  FAIL ${name}\n       ${error.message}${cause}\n${error.stack ?? ''}\n`);
    break;
  }
}

if (monitor) await monitor.close();
if (app) await app.close();
rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

process.stdout.write(failed ? '\nE2E FAILED\n' : '\nE2E PASSED\n');
process.exit(failed ? 1 : 0);
