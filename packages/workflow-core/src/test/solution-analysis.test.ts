import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkflowRuntime } from '../runtime.js';
import { runCli } from '../cli.js';
import { SPEC_MAP_ARTIFACT } from '../spec.js';
import { SOLUTION_ANALYSIS_ARTIFACTS } from '../types.js';

const DESIGN_DOC = 'docs/design/detail.md';

const SPEC_MAP = `# Traceability

| ID | Requirement | Design Ref | Code Paths |
| --- | --- | --- | --- |
| SPEC-001 | The feature behavior stays reusable | ${DESIGN_DOC}#2.1 | feature.ts |
`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-analysis-'));
  const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
  runtime.ensureRuntimeDir();
  writeFileSync(join(dir, 'feature.ts'), 'export const behavior = "old";\n', 'utf8');
  mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
  writeFileSync(join(dir, DESIGN_DOC), '# Detailed design\n\n## 2.1 Behavior\n\nReusable.\n', 'utf8');
  return {
    dir,
    runtime,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

function prepareAnalysis(runtime: WorkflowRuntime) {
  const run = runtime.startRun('solution-analysis', { label: 'analyze feature' });
  runtime.enterPhase('intake');
  runtime.completePhase();
  runtime.enterPhase('analysis');
  for (const name of SOLUTION_ANALYSIS_ARTIFACTS) {
    const body = name === SPEC_MAP_ARTIFACT ? SPEC_MAP : `# ${name}\n\nEvidence.\n`;
    writeFileSync(join(runtime.paths.runDir(run.runId), name), body, 'utf8');
    runtime.artifact(name);
  }
  return run;
}

test('solution analysis stops at ANALYSIS_READY with the complete artifact contract', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = prepareAnalysis(runtime);
    const ready = runtime.markAnalysisReady({ sources: ['feature.ts'] });
    assert.equal(ready.runId, run.runId);
    assert.equal(ready.analysis?.status, 'ANALYSIS_READY');
    assert.equal(ready.status, 'WAITING_USER');
    assert.equal(ready.currentNode, 'await-approval');
    assert.equal(ready.gates['ANALYSIS_APPROVED'], 'WAITING');
    assert.deepEqual(ready.analysis?.sourceSnapshot?.map((entry) => entry.path), [
      'feature.ts',
      DESIGN_DOC,
    ]);
    assert.deepEqual(
      SOLUTION_ANALYSIS_ARTIFACTS.filter((name) => !ready.artifacts.includes(name)),
      [],
    );
  } finally {
    cleanup();
  }
});

test('analysis readiness publishes a readable copy outside the run directory', () => {
  const { dir, runtime, cleanup } = sandbox();
  try {
    const run = prepareAnalysis(runtime);
    const ready = runtime.markAnalysisReady({ sources: ['feature.ts'] });
    assert.equal(ready.analysis?.reportDir, `docs/analysis/${run.runId}-analyze-feature`);
    for (const name of SOLUTION_ANALYSIS_ARTIFACTS) {
      assert.equal(
        readFileSync(join(dir, ready.analysis!.reportDir!, name), 'utf8'),
        readFileSync(join(runtime.paths.runDir(run.runId), name), 'utf8'),
      );
    }
  } finally {
    cleanup();
  }
});

test('approved analysis hands off to feature-change without repeating analysis', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const analysis = prepareAnalysis(runtime);
    runtime.markAnalysisReady({ sources: ['feature.ts'] });
    const approved = runtime.approveAnalysis({
      approvedSolution: 'Reuse the existing feature service',
      approvedScope: 'feature.ts and its targeted tests',
    });
    assert.equal(approved.analysis?.status, 'APPROVED');
    assert.equal(approved.analysis?.approval?.analysisRunId, analysis.runId);

    const feature = runtime.handoffAnalysis();
    assert.equal(runtime.run(analysis.runId).status, 'COMPLETED');
    assert.equal(feature.workflow, 'feature-change');
    assert.equal(feature.sourceAnalysisRunId, analysis.runId);
    assert.equal(feature.currentNode, 'freshness');
    assert.equal(feature.gates['BUSINESS_READY'], 'OPEN');
    for (const node of ['evidence', 'business', 'readiness']) {
      assert.equal(feature.nodes[node]?.status, 'SKIPPED');
      assert.equal(feature.nodes[node]?.visits, 0, `${node} was not rerun`);
    }
    for (const name of SOLUTION_ANALYSIS_ARTIFACTS) {
      assert.equal(
        readFileSync(join(runtime.paths.runDir(feature.runId), name), 'utf8'),
        readFileSync(join(runtime.paths.runDir(analysis.runId), name), 'utf8'),
      );
    }

    const valid = runtime.checkAnalysisFreshness();
    assert.equal(valid.analysisHandoff?.freshness, 'VALID');
    assert.equal(valid.gates['BUSINESS_READY'], 'PASSED');
    runtime.completePhase('freshness');
    assert.equal(runtime.enterPhase('conventions').currentNode, 'conventions');
  } finally {
    cleanup();
  }
});

test('material source change marks analysis stale and blocks implementation until targeted refresh', () => {
  const { dir, runtime, cleanup } = sandbox();
  try {
    prepareAnalysis(runtime);
    runtime.markAnalysisReady({ sources: ['feature.ts'] });
    runtime.approveAnalysis({ approvedSolution: 'Reuse service', approvedScope: 'feature.ts' });
    const feature = runtime.handoffAnalysis();

    writeFileSync(join(dir, 'feature.ts'), 'export const behavior = "materially-new";\n', 'utf8');
    const stale = runtime.checkAnalysisFreshness();
    assert.equal(stale.analysisHandoff?.freshness, 'STALE');
    assert.deepEqual(stale.analysisHandoff?.stalePaths, ['feature.ts']);
    assert.equal(stale.gates['BUSINESS_READY'], 'OPEN');
    assert.throws(() => runtime.enterPhase('conventions'), /approved analysis is STALE/);
    assert.equal(runtime.run(feature.runId).currentNode, 'freshness');

    writeFileSync(
      join(runtime.paths.runDir(feature.runId), 'recommended-solution.md'),
      '# Recommended Solution\n\nRefreshed against materially-new behavior.\n',
      'utf8',
    );
    runtime.refreshAnalysisHandoff({
      sources: ['feature.ts'],
      reason: 'rechecked the affected feature flow and updated only impacted analysis sections',
    });
    const refreshed = runtime.checkAnalysisFreshness();
    assert.equal(refreshed.analysisHandoff?.freshness, 'VALID');
    assert.equal(refreshed.gates['BUSINESS_READY'], 'PASSED');
    assert.equal(
      readFileSync(join(runtime.paths.runDir(feature.runId), 'business-decision.md'), 'utf8'),
      readFileSync(join(runtime.paths.runDir(feature.runId), 'recommended-solution.md'), 'utf8'),
    );
  } finally {
    cleanup();
  }
});

test('legacy feature-change remains valid without analysis metadata', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('feature-change');
    assert.equal(run.sourceAnalysisRunId, undefined);
    assert.equal(run.analysisHandoff, undefined);
    assert.equal(runtime.enterPhase('evidence').currentNode, 'evidence');

    const stateFile = runtime.paths.stateFile(run.runId);
    const oldState = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    delete oldState['analysis'];
    delete oldState['sourceAnalysisRunId'];
    delete oldState['analysisHandoff'];
    delete oldState['artifacts'];
    delete (oldState['nodes'] as Record<string, unknown>)['freshness'];
    writeFileSync(stateFile, JSON.stringify(oldState), 'utf8');
    const loaded = runtime.run(run.runId);
    assert.deepEqual(loaded.artifacts, []);
    assert.equal(loaded.nodes['freshness']?.status, 'SKIPPED');
  } finally {
    cleanup();
  }
});

test('the public CLI drives approval, traceable handoff, and freshness', async () => {
  const { dir, runtime, cleanup } = sandbox();
  try {
    prepareAnalysis(runtime);
    const base = ['--project', dir, '--runtime', '.ai-workflow'];
    assert.equal(await runCli([...base, 'analysis', 'ready', '--source', 'feature.ts']), 0);
    assert.equal(
      await runCli([
        ...base,
        'analysis',
        'approve',
        '--solution',
        'reuse existing service',
        '--scope',
        'feature.ts and targeted tests',
      ]),
      0,
    );
    assert.equal(await runCli([...base, 'analysis', 'handoff']), 0);
    const feature = runtime.currentRun();
    assert.equal(feature?.sourceAnalysisRunId !== undefined, true);
    assert.equal(await runCli([...base, 'analysis', 'freshness']), 0);
    assert.equal(runtime.currentRun()?.analysisHandoff?.freshness, 'VALID');
  } finally {
    cleanup();
  }
});
