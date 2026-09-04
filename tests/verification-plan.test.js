import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildVerificationPlan, classifyVerificationRisk } from '../scripts/lib/verification-plan.js';

const scripts = {
  check: 'node ./scripts/lint.js && node ./scripts/validate.js && pnpm test:unit',
  lint: 'node ./scripts/lint.js',
  validate: 'node ./scripts/validate.js',
  'test:unit': 'node --test',
  'eval:check': 'node ./scripts/eval-check.js',
  'eval:replay': 'node ./scripts/eval-replay.js',
  'test:eval': 'node --test tests/eval.test.js',
  'test:integration': 'node --test tests/integration.test.js',
  'smoke:lifecycle': 'node ./scripts/smoke-lifecycles.js',
  'docs:audit': 'node ./scripts/docs-audit.js',
  'skills:audit': 'node ./scripts/skills-audit.js',
};

async function targetWithScripts() {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-plan-'));
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ scripts }) + '\n', 'utf8');
  return target;
}

test('verification risk classifier selects quick, standard, high, and unknown safely', () => {
  assert.equal(classifyVerificationRisk(['README.md']).riskLevel, 'quick');
  assert.equal(classifyVerificationRisk(['tests/example.test.js']).riskLevel, 'quick');
  assert.equal(classifyVerificationRisk(['src/example.js']).riskLevel, 'standard');
  assert.equal(classifyVerificationRisk(['schemas/example.json']).riskLevel, 'high');
  const unknown = classifyVerificationRisk(['misc/example.bin']);
  assert.equal(unknown.riskLevel, 'unknown');
  assert.equal(unknown.fallbackUsed, true);
});

test('riskZones and pathPatterns raise risk and preserve the reason in the plan', async () => {
  const target = await targetWithScripts();
  try {
    const red = await buildVerificationPlan({
      changedPaths: ['src/auth/client.js'],
      config: { riskZones: { red: ['auth'] } },
      targetDir: target,
    });
    assert.equal(red.riskLevel, 'high');
    assert.ok(red.selectionReasons.some((reason) => reason.includes('riskZones.red')));

    const yellow = classifyVerificationRisk(['src/state/store.js'], {
      riskZones: { pathPatterns: { yellow: ['src/**'] } },
    });
    assert.equal(yellow.riskLevel, 'standard');
    assert.equal(yellow.configuredZones.yellow, true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('documentation, tests, and ordinary scripts stay below integration and smoke', async () => {
  const target = await targetWithScripts();
  try {
    const docs = await buildVerificationPlan({ changedPaths: ['README.md'], targetDir: target });
    assert.deepEqual(docs.selectedChecks.map((item) => item.id), ['docs']);

    const unit = await buildVerificationPlan({ changedPaths: ['tests/example.test.js'], targetDir: target });
    assert.deepEqual(unit.selectedChecks.map((item) => item.id), ['test']);
    assert.equal(unit.selectedChecks.some((item) => ['integration', 'smoke'].includes(item.id)), false);

    const script = await buildVerificationPlan({ changedPaths: ['scripts/lib/other.js'], targetDir: target });
    assert.deepEqual(script.selectedChecks.map((item) => item.id), ['test']);
    assert.equal(script.selectedChecks.some((item) => ['integration', 'smoke'].includes(item.id)), false);

    const rules = await buildVerificationPlan({ changedPaths: ['docs/rules/test-rules.md'], targetDir: target });
    assert.equal(rules.impactGroups.includes('rules'), true);
    assert.deepEqual(rules.selectedChecks.map((item) => item.id), ['test', 'eval-check']);

    const skill = await buildVerificationPlan({ changedPaths: ['.agents/skills/example/SKILL.md'], targetDir: target });
    assert.equal(skill.riskLevel, 'standard');
    assert.equal(skill.impactGroups.includes('skills'), true);
    assert.equal(skill.selectedChecks.some((item) => ['integration', 'smoke'].includes(item.id)), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('high risk and unknown plans select lifecycle checks, while aggregate check expands atomically', async () => {
  const target = await targetWithScripts();
  try {
    const high = await buildVerificationPlan({ changedPaths: ['scripts/lib/install-planner.js'], targetDir: target });
    assert.deepEqual(high.selectedChecks.map((item) => item.id), [
      'validate', 'lint', 'test', 'eval', 'integration', 'smoke',
    ]);
    assert.equal(new Set(high.selectedChecks.map((item) => item.command)).size, high.selectedChecks.length);

    const unknown = await buildVerificationPlan({ changedPaths: ['misc/example.bin'], targetDir: target });
    assert.equal(unknown.riskLevel, 'unknown');
    assert.equal(unknown.fallbackUsed, true);
    assert.ok(unknown.selectedChecks.some((item) => item.id === 'integration'));
    assert.ok(unknown.selectedChecks.some((item) => item.id === 'smoke'));
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('comment-only source changes remain quick when the diff supplies content evidence', () => {
  const risk = classifyVerificationRisk(['src/example.js'], {
    changedDetails: [{ commentsOnly: true }],
  });
  assert.equal(risk.riskLevel, 'quick');
  assert.equal(risk.commentsOnly, true);
});
