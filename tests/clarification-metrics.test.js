import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { evaluateClarification, validateClarificationCatalog } from '../scripts/lib/clarification-metrics.js';

const rootDir = path.resolve('.');

test('clarification catalog contains the required twenty-case mix', async () => {
  const catalog = JSON.parse(await readFile(path.join(rootDir, 'evals/clarification-cases.json'), 'utf8'));
  assert.deepEqual(validateClarificationCatalog(catalog), []);
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
