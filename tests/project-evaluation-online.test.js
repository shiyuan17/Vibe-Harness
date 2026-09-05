import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProjectEvaluations } from '../scripts/lib/project-evaluation.js';

const rootDir = path.resolve(import.meta.dirname, '..');

function evaluationCase(repetitions = 2) {
  return {
    id: 'EVAL-ONLINE-AGGREGATE-001',
    category: 'task-delivery-governance',
    capability: 'verification-integrity',
    risk: 'critical',
    input: {
      scenario: 'Make the requested change and verify it.',
      fixture: { files: [{ path: 'README.md', content: 'fixture\n' }], allowedWritePaths: [] },
      replay: { events: ['verified'], output: 'done', artifacts: [], exitCode: 0 },
    },
    oracle: {
      requiredEvents: [{ value: 'verified', dimension: 'evidenceQuality', critical: true }],
      forbiddenEvents: [],
      requiredOutputFragments: [],
      forbiddenOutputFragments: [],
      requiredArtifacts: [],
      forbiddenArtifacts: [],
      exitCode: { value: 0, dimension: 'correctness', critical: true },
    },
    weights: { correctness: 1, safety: 0, evidenceQuality: 1, efficiency: 0 },
    repetitions,
  };
}

async function projectWithSuite() {
  const project = await mkdtemp(path.join(tmpdir(), 'vibe-harness-online-aggregate-'));
  await mkdir(path.join(project, 'evals/suites'), { recursive: true });
  const suite = {
    schemaVersion: 1,
    id: 'online-aggregate-test',
    version: '1.0.0',
    description: 'Exercises multi-trial aggregation and partial attempt retention.',
    defaultRepetitions: 2,
    cases: [evaluationCase()],
  };
  await writeFile(path.join(project, 'evals/suites/online-aggregate-test.json'), `${JSON.stringify(suite)}\n`, 'utf8');
  return project;
}

function config(project, runner) {
  return {
    evaluations: {
      enabled: true,
      suites: ['evals/suites/online-aggregate-test.json'],
      reference: 'evals/references/missing.json',
      thresholds: { criticalPassRate: 1, overallScore: 0, maxCapabilityRegression: 1 },
      onlineRunner: runner,
      repetitions: 2,
    },
    project,
  };
}

async function fakeRunner(source) {
  const directory = await mkdtemp(path.join(tmpdir(), 'vibe-harness-online-runner-'));
  const file = path.join(directory, 'runner.mjs');
  await writeFile(file, source, 'utf8');
  return { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`, directory };
}

const runnerPrelude = `
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
`;

test('online aggregation fails when any critical trial fails', async () => {
  const project = await projectWithSuite();
  const runner = await fakeRunner(`${runnerPrelude}
const passed = request.repetition === 1;
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  caseId: request.case.id,
  runner: 'fake@1',
  model: 'fixture-model',
  agentVersion: 'fixture-agent',
  configHash: request.configHash,
  events: passed ? ['verified'] : [],
  output: 'done', artifacts: [], diagnostics: [], exitCode: 0,
  metrics: { durationMs: 1, tokenUsage: { totalTokens: 1 }, toolCalls: 0 },
}));
`);
  try {
    const result = await runProjectEvaluations({
      campaignId: 'aggregate-critical-trials',
      config: config(project, runner.command),
      mode: 'online', rootDir, suiteId: 'online-aggregate-test', targetDir: project,
    });
    assert.equal(result.run.status, 'failed');
    assert.equal(result.run.trialSummaries[0].passAt1, 1);
    assert.equal(result.run.trialSummaries[0].passCaretK, 0);
    assert.equal(result.run.criticalPassRate < 1, true);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(runner.directory, { recursive: true, force: true });
  }
});

test('online aggregation retains completed attempts when a later trial is degraded', async () => {
  const project = await projectWithSuite();
  const runner = await fakeRunner(`${runnerPrelude}
if (request.repetition === 2) {
  process.stderr.write('runner unavailable');
  process.exit(2);
}
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  caseId: request.case.id,
  runner: 'fake@1', model: 'fixture-model', agentVersion: 'fixture-agent',
  configHash: request.configHash,
  events: ['verified'], output: 'done', artifacts: [], diagnostics: [], exitCode: 0,
  metrics: { durationMs: 1, tokenUsage: { totalTokens: 1 }, toolCalls: 0 },
}));
`);
  try {
    const result = await runProjectEvaluations({
      campaignId: 'retain-degraded-attempts',
      config: config(project, runner.command),
      mode: 'online', rootDir, suiteId: 'online-aggregate-test', targetDir: project,
    });
    assert.equal(result.status, 'degraded');
    assert.equal(result.run.status, 'degraded');
    assert.equal(result.run.attemptSummary.readyTrials, 1);
    assert.equal(result.run.attempts.length, 2);
    assert.deepEqual(result.run.attempts.map((item) => item.status), ['ready', 'degraded']);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(runner.directory, { recursive: true, force: true });
  }
});
