import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { readJson } from '../scripts/lib/manifest.js';

const rootDir = path.resolve('.');

test('codex adapter declares AGENTS, rules, templates, skills, and hooks mappings', async () => {
  const installMap = await readJson(path.join(rootDir, 'adapters/codex/install-map.json'));
  const targets = installMap.entries.map((entry) => entry.target);

  assert.ok(targets.includes('AGENTS.md'));
  assert.ok(targets.includes('docs/rules/quickstart.md'));
  assert.ok(targets.includes('docs/templates/task-intake.md'));
  assert.ok(targets.includes('.agents/skills/task-intake/SKILL.md'));
  assert.ok(targets.includes('.codex/hooks.json'));
  assert.ok(installMap.entries.find((entry) => entry.target === '.codex/hooks.json').redZone);
});
