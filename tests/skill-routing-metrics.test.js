import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateSkillRouting,
  validateRoutingCatalog,
} from '../scripts/lib/skill-routing-metrics.js';

const rootDir = path.resolve('.');

test('routing catalog covers every core skill with positive, negative, and confusion cases', async () => {
  const [catalog, installMap] = await Promise.all([
    readFile(path.join(rootDir, 'evals/skill-routing-cases.json'), 'utf8').then(JSON.parse),
    readFile(path.join(rootDir, 'adapters/codex/install-map.json'), 'utf8').then(JSON.parse),
  ]);
  const skillIds = installMap.entries
    .filter((entry) => entry.group === 'skills-core' && entry.target.endsWith('/SKILL.md'))
    .map((entry) => entry.target.split('/').at(-2));

  assert.deepEqual(validateRoutingCatalog({ catalog, skillIds }), []);
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
