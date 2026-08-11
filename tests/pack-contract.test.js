import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePackageFiles } from '../scripts/lib/pack-contract.js';

const validFiles = [
  'CHANGELOG.md',
  'LICENSE',
  'README.en.md',
  'README.md',
  'package.json',
  'scripts/vibe-harness.js',
  'adapters/codex/AGENTS.template.md',
  'manifests/profiles.json',
  'rules/governance-core.md',
  'runtime/hooks/codex-hook.mjs',
  'schemas/project-config.schema.json',
  'skills/core/example/SKILL.md',
  'templates/delivery.md',
];

test('package contract accepts the complete reusable surface', () => {
  const report = validatePackageFiles(validFiles.map((path) => ({ path })));
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
});

test('package contract rejects missing surfaces and local evidence', () => {
  const report = validatePackageFiles([
    ...validFiles.filter((item) => !item.startsWith('runtime/')),
    '.codex/better-harness/report.html',
    '.env.local',
    '.npmrc',
    'runtime/tools/example/node_modules/package/index.js',
    'tests/private-fixture.json',
    'vibe-harness.config.json',
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.errors.some((item) => item.includes('runtime/')), true);
  assert.equal(report.errors.some((item) => item.includes('better-harness')), true);
  assert.equal(report.errors.some((item) => item.includes('node_modules')), true);
  assert.equal(report.errors.some((item) => item.includes('tests/')), true);
  assert.equal(report.errors.some((item) => item.includes('.env.local')), true);
  assert.equal(report.errors.some((item) => item.includes('.npmrc')), true);
  assert.equal(report.errors.some((item) => item.includes('vibe-harness.config.json')), true);
});
