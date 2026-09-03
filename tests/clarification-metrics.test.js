import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { evaluateClarification, validateClarificationCatalog } from '../scripts/lib/clarification-metrics.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('clarification catalog contains blocker and explicit-discovery cases', async () => {
  const catalog = JSON.parse(await readFile(path.join(rootDir, 'evals/clarification-cases.json'), 'utf8'));
  assert.deepEqual(validateClarificationCatalog(catalog), []);
  assert.equal(catalog.cases.length, 26);
  assert.equal(catalog.cases.filter((item) => item.kind === 'discovery').length, 4);
  assert.equal(catalog.cases.filter((item) => item.kind === 'near-miss').length, 6);
  assert.ok(catalog.cases.some((item) => item.id === 'near-runtime-evidence'));
  assert.ok(catalog.cases.some((item) => item.id === 'near-source-conflict'));
});

test('discovery metrics require complete dimensions without fact questions or silent high-impact defaults', () => {
  const catalog = {
    cases: [{
      id: 'discovery',
      kind: 'discovery',
      requiredDecisions: ['audience'],
      requiredDimensions: ['audience', 'problem', 'outcome'],
      expectedBlockingRounds: 1,
    }],
  };
  const passing = evaluateClarification({
    catalog,
    trials: [{
      caseId: 'discovery',
      blockingRounds: 1,
      coveredDecisions: ['audience'],
      coveredDimensions: ['audience', 'problem', 'outcome'],
      maxQuestionsInRound: 3,
    }],
  });
  assert.equal(passing.ok, true);
  assert.equal(passing.discoveryCoverage, 1);

  const failing = evaluateClarification({
    catalog,
    trials: [{
      caseId: 'discovery',
      blockingRounds: 1,
      coveredDecisions: [],
      coveredDimensions: ['audience'],
      factQuestionViolations: 1,
      silentHighImpactDefaults: 1,
    }],
  });
  assert.equal(failing.ok, false);
  assert.match(failing.errors.join('\n'), /discovery dimensions|discoverable facts|high-impact defaults/iu);
});

test('clarification metrics reject extra rounds, dependent-order, and implementation questions', () => {
  const catalog = { cases: [{ id: 'case', requiredDecisions: ['behavior'], expectedBlockingRounds: 1 }] };
  const passing = evaluateClarification({
    catalog,
    trials: [{ caseId: 'case', blockingRounds: 1, coveredDecisions: ['behavior'], maxQuestionsInRound: 1 }],
  });
  assert.equal(passing.ok, true);
  assert.equal(passing.criticalDecisionCoverage, 1);

  const failing = evaluateClarification({
    catalog,
    trials: [{ caseId: 'case', blockingRounds: 2, coveredDecisions: [], dependencyViolations: 1, implementationQuestionViolations: 1, maxQuestionsInRound: 4 }],
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.criticalDecisionCoverage, 0);
  assert.match(failing.errors.join('\n'), /three questions|blocking rounds|order|implementation/iu);
});
