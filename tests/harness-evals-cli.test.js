import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { buildResultV3, toAtifTrace, writeTraceBundle } from '../harness-evals/lib/index.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cli = path.join(rootDir, 'scripts/harness-evals.js');

function run(args) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: rootDir, maxBuffer: 4 * 1024 * 1024 });
}

function sampleResult() {
  return buildResultV3({
    scenario: { id: 'H04', title: 'Verification skipped', version: '1.0.0' },
    attempts: [{ id: 'attempt-1', status: 'passed', durationMs: 5 }],
    checks: [{ id: 'H04-C1', status: 'passed', category: 'outcome', severity: 'critical' }],
    fingerprint: { measurement: { scenario: 'H04' }, harness: { revision: 'test' } },
    generatedAt: '2026-09-05T00:00:00.000Z',
  });
}

test('harness eval check validates the Internal and External catalogs', async () => {
  const { stdout } = await run(['check']);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'passed');
  assert.equal(result.internalScenarios, 20);
  assert.deepEqual(result.externalTasks.map((task) => task.benchmark), ['swe-bench', 'swe-bench-live', 'terminal-bench', 'cooperbench']);
});

test('harness eval plan reports capability blocks instead of simulating support', async () => {
  const { stdout } = await run(['plan', '--tier', 'fast']);
  const plan = JSON.parse(stdout);
  assert.equal(plan.summary.selectedScenarios, 6);
  assert.equal(plan.entries.find((entry) => entry.scenarioId === 'H04').status, 'ready');
  assert.deepEqual(plan.entries.find((entry) => entry.scenarioId === 'H15').missingCapabilities.sort(), ['fault-injection', 'native-subagents']);
  assert.deepEqual(plan.entries.find((entry) => entry.scenarioId === 'H20').missingCapabilities, ['resume']);
});

test('report, baseline, compare, and trace analysis commands consume Result v3', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'harness-evals-cli-'));
  try {
    const resultsPath = path.join(directory, 'results.json');
    const baselinePath = path.join(directory, 'baseline.json');
    const reportPath = path.join(directory, 'report.md');
    const comparisonPath = path.join(directory, 'comparison.json');
    const analysisPath = path.join(directory, 'analysis.json');
    const result = sampleResult();
    await writeFile(resultsPath, JSON.stringify({ results: [result] }), 'utf8');
    await run(['report', '--input', resultsPath, '--output', reportPath]);
    assert.match(await readFile(reportPath, 'utf8'), /H04/u);
    await run(['baseline', '--input', resultsPath, '--id', 'test-baseline', '--output', baselinePath]);
    assert.equal(JSON.parse(await readFile(baselinePath, 'utf8')).status, 'candidate');
    await run(['compare', '--baseline', baselinePath, '--current', resultsPath, '--output', comparisonPath]);
    assert.equal(JSON.parse(await readFile(comparisonPath, 'utf8')).conclusion, 'no-material-change');

    const traceDir = path.join(directory, 'trace');
    await writeTraceBundle(traceDir, { trace: toAtifTrace({ runId: 'test', events: [] }) });
    await run(['analyze', '--trace', traceDir, '--result', resultsPath, '--output', analysisPath]);
    assert.equal(JSON.parse(await readFile(analysisPath, 'utf8')).traceState, 'available');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
