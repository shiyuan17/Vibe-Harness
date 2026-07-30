import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeTrials } from '../scripts/lib/eval-trials.js';
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

test('scoreCase evaluates deterministic oracle assertions and returns a 0..1 score', async () => {
  const result = await scoreCase({
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

test('a failed critical assertion fails the case while retaining its numeric score', async () => {
  const result = await scoreCase({
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

test('a flaky case records failure and score without setting flakyFailure when it passes', async () => {
  const result = await scoreCase({
    definition: {
      id: 'EVAL-SCORE-FLAKY-OK',
      capability: 'scoring',
      risk: 'critical',
      flaky: true,
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
    observation: { artifacts: [], events: [], exitCode: 0, output: '' },
  });

  assert.equal(result.passed, true);
  assert.equal(result.flakyFailure, false);
  assert.equal(result.criticalFailures, 0);
});

test('a flaky case with a critical failure records the failure but does not gate', async () => {
  const result = await scoreCase({
    definition: {
      id: 'EVAL-SCORE-FLAKY-FAIL',
      capability: 'scoring',
      risk: 'critical',
      flaky: true,
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

  // The case is marked failed and the score reflects the failure...
  assert.equal(result.passed, false);
  assert.equal(result.flakyFailure, true);
  assert.equal(result.criticalFailures, 1);
  assert.equal(result.score, 0.7);
  // ...but a flaky failure must not pull down the aggregate critical pass rate.
  const aggregate = aggregateCaseScores([result]);
  assert.equal(aggregate.criticalPassRate, 1);
});

function fakeJudge(score, { rationale = 'fake rationale', judgeModel = 'fake-judge' } = {}) {
  return {
    async judgeRubric() {
      return { score, rationale, judgeModel };
    },
  };
}

const rubricOracle = (rubric, { threshold, critical = true } = {}) => ({
  requiredEvents: [],
  forbiddenEvents: [],
  requiredOutputFragments: [],
  forbiddenOutputFragments: [],
  requiredArtifacts: [],
  forbiddenArtifacts: [],
  exitCode: { critical: false, dimension: 'correctness', value: 0 },
  llmRubrics: [{ rubric, dimension: 'correctness', critical, ...(threshold !== undefined ? { threshold } : {}) }],
});

const rubricDefinition = (id, oracle) => ({
  id,
  capability: 'scoring',
  risk: 'high',
  weights,
  input: { scenario: 'judge the agent output' },
  oracle,
});

test('scoreCase invokes the judge for llmRubrics and passes when score meets the threshold', async () => {
  const result = await scoreCase({
    definition: rubricDefinition('EVAL-SCORE-RUBRIC-PASS', rubricOracle('output must be concise', { threshold: 0.8 })),
    observation: { artifacts: [], events: [], exitCode: 0, output: 'short answer' },
    judge: fakeJudge(0.9),
  });

  assert.equal(result.passed, true);
  assert.equal(result.assertions.length, 2);
  const rubricAssertion = result.assertions.find((item) => item.kind === 'llm-rubric');
  assert.equal(rubricAssertion.passed, true);
  assert.equal(rubricAssertion.score, 0.9);
  assert.equal(rubricAssertion.rationale, 'fake rationale');
  assert.equal(rubricAssertion.judgeModel, 'fake-judge');
});

test('scoreCase fails a critical llmRubric when score is below the default threshold', async () => {
  const result = await scoreCase({
    definition: { ...rubricDefinition('EVAL-SCORE-RUBRIC-FAIL', rubricOracle('output must be concise')), risk: 'critical' },
    observation: { artifacts: [], events: [], exitCode: 0, output: 'verbose answer' },
    judge: fakeJudge(0.5),
  });

  assert.equal(result.passed, false);
  assert.equal(result.criticalFailures, 1);
  assert.equal(result.assertions.find((item) => item.kind === 'llm-rubric').passed, false);
});

test('scoreCase throws when llmRubrics are present without a judge client', async () => {
  await assert.rejects(
    scoreCase({
      definition: rubricDefinition('EVAL-SCORE-RUBRIC-NO-JUDGE', rubricOracle('output must be concise')),
      observation: { artifacts: [], events: [], exitCode: 0, output: 'answer' },
    }),
    /judge client/u,
  );
});

test('aggregateCaseScores keeps the critical pass rate gated by non-flaky failures only', () => {
  const flakyFailed = {
    capability: 'safety', passed: false, flakyFailure: true,
    criticalAssertions: 2, criticalFailures: 2, score: 0.3, weight: 1,
  };
  const gatedFailed = {
    capability: 'safety', passed: false, flakyFailure: false,
    criticalAssertions: 2, criticalFailures: 1, score: 0.5, weight: 1,
  };
  const aggregate = aggregateCaseScores([flakyFailed, gatedFailed]);

  // 2 gated critical assertions, 1 gated failure -> 0.5; flaky failures excluded.
  assert.equal(aggregate.criticalPassRate, 0.5);
  // Overall score still weights the flaky case so it is reported, not erased.
  assert.equal(aggregate.overallScore, 0.4);
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

test('summarizeTrials reports pass@k, pass^k, and per-trial detail across outcomes', () => {
  const allPass = summarizeTrials('CASE-A', [
    { passed: true, score: 1 },
    { passed: true, score: 0.9 },
    { passed: true, score: 1 },
  ]);
  assert.equal(allPass.repetitions, 3);
  assert.equal(allPass.passAt1, 1);
  assert.equal(allPass.passAtK, 1);
  assert.equal(allPass.passCaretK, 1);
  assert.equal(allPass.passedTrials, 3);
  assert.equal(allPass.meanScore, 0.966667);
  assert.equal(allPass.perTrial.length, 3);
  assert.deepEqual(allPass.perTrial[1], { repetition: 2, passed: true, score: 0.9 });

  const partialPass = summarizeTrials('CASE-B', [
    { passed: false, score: 0.4 },
    { passed: true, score: 1 },
    { passed: false, score: 0.2 },
  ]);
  assert.equal(partialPass.passAt1, 0);
  assert.equal(partialPass.passAtK, 1);
  assert.equal(partialPass.passCaretK, 0);
  assert.equal(partialPass.passedTrials, 1);
  assert.equal(partialPass.meanScore, 0.533333);

  const allFail = summarizeTrials('CASE-C', [
    { passed: false, score: 0 },
    { passed: false, score: 0.1 },
  ]);
  assert.equal(allFail.passAt1, 0);
  assert.equal(allFail.passAtK, 0);
  assert.equal(allFail.passCaretK, 0);
  assert.equal(allFail.passedTrials, 0);
  assert.equal(allFail.meanScore, 0.05);

  // Empty trials must not vacuously pass: passCaretK guards against 0===0.
  const empty = summarizeTrials('CASE-D', []);
  assert.equal(empty.repetitions, 0);
  assert.equal(empty.passAt1, 0);
  assert.equal(empty.passAtK, 0);
  assert.equal(empty.passCaretK, 0);
  assert.equal(empty.meanScore, 0);
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
    suiteHash: 'suite-a', runner: 'offline-replay@1', model: 'fixture', agent: 'offline', configHash: 'gov-a',
  };
  assert.deepEqual(compareFingerprints(expected, { ...expected }), { match: true, mismatches: [] });
  assert.deepEqual(compareFingerprints({ ...expected, model: 'other' }, expected), {
    match: false,
    mismatches: [{ field: 'model', actual: 'other', expected: 'fixture' }],
  });
});
