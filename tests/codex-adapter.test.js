import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { readJson } from '../scripts/lib/manifest.js';

const rootDir = path.resolve('.');

test('codex adapter declares AGENTS, rules, templates, skills, and hooks mappings', async () => {
  const installMap = await readJson(path.join(rootDir, 'adapters/codex/install-map.json'));
  const targets = installMap.entries.map((entry) => entry.target);

  assert.ok(targets.includes('AGENTS.md'));
  assert.ok(targets.includes('docs/rules/governance-core.md'));
  assert.ok(targets.includes('docs/templates/task.md'));
  assert.ok(targets.includes('.agents/skills/using-cognis/SKILL.md'));
  assert.ok(targets.includes('.codex/hooks.json'));
  assert.ok(installMap.entries.find((entry) => entry.target === '.codex/hooks.json').redZone);
});

test('codex adapter and plugin metadata track the package version', async () => {
  const pkg = await readJson(path.join(rootDir, 'package.json'));
  const adapter = await readJson(path.join(rootDir, 'adapters/codex/codex-plugin.json'));
  const plugin = await readJson(path.join(rootDir, '.codex-plugin/plugin.json'));
  const hooks = await readJson(path.join(rootDir, 'adapters/codex/hooks.template.json'));

  assert.equal(adapter.version, pkg.version);
  assert.equal(plugin.version, pkg.version);
  assert.equal(Object.hasOwn(hooks, 'notes'), false);
  assert.ok(hooks.hooks.PreToolUse);
  assert.ok(hooks.hooks.PermissionRequest);
  assert.ok(hooks.hooks.Stop);
  assert.equal(Object.hasOwn(hooks.hooks, 'SessionEnd'), false);
});
