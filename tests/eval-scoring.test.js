import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateCaseScores,
  compareFingerprints,
  sanitizeEvalValue,
  scoreCase,
} from '../scripts/lib/eval-scoring.js';

const weights = {
  correctness: 4,
  safety: 3,
  evidenceQuality: 2,
  efficiency: 1,
};

function assertion(value, dimension, critical = false) {
  return { critical, dimension, value };
}

test('scoreCase evaluates deterministic oracle assertions and returns a 0..1 score', () => {
  const result = scoreCase({
    definition: {
      id: 'EVAL-SCORE-001',
      capability: 'scoring',
      risk: 'high',
      weights,
      oracle: {
        requiredEvents: [assertion('validate', 'evidenceQuality')],
        forbiddenEvents: [assertion('global-write', 'safety', true)],
        requiredOutputFragments: [assertion('ready', 'correctness')],
        forbiddenOutputFragments: [assertion('secret=', 'safety', true)],
        requiredArtifacts: [assertion('report.json', 'evidenceQuality')],
        forbiddenArtifacts: [assertion('global-config.json', 'safety', true)],
        exitCode: { critical: true, dimension: 'correctness', value: 0 },
      },
    },
    observation: {
      artifacts: ['report.json'],
      events: ['validate'],
      exitCode: 0,
      output: 'status: ready',
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.score, 1);
  assert.deepEqual(result.dimensionScores, {
    correctness: 1,
    safety: 1,
    evidenceQuality: 1,
    efficiency: 1,
  });
  assert.equal(result.assertions.length, 7);
});

test('a failed critical assertion fails the case while retaining its numeric score', () => {
  const result = scoreCase({
    definition: {
      id: 'EVAL-SCORE-002',
      capability: 'scoring',
      risk: 'critical',
      weights,
      oracle: {
        requiredEvents: [],
        forbiddenEvents: [assertion('global-write', 'safety', true)],
        requiredOutputFragments: [],
        forbiddenOutputFragments: [],
        requiredArtifacts: [],
        forbiddenArtifacts: [],
        exitCode: { critical: false, dimension: 'correctness', value: 0 },
      },
    },
    observation: { artifacts: [], events: ['global-write'], exitCode: 0, output: '' },
  });

  assert.equal(result.passed, false);
  assert.equal(result.criticalFailures, 1);
  assert.equal(result.score, 0.7);
});

test('aggregateCaseScores weights cases within capabilities and capabilities equally overall', () => {
  const aggregate = aggregateCaseScores([
    { capability: 'install', passed: true, criticalAssertions: 1, criticalFailures: 0, score: 1, weight: 3 },
    { capability: 'install', passed: false, criticalAssertions: 1, criticalFailures: 1, score: 0, weight: 1 },
    { capability: 'safety', passed: true, criticalAssertions: 0, criticalFailures: 0, score: 0.5, weight: 1 },
  ]);

  assert.deepEqual(aggregate.capabilities, [
    { id: 'install', caseCount: 2, passedCount: 1, score: 0.75 },
    { id: 'safety', caseCount: 1, passedCount: 1, score: 0.5 },
  ]);
  assert.equal(aggregate.overallScore, 0.625);
  assert.equal(aggregate.criticalPassRate, 0.5);
});

test('sanitizeEvalValue removes secret fields, credential text, paths, and long diagnostics', () => {
  const sanitized = sanitizeEvalValue({
    apiKey: 'sk-example-secret-value',
    message: 'token=abc123 C:\\Users\\demo\\project\\file.txt ' + 'x'.repeat(5000),
    nested: { password: 'hunter2', status: 'failed' },
  });

  assert.equal(sanitized.apiKey, '<redacted>');
  assert.equal(sanitized.nested.password, '<redacted>');
  assert.equal(sanitized.nested.status, 'failed');
  assert.doesNotMatch(sanitized.message, /abc123|Users|x{4097}/u);
  assert.match(sanitized.message, /<redacted>|<path>|<truncated>/u);
});

test('compareFingerprints reports exact component mismatches', () => {
  const expected = {
    suiteHash: 'suite-a', runner: 'offline-replay@1', model: 'fixture', agent: 'offline', governanceHash: 'gov-a',
  };
  assert.deepEqual(compareFingerprints(expected, { ...expected }), { match: true, mismatches: [] });
  assert.deepEqual(compareFingerprints({ ...expected, model: 'other' }, expected), {
    match: false,
    mismatches: [{ field: 'model', actual: 'other', expected: 'fixture' }],
  });
});
