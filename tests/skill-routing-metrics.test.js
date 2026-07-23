import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  compareSkillSetVariants,
  evaluateSkillRouting,
  evaluateTriggerRepetitions,
  validateRoutingCatalog,
  validateSkillSetBaseline,
} from '../scripts/lib/skill-routing-metrics.js';

const rootDir = path.resolve('.');

test('routing catalog covers every native skill with eight positive and near-miss cases', async () => {
  const [catalog, skills] = await Promise.all([
    readFile(path.join(rootDir, 'evals/skill-routing-cases.json'), 'utf8').then(JSON.parse),
    readFile(path.join(rootDir, 'manifests/skills.json'), 'utf8').then(JSON.parse),
  ]);
  const skillIds = skills.items.filter((item) => item.kind === 'native').map((item) => item.id);

  assert.deepEqual(validateRoutingCatalog({ catalog, skillIds }), []);
});

test('old/new/no-Skill comparison enforces non-inferiority, loaded tokens, safety, and retained value', () => {
  const trials = [];
  for (const variant of ['old-skills', 'new-skills', 'no-skills']) {
    for (const [caseId, skill] of [['clarify-case', 'clarify-requirements'], ['debug-case', 'systematic-debugging']]) {
      for (let repetition = 1; repetition <= 3; repetition += 1) {
        trials.push({
          caseId,
          critical: caseId === 'clarify-case',
          loadedSkillTokens: variant === 'old-skills' ? 1000 : (variant === 'new-skills' ? 400 : 0),
          passed: variant !== 'no-skills',
          repetition,
          skill,
          totalTokens: variant === 'old-skills' ? 2000 : (variant === 'new-skills' ? 1000 : 1200),
          variant,
        });
      }
    }
  }
  const comparison = compareSkillSetVariants(trials);
  assert.equal(comparison.ok, true);
  assert.equal(comparison.gates.loadedTokenReduction, true);
  assert.equal(comparison.gates.retainedSkillValue, true);
});

test('frozen old/new/no-Skill baseline enforces metadata reduction', async () => {
  const baseline = JSON.parse(await readFile(path.join(rootDir, 'evals/skill-set-baseline.json'), 'utf8'));
  const passing = validateSkillSetBaseline({ baseline, current: { identityCharacters: 852, skillCount: 7 } });
  assert.equal(passing.ok, true);
  assert.ok(passing.identityReduction >= 0.4);
  const failing = validateSkillSetBaseline({ baseline, current: { identityCharacters: 1600, skillCount: 8 } });
  assert.equal(failing.ok, false);
});

test('trigger repetitions require two positive hits and at most one near-miss hit', () => {
  const repetitions = (caseId, shouldTrigger, predictions, criticalNegative = false) => predictions.map((predictedSkill, index) => ({
    caseId,
    criticalNegative,
    predictedSkill,
    repetition: index + 1,
    shouldTrigger,
    skill: 'clarify-requirements',
  }));
  const passing = evaluateTriggerRepetitions([
    ...repetitions('positive', true, ['clarify-requirements', null, 'clarify-requirements']),
    ...repetitions('near-miss', false, [null, 'clarify-requirements', null]),
    ...repetitions('clear-local-critical', false, [null, null, null], true),
  ]);
  assert.equal(passing.ok, true);

  const failing = evaluateTriggerRepetitions([
    ...repetitions('weak-positive', true, [null, 'clarify-requirements', null]),
    ...repetitions('false-positive', false, ['clarify-requirements', null, 'clarify-requirements']),
  ]);
  assert.equal(failing.ok, false);
  assert.match(failing.errors.join('\n'), /at least 2\/3|at most 1\/3/u);
});

test('routing metrics enforce precision, recall, critical repetitions, and A/B pass rate', () => {
  const passing = evaluateSkillRouting({
    criticalSkills: ['security-and-hardening'],
    trials: [
      ...[1, 2, 3].map((repetition) => ({
        caseId: 'security-positive', critical: true, durationMs: 100, expectedSkill: 'security-and-hardening',
        passed: true, predictedSkill: 'security-and-hardening', repetition, tokens: 50, variant: 'with-skill',
      })),
      { caseId: 'security-baseline', critical: false, durationMs: 80, expectedSkill: 'security-and-hardening', passed: false, predictedSkill: null, repetition: 1, tokens: 40, variant: 'without-skill' },
    ],
  });
  assert.equal(passing.ok, true);
  assert.equal(passing.skills['security-and-hardening'].precision, 1);
  assert.equal(passing.skills['security-and-hardening'].recall, 1);
  assert.equal(passing.ab.passRate.withSkill >= passing.ab.passRate.withoutSkill, true);

  const failing = evaluateSkillRouting({
    criticalSkills: ['security-and-hardening'],
    trials: [
      { caseId: 'security-positive', critical: true, durationMs: 100, expectedSkill: 'security-and-hardening', passed: false, predictedSkill: 'systematic-debugging', repetition: 1, tokens: 50, variant: 'with-skill' },
      { caseId: 'security-baseline', critical: false, durationMs: 80, expectedSkill: 'security-and-hardening', passed: true, predictedSkill: null, repetition: 1, tokens: 40, variant: 'without-skill' },
    ],
  });
  assert.equal(failing.ok, false);
  assert.match(failing.errors.join('\n'), /recall|three repetitions|A\/B/iu);
});
