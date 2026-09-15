import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { readJson } from '../scripts/lib/manifest.js';
import { renderTemplate } from '../scripts/lib/template-renderer.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('codex adapter declares AGENTS, rules, templates, skills, and hooks mappings', async () => {
  const installMap = await readJson(path.join(rootDir, 'adapters/install-map.json'));
  const targets = installMap.entries.map((entry) => entry.target);

  assert.ok(targets.includes('AGENTS.md'));
  assert.ok(targets.includes('docs/rules/governance-core.md'));
  assert.ok(targets.includes('docs/templates/task.md'));
  assert.ok(targets.includes('.agents/skills/clarify-requirements/SKILL.md'));
  assert.ok(targets.includes('.agents/skills/clarify-requirements/agents/openai.yaml'));
  assert.ok(targets.includes('.agents/skills/git-deliver/SKILL.md'));
  assert.ok(targets.includes('.agents/skills/git-deliver/agents/openai.yaml'));
  assert.ok(targets.includes('.codex/hooks.json'));
  assert.ok(targets.includes('docs/schemas/execution-envelope.schema.json'));
  assert.ok(targets.includes('docs/schemas/execution-envelope-v2.schema.json'));
  assert.ok(installMap.entries.find((entry) => entry.target === '.codex/hooks.json').redZone);
  assert.equal(targets.some((target) => target.startsWith('.codex/agents/')), false);
});

test('codex adapter and plugin metadata track the package version', async () => {
  const pkg = await readJson(path.join(rootDir, 'package.json'));
  const adapter = await readJson(path.join(rootDir, 'adapters/codex/codex-plugin.json'));
  const plugin = await readJson(path.join(rootDir, '.codex-plugin/plugin.json'));
  const hooks = await readJson(path.join(rootDir, 'adapters/codex/hooks.template.json'));

  assert.equal(adapter.version, pkg.version);
  assert.equal(plugin.version, pkg.version);
  assert.equal(Object.hasOwn(hooks, 'notes'), false);
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PermissionRequest', 'PreToolUse']);
});

test('Codex Hook projection embeds one bootstrap source and no duplicated Windows override', async () => {
  const template = await readFile(path.join(rootDir, 'adapters/codex/hooks.template.json'), 'utf8');
  const rendered = JSON.parse(renderTemplate(template));
  const payload = (await readFile(path.join(rootDir, 'scripts/lib/hook-bootstrap.cjs'), 'utf8')).replace(/\r?\n$/u, '');
  // PreToolUse has to reach every local function tool. The previous matcher was
  // an allowlist of tool names, so a newly added host tool silently skipped the
  // safety policy; `.*` is anchored by the host and keeps the check in one
  // place instead of relying on the special meaning of `*`.
  assert.equal(rendered.hooks.PreToolUse[0].matcher, '.*');
  for (const event of ['PreToolUse', 'PermissionRequest']) {
    const handler = rendered.hooks[event][0].hooks[0];
    assert.equal(handler.type, 'command', event);
    assert.equal(handler.timeout, 10, event);
    // The Windows override only earns its place when it differs from the
    // cross-platform command; an identical copy is removed from the projection.
    assert.equal(Object.hasOwn(handler, 'commandWindows'), false, event);
    assert.equal(handler.command.includes(payload), true, event);
  }
});

test('git-deliver Codex metadata disables implicit invocation', async () => {
  const metadata = await readFile(path.join(rootDir, 'skills/core/git-deliver/agents/openai.yaml'), 'utf8');
  assert.match(metadata, /allow_implicit_invocation: false/u);
});
