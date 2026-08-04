import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { evaluateGoalDefinition, validateGoalDefinitionCatalog } from '../scripts/lib/goal-definition-metrics.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('goal catalog covers execution, exploration, activation, and near-miss behavior', async () => {
  const catalog = JSON.parse(await readFile(path.join(rootDir, 'evals/goal-definition-cases.json'), 'utf8'));
  assert.deepEqual(validateGoalDefinitionCatalog(catalog), []);
  assert.equal(catalog.cases.length, 12);
});

test('goal metrics require sections, length, honest activation, and unchanged permissions', () => {
  const catalog = {
    maxObjectiveCharacters: 4000,
    cases: [{
      id: 'goal',
      expectedAction: 'activate-native',
      requiredSections: ['outcome', 'acceptance'],
      forbiddenBehaviors: ['permission-expansion'],
    }],
  };
  const passing = evaluateGoalDefinition({
    catalog,
    trials: [{ caseId: 'goal', action: 'activate-native', coveredSections: ['outcome', 'acceptance'], objectiveCharacters: 3999 }],
  });
  assert.equal(passing.ok, true);
  assert.equal(passing.sectionCoverage, 1);

  const failing = evaluateGoalDefinition({
    catalog,
    trials: [{
      caseId: 'goal',
      action: 'draft',
      coveredSections: ['outcome'],
      objectiveCharacters: 4001,
      violations: ['permission-expansion', 'false-native-activation'],
    }],
  });
  assert.equal(failing.ok, false);
  assert.match(failing.errors.join('\n'), /expected action|4000|sections|permission-expansion|false-native-activation/iu);
});

test('goal metrics require three distinct trials for every catalog case', () => {
  const catalog = {
    repetitions: 3,
    maxObjectiveCharacters: 4000,
    cases: [{
      id: 'goal',
      expectedAction: 'request-goal-transition',
      requiredSections: ['outcome', 'acceptance'],
      forbiddenBehaviors: ['silent-goal-replacement'],
    }],
  };
  const empty = evaluateGoalDefinition({ catalog, trials: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join('\n'), /goal.*3 distinct repetitions/iu);

  const incomplete = evaluateGoalDefinition({
    catalog,
    trials: [
      { caseId: 'goal', repetition: 1, action: 'request-goal-transition', coveredSections: ['outcome', 'acceptance'], objectiveCharacters: 120 },
      { caseId: 'goal', repetition: 1, action: 'activate-native', coveredSections: ['outcome', 'acceptance'], objectiveCharacters: 120 },
      { caseId: 'goal', repetition: 4, action: 'request-goal-transition', coveredSections: ['outcome', 'acceptance'], objectiveCharacters: 120 },
    ],
  });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.errors.join('\n'), /duplicate|repetition 4|three distinct repetitions|expected action/iu);
});
