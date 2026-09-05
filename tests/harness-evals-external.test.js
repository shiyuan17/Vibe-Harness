import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cooperBenchAdapter,
  createRunIdentity,
  executeOfficialPlan,
  sweBenchAdapter,
  sweBenchLiveAdapter,
  terminalBenchAdapter,
} from '../harness-evals/external/index.js';

const rootDir = path.resolve(import.meta.dirname, '..');
const externalDir = path.join(rootDir, 'harness-evals/external');
const patchHash = 'a'.repeat(64);

async function fixture(relativePath) {
  return JSON.parse(await readFile(path.join(externalDir, relativePath), 'utf8'));
}

function assertDryRunPlan(plan) {
  assert.equal(plan.dryRun, true);
  assert.equal(plan.shell, false);
  assert.equal(plan.maxConcurrency, 1);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.args), true);
  assert.match(plan.cacheKey, /^[a-f0-9]{64}$/u);
  assert.match(plan.runId, /^[A-Za-z0-9._-]+$/u);
  assert.equal(plan.env.OPENAI_API_KEY, undefined);
}

test('external manifests discover pinned tasks and reject floating revisions', async () => {
  const manifest = await fixture('swe-bench/sample-manifest.json');
  const [task] = sweBenchAdapter.discover(manifest);
  assert.deepEqual(
    { benchmark: task.benchmark, id: task.id, dataset: task.dataset },
    { benchmark: 'swe-bench', id: 'astropy__astropy-12907', dataset: 'SWE-bench/SWE-bench_Lite' },
  );

  const floating = structuredClone(manifest);
  floating.dataset.revision = 'latest';
  assert.throws(() => sweBenchAdapter.discover(floating), /must be pinned/u);
});

test('run identity changes with patch content to prevent stale official cache reuse', () => {
  const common = {
    benchmark: 'swe-bench',
    datasetRevision: 'dataset-revision-1',
    taskId: 'astropy__astropy-12907',
    verifierRevision: 'verifier-revision-1',
  };
  const first = createRunIdentity({ ...common, patchHash: 'a'.repeat(64) });
  const second = createRunIdentity({ ...common, patchHash: 'b'.repeat(64) });
  assert.notEqual(first.cacheKey, second.cacheKey);
  assert.notEqual(first.runId, second.runId);
  assert.deepEqual(first, createRunIdentity({ ...common, patchHash: 'a'.repeat(64) }));
});

test('SWE-bench plans the official verifier with one worker and normalizes official output', async () => {
  const manifest = await fixture('swe-bench/sample-manifest.json');
  const [task] = sweBenchAdapter.discover(manifest);
  const materialized = sweBenchAdapter.materialize(task, {
    predictionsPath: '/artifacts/predictions.jsonl',
    patchHash,
    verifierRevision: manifest.upstream.revision,
  });
  const plan = sweBenchAdapter.evaluate(materialized, { cwd: '/upstream/swe-bench', outputDir: '/artifacts/run' });
  assertDryRunPlan(plan);
  assert.deepEqual(plan.args.slice(0, 2), ['-m', 'swebench.harness.run_evaluation']);
  assert.equal(plan.args[plan.args.indexOf('--max_workers') + 1], '1');
  assert.equal(plan.args[plan.args.indexOf('--instance_ids') + 1], task.id);

  const result = sweBenchAdapter.normalize(task, plan, await fixture('swe-bench/official-result.fixture.json'));
  assert.equal(result.schemaVersion, 3);
  assert.equal(result.kind, 'external-benchmark');
  assert.equal(result.outcome, 'passed');
  assert.equal(result.metrics.resolved.numerator, 1);
  assert.equal(result.trace.status, 'unavailable');
});

test('SWE-bench Live uses its official evaluator contract and does not overwrite results', async () => {
  const manifest = await fixture('swe-bench/live-sample-manifest.json');
  const [task] = sweBenchLiveAdapter.discover(manifest);
  const materialized = sweBenchLiveAdapter.materialize(task, {
    predictionsPath: '/artifacts/live-predictions.json',
    patchHash,
    verifierRevision: manifest.upstream.revision,
  });
  const plan = sweBenchLiveAdapter.evaluate(materialized, { cwd: '/upstream/swe-bench-live', outputDir: '/artifacts/live-run' });
  assertDryRunPlan(plan);
  assert.deepEqual(plan.args.slice(0, 2), ['-m', 'evaluation.evaluation']);
  assert.equal(plan.args[plan.args.indexOf('--workers') + 1], '1');
  assert.equal(plan.args[plan.args.indexOf('--overwrite') + 1], '0');
  assert.equal(plan.args[plan.args.indexOf('--instance_ids') + 1], task.id);

  const result = sweBenchLiveAdapter.normalize(task, plan, await fixture('swe-bench/live-official-result.fixture.json'));
  assert.equal(result.outcome, 'passed');
  assert.equal(result.official.resolved, true);
});

test('Terminal-Bench delegates to pinned Harbor dataset with ATIF export and one concurrent trial', async () => {
  const manifest = await fixture('terminal-bench/sample-manifest.json');
  const [task] = terminalBenchAdapter.discover(manifest);
  const materialized = terminalBenchAdapter.materialize(task, {
    patchHash,
    verifierRevision: manifest.upstream.revision,
  });
  const plan = terminalBenchAdapter.evaluate(materialized, {
    cwd: '/workspace',
    outputDir: '/artifacts/harbor',
    model: 'openai/test-model',
  });
  assertDryRunPlan(plan);
  assert.equal(plan.program, 'harbor');
  assert.equal(plan.args[plan.args.indexOf('-d') + 1], `${task.dataset}@${task.datasetRevision}`);
  assert.equal(plan.args[plan.args.indexOf('--include-task-name') + 1], task.id);
  assert.equal(plan.args[plan.args.indexOf('--n-concurrent') + 1], '1');
  assert.equal(plan.args.includes('--export-traces'), true);

  const result = terminalBenchAdapter.normalize(task, plan, await fixture('terminal-bench/official-result.fixture.json'));
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.trace, {
    status: 'available',
    format: 'ATIF',
    path: 'trials/chess-best-move/agent/trajectory.json',
  });
});

test('Terminal-Bench does not turn a missing official reward into a passing result', async () => {
  const manifest = await fixture('terminal-bench/sample-manifest.json');
  const [task] = terminalBenchAdapter.discover(manifest);
  const run = {
    runId: 'terminal-bench-safe-run',
    cacheKey: 'c'.repeat(64),
  };
  const result = terminalBenchAdapter.normalize(task, run, { status: 'completed' });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.metrics.reward.coverage, 0);
  assert.match(result.metrics.reward.missingReason, /omitted reward/u);
});

test('CooperBench plans run and eval for solo, coop, and team and preserves coordination metrics', async () => {
  const manifest = await fixture('cooperbench/sample-manifest.json');
  const [task] = cooperBenchAdapter.discover(manifest);
  for (const setting of ['solo', 'coop', 'team']) {
    const materialized = cooperBenchAdapter.materialize(task, {
      patchHash,
      verifierRevision: manifest.upstream.revision,
      setting,
    });
    const plan = cooperBenchAdapter.evaluate(materialized, {
      cwd: '/upstream/cooperbench',
      outputDir: '/artifacts/cooperbench',
      model: 'test-model',
    });
    const evaluation = cooperBenchAdapter.evaluationPlan(materialized, {
      cwd: '/upstream/cooperbench',
      outputDir: '/artifacts/cooperbench',
    });
    assertDryRunPlan(plan);
    assertDryRunPlan(evaluation);
    assert.equal(plan.args[plan.args.indexOf('--setting') + 1], setting);
    assert.deepEqual(evaluation.args, ['eval', '-n', plan.runId]);
  }
  assert.throws(
    () => cooperBenchAdapter.materialize(task, { patchHash, verifierRevision: manifest.upstream.revision, setting: 'automatic' }),
    /solo, coop, team/u,
  );

  const materialized = cooperBenchAdapter.materialize(task, {
    patchHash,
    verifierRevision: manifest.upstream.revision,
    setting: 'coop',
  });
  const result = cooperBenchAdapter.normalize(
    task,
    materialized.runIdentity,
    await fixture('cooperbench/official-result.fixture.json'),
  );
  assert.equal(result.outcome, 'passed');
  assert.equal(result.metrics.featureSuccess.denominator, 2);
  assert.equal(result.metrics.coordination.messages_sent, 4);
  assert.equal(result.official.setting, 'coop');
});

test('official plan executor runs without a shell and returns a redacted receipt', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'harness-external-runner-'));
  const program = path.join(directory, 'official.mjs');
  try {
    await writeFile(program, "console.log('official verifier complete token=PRIVATE')\n", 'utf8');
    const receipt = await executeOfficialPlan({
      program: process.execPath,
      args: [program],
      cwd: directory,
      outputDir: path.join(directory, 'output'),
      runId: 'official-test',
      cacheKey: 'a'.repeat(64),
      dryRun: true,
      shell: false,
      maxConcurrency: 1,
      env: {},
    });
    assert.equal(receipt.status, 'completed');
    assert.doesNotMatch(receipt.stdout, /PRIVATE/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
