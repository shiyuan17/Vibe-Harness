import { createHash } from 'node:crypto';

import { aggregateCaseScores, scoreCase } from './eval-scoring.js';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function suiteHash(suite) {
  return createHash('sha256').update(stableJson(suite)).digest('hex');
}

export function buildOfflineRun(suite, {
  generatedAt = '1970-01-01T00:00:00.000Z',
  id = `${suite.id}-offline`,
  suitePath = `evals/suites/${suite.id}.json`,
} = {}) {
  const cases = suite.cases.map((definition) => scoreCase({
    definition,
    observation: definition.input.replay,
  }));
  const aggregate = aggregateCaseScores(cases);
  const fingerprint = {
    suiteHash: suiteHash(suite),
    runner: 'offline-replay@1',
    model: 'fixture',
    agent: 'offline',
    governanceHash: 'fixture-v1',
  };
  return {
    schemaVersion: 1,
    id,
    generatedAt,
    suite: { id: suite.id, version: suite.version, hash: fingerprint.suiteHash, path: suitePath },
    mode: 'offline',
    status: cases.every((item) => item.passed) ? 'passed' : 'failed',
    fingerprint,
    caseRepetitions: suite.cases.map((item) => ({ id: item.id, count: 1 })),
    cases,
    capabilities: aggregate.capabilities,
    overallScore: aggregate.overallScore,
    criticalPassRate: aggregate.criticalPassRate,
    diagnostics: [],
  };
}
