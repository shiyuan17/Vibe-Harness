import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  compareWorkflowBenchmarkRuns,
  readWorkflowBenchmark,
  validateWorkflowBenchmarkRun,
  validateWorkflowBenchmarkSuite,
} from '../scripts/lib/workflow-benchmark.js';

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
