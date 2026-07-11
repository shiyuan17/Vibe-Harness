import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createInstallPlan } from '../scripts/lib/install-planner.js';
import { loadAllManifests, readJson } from '../scripts/lib/manifest.js';
import { scanForForbiddenTerms } from '../scripts/lib/redaction.js';

const rootDir = path.resolve('.');

test('canonical governance and routed skills are declared', async () => {
  const manifests = await loadAllManifests(rootDir);
  const rules = new Set(manifests.rules.items.map((item) => item.id));
  const skills = new Set(manifests.skills.items.map((item) => item.id));
  for (const id of ['governance-core', 'codebase-memory-mcp', 'git-rules', 'test-rules']) assert.equal(rules.has(id), true);
  for (const id of ['using-loopengine', 'verification-before-completion', 'code-review-and-quality', 'adversarial-review-packet']) assert.equal(skills.has(id), true);
});

test('profiles install fallback, routed, and full-only surfaces at intended tiers', async () => {
  const targets = async (profile) => new Set((await createInstallPlan({ dryRun: true, profile, rootDir, targetDir: path.join(rootDir, '.tmp-profile-check') })).actions.map((item) => item.relativeTarget));
  const minimal = await targets('minimal');
  const core = await targets('core');
  const full = await targets('full');
  assert.equal(minimal.has('docs/rules/governance-core.md'), true);
  assert.equal(minimal.has('docs/rules/coding-rules.md'), false);
  assert.equal([...minimal].some((item) => item.startsWith('.agents/skills/')), false);
  assert.equal(core.has('docs/rules/coding-rules.md'), true);
  assert.equal(core.has('.agents/skills/using-loopengine/SKILL.md'), true);
  assert.equal(core.has('.agents/skills/adversarial-review-packet/SKILL.md'), false);
  assert.equal(full.has('.agents/skills/adversarial-review-packet/SKILL.md'), true);
  assert.equal(full.has('docs/rules/coding-rules.md'), true);
  assert.equal([...full].some((item) => item.includes('karpathy-guidelines')), false);
});

test('router only names registered skills', async () => {
  const manifests = await loadAllManifests(rootDir);
  const registered = new Set(manifests.skills.items.map((item) => item.id));
  const router = manifests.skills.items.find((item) => item.id === 'using-loopengine');
  for (const id of [...router.requiresSkills, ...router.optionalSkills]) assert.equal(registered.has(id), true, `${id} should be registered`);
});

test('reusable assets do not leak source project terms', async () => {
  const leaks = await scanForForbiddenTerms({
    forbiddenTerms: ['SYBaseProjectWeb', 'SYBaseProject', 'D:\\Github\\JW', 'T-019', '患者', '病理'],
    includeDirs: ['rules', 'templates', 'skills/core', 'skills/integrations', 'memory', 'adapters/codex', 'manifests', 'schemas'],
    rootDir,
  });
  assert.deepEqual(leaks, []);
  assert.equal((await readJson(path.join(rootDir, 'manifests/profiles.json'))).items.length >= 3, true);
});
