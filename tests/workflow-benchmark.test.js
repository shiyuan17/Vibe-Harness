import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compareWorkflowBenchmarkRuns,
  readWorkflowBenchmark,
  validateWorkflowBenchmarkRun,
  validateWorkflowBenchmarkSuite,
} from '../scripts/lib/workflow-benchmark.js';
import {
  blockingInteractionCount,
  validateWorkflowFixture,
  workflowFixture,
} from '../scripts/lib/workflow-benchmark-fixtures.js';

const rootDir = path.resolve('.');

function runFor(suite, workflow) {
  const strict = workflow === 'strict';
  return {
    schemaVersion: 1,
    workflow,
    environment: {
      model: 'fixture-model',
      reasoningEffort: 'medium',
      tools: ['shell'],
      tokenBudget: 10000,
      timeoutMs: 60000,
      oneShotProject: true,
    },
    attempts: suite.cases.flatMap((item) => [1, 2, 3].map((repetition) => ({
      caseId: item.id,
      repetition,
      passed: true,
      totalTokens: strict ? 1000 : 500,
      wallTimeMs: strict ? 1000 : 600,
      blockingInteractions: strict ? 5 : 2,
      toolCalls: strict ? 8 : 5,
      noActionTurns: strict ? 2 : 0,
      criticalFailures: 0,
      scopeViolations: 0,
      falseCompletionClaims: 0,
      trajectoryTags: [],
    }))),
  };
}

test('workflow benchmark fixes the 40-case category mix and 12-case smoke subset', async () => {
  const suite = await readWorkflowBenchmark(path.join(rootDir, 'evals/workflow-benchmark/cases.json'));
  assert.equal(validateWorkflowBenchmarkSuite(suite), true);
  assert.equal(suite.cases.length, 40);
  assert.equal(suite.smokeCaseIds.length, 12);
  assert.deepEqual(Object.fromEntries([...new Set(suite.cases.map((item) => item.category))].map((category) => [
    category, suite.cases.filter((item) => item.category === category).length,
  ])), {
    local: 18,
    ambiguous: 8,
    'cross-module': 6,
    'recovery-agent': 4,
    safety: 4,
  });
});

test('every workflow benchmark case resolves to an executable fixture without credential material', async () => {
  const suite = await readWorkflowBenchmark(path.join(rootDir, 'evals/workflow-benchmark/cases.json'));
  for (const item of suite.cases) {
    const fixture = workflowFixture(item, `/tmp/cognis-fixture-${item.id.toLowerCase()}`);
    assert.ok(['ambiguous', 'code', 'safety'].includes(fixture.kind));
    assert.equal(Object.values(fixture.files).every((content) => typeof content === 'string'), true, item.id);
    assert.doesNotMatch(JSON.stringify(fixture), /OPENAI_API_KEY|auth\.json/iu);
  }
  assert.equal(blockingInteractionCount(['Please confirm retention and visibility?']), 1);
  assert.equal(blockingInteractionCount(['Implemented and verified.']), 0);
});

test('code fixtures use an external deterministic oracle while allowing legitimate test edits', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'cognis-workflow-oracle-'));
  const item = { id: 'LOCAL-02', request: 'Accept an empty optional label.' };
  const fixture = workflowFixture(item, workspace);
  try {
    for (const [name, content] of Object.entries(fixture.files)) {
      const target = path.join(workspace, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
    await writeFile(path.join(workspace, 'src/task.mjs'), "export function validate(input) { if (input.label !== undefined && typeof input.label !== 'string') throw new Error('label'); return input; }\n", 'utf8');
    await writeFile(path.join(workspace, 'test/task.test.mjs'), "import test from 'node:test'; test('agent regression', () => {});\n", 'utf8');
    const validation = await validateWorkflowFixture({
      changedFiles: ['pnpm-lock.yaml', 'src/task.mjs', 'test/task.test.mjs'],
      fixture,
      observation: { metrics: { commands: ['node --test'] }, output: 'Implemented and verified.' },
      workspace,
    });
    assert.deepEqual(validation, {
      agentVerified: true,
      passed: true,
      scopeViolationFiles: [],
      scopeViolations: 0,
      testsPassed: true,
    });
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('workflow comparison enforces non-inferiority, safety, paired efficiency, and all-attempt cost', async () => {
  const suite = await readWorkflowBenchmark(path.join(rootDir, 'evals/workflow-benchmark/cases.json'));
  const adaptive = runFor(suite, 'adaptive');
  const strict = runFor(suite, 'strict');
  assert.equal(validateWorkflowBenchmarkRun(adaptive, suite), true);
  const comparison = compareWorkflowBenchmarkRuns(suite, adaptive, strict);
  assert.equal(comparison.status, 'passed');
  assert.deepEqual(comparison.gates, {
    criticalSafety: true,
    interactionReduction: true,
    nonInferiority: true,
    tokenReduction: true,
    wallTimeReduction: true,
  });
  assert.equal(comparison.allAttemptCostPerSuccess.adaptive.tokens, 500);

  adaptive.attempts[0].falseCompletionClaims = 1;
  assert.equal(compareWorkflowBenchmarkRuns(suite, adaptive, strict).gates.criticalSafety, false);
});
