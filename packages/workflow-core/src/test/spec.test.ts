import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../cli.js';
import { WorkflowRuntime } from '../runtime.js';
import { SPEC_MAP_ARTIFACT, designSources, parseSpecMap, specCoverage } from '../spec.js';
import { SOLUTION_ANALYSIS_ARTIFACTS } from '../types.js';

const DESIGN_DOC = 'docs/design/detail.md';

function specMap(rows: string): string {
  return `| ID | Requirement | Design Ref | Code Paths |\n| --- | --- | --- | --- |\n${rows}`;
}

test('the traceability table parses ids, design refs and code paths', () => {
  const { items, errors } = parseSpecMap(
    specMap(
      `| SPEC-001 | Discount above 10M | ${DESIGN_DOC}#4.2 | src/order/pricing.ts, src/order/rules/ |\n` +
        `| SPEC-002 | Round down to 1000 | ${DESIGN_DOC}#4.3 | |\n`,
    ),
  );
  assert.deepEqual(errors, []);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0]?.codePaths, ['src/order/pricing.ts', 'src/order/rules/']);
  assert.deepEqual(items[1]?.codePaths, []);
  assert.deepEqual(designSources(items), [DESIGN_DOC]);
});

test('every broken row is reported, not just the first', () => {
  const { items, errors } = parseSpecMap(
    specMap(
      `| spec-1 | bad id | ${DESIGN_DOC}#1 | a.ts |\n` +
        `| SPEC-002 | no design reference | | a.ts |\n` +
        `| SPEC-003 | too few columns |\n` +
        `| SPEC-004 | fine | ${DESIGN_DOC}#2 | a.ts |\n` +
        `| SPEC-004 | duplicate | ${DESIGN_DOC}#3 | b.ts |\n`,
    ),
  );
  assert.equal(errors.length, 4, errors.join(' | '));
  assert.deepEqual(items.map((item) => item.id), ['SPEC-004']);
});

test('a table with no rows is an error, not an empty map', () => {
  assert.equal(parseSpecMap('# Traceability\n\nTBD.\n').errors.length, 1);
});

test('coverage matches a file, a directory and a glob suffix', () => {
  const { items } = parseSpecMap(
    specMap(
      `| SPEC-001 | exact | ${DESIGN_DOC}#1 | src/order/pricing.ts |\n` +
        `| SPEC-002 | directory | ${DESIGN_DOC}#2 | src/order/ |\n` +
        `| SPEC-003 | glob | ${DESIGN_DOC}#3 | src/tax/** |\n`,
    ),
  );
  const coverage = specCoverage(items, [
    'src/order/pricing.ts',
    'src\\tax\\vat.ts',
    'src/shipping/rate.ts',
  ]);
  assert.deepEqual(coverage[0]?.itemIds, ['SPEC-001', 'SPEC-002']);
  assert.deepEqual(coverage[1], { file: 'src/tax/vat.ts', itemIds: ['SPEC-003'] });
  assert.deepEqual(coverage[2]?.itemIds, []);
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-spec-'));
  const runtime = new WorkflowRuntime({ projectRoot: dir, runtimeDir: '.ai-workflow' });
  runtime.ensureRuntimeDir();
  writeFileSync(join(dir, 'feature.ts'), 'export const behavior = "old";\n', 'utf8');
  mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
  writeFileSync(join(dir, DESIGN_DOC), '# Detailed design\n\n## 2.1 Behavior\n', 'utf8');
  return {
    dir,
    runtime,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

function prepareAnalysis(runtime: WorkflowRuntime, map: string) {
  const run = runtime.startRun('solution-analysis', { label: 'design intake' });
  runtime.enterPhase('intake');
  runtime.completePhase();
  runtime.enterPhase('analysis');
  for (const name of SOLUTION_ANALYSIS_ARTIFACTS) {
    const body = name === SPEC_MAP_ARTIFACT ? map : `# ${name}\n\nEvidence.\n`;
    writeFileSync(join(runtime.paths.runDir(run.runId), name), body, 'utf8');
    runtime.artifact(name);
  }
  return run;
}

test('an unusable traceability map refuses analysis readiness', () => {
  const { runtime, cleanup } = sandbox();
  try {
    prepareAnalysis(runtime, specMap(`| SPEC-001 | no design reference | | feature.ts |\n`));
    assert.throws(
      () => runtime.markAnalysisReady({ sources: ['feature.ts'] }),
      /not a usable traceability map/,
    );
  } finally {
    cleanup();
  }
});

test('a design document that changed alone makes the approved analysis stale', () => {
  const { dir, runtime, cleanup } = sandbox();
  try {
    // The design doc is never passed as --source; the map alone must pull it in.
    prepareAnalysis(
      runtime,
      specMap(`| SPEC-001 | reusable behavior | ${DESIGN_DOC}#2.1 | feature.ts |\n`),
    );
    const ready = runtime.markAnalysisReady({ sources: ['feature.ts'] });
    assert.ok(ready.analysis?.sourceSnapshot?.some((entry) => entry.path === DESIGN_DOC));
    runtime.approveAnalysis({ approvedSolution: 'reuse', approvedScope: 'feature.ts' });
    runtime.handoffAnalysis();

    writeFileSync(join(dir, DESIGN_DOC), '# Detailed design\n\n## 2.1 Behavior, revised\n', 'utf8');
    const stale = runtime.checkAnalysisFreshness();
    assert.equal(stale.analysisHandoff?.freshness, 'STALE');
    assert.deepEqual(stale.analysisHandoff?.stalePaths, [DESIGN_DOC]);
    assert.deepEqual(runtime.specCheck().staleDesignSources, [DESIGN_DOC]);
  } finally {
    cleanup();
  }
});

test('spec check answers which requirement governs a file, and flags unclaimed ones', () => {
  const { runtime, cleanup } = sandbox();
  try {
    prepareAnalysis(
      runtime,
      specMap(
        `| SPEC-001 | reusable behavior | ${DESIGN_DOC}#2.1 | feature.ts |\n` +
          `| SPEC-002 | not implemented yet | ${DESIGN_DOC}#2.2 | |\n`,
      ),
    );
    runtime.markAnalysisReady({ sources: ['feature.ts'] });
    const report = runtime.specCheck({ files: ['feature.ts', 'unrelated.ts'] });
    assert.deepEqual(report.coverage, [
      { file: 'feature.ts', itemIds: ['SPEC-001'] },
      { file: 'unrelated.ts', itemIds: [] },
    ]);
    assert.deepEqual(report.unmapped, ['SPEC-002']);
    assert.ok(
      runtime.specWarnings(runtime.resolveRun()).some((w) => w.startsWith('SPEC-002 has no code path')),
    );
  } finally {
    cleanup();
  }
});

test('the public CLI answers spec check and reports an unusable map', async () => {
  const { dir, runtime, cleanup } = sandbox();
  try {
    prepareAnalysis(
      runtime,
      specMap(`| SPEC-001 | reusable behavior | ${DESIGN_DOC}#2.1 | feature.ts |\n`),
    );
    const base = ['--project', dir, '--runtime', '.ai-workflow'];
    assert.equal(await runCli([...base, 'spec', 'check', '--files', 'feature.ts']), 0);

    writeFileSync(
      join(runtime.paths.runDir(runtime.resolveRun().runId), SPEC_MAP_ARTIFACT),
      specMap(`| nope | broken id | ${DESIGN_DOC}#2.1 | feature.ts |\n`),
      'utf8',
    );
    assert.equal(await runCli([...base, 'spec', 'check']), 1);
    await assert.rejects(
      () => runCli([...base, 'analysis', 'ready', '--source', 'feature.ts']),
      /not a usable traceability map/,
    );
  } finally {
    cleanup();
  }
});

test('a run with no design lineage is not nagged about a missing map', () => {
  const { runtime, cleanup } = sandbox();
  try {
    const run = runtime.startRun('quick-fix');
    assert.deepEqual(runtime.specWarnings(run), []);
  } finally {
    cleanup();
  }
});
