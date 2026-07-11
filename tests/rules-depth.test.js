import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('profiles install minimal, common, and full surfaces at intended tiers', async () => {
  const targets = async (profile) => new Set((await createInstallPlan({ dryRun: true, profile, rootDir, targetDir: path.join(rootDir, '.tmp-profile-check') })).actions.map((item) => item.relativeTarget));
  const minimal = await targets('minimal');
  const core = await targets('core');
  const full = await targets('full');
  assert.equal(minimal.has('docs/rules/governance-core.md'), true);
  assert.equal(minimal.has('docs/rules/coding-rules.md'), false);
  assert.equal([...minimal].some((item) => item.startsWith('.agents/skills/')), false);
  assert.equal(core.has('docs/rules/coding-rules.md'), true);
  assert.equal(core.has('.agents/skills/using-loopengine/SKILL.md'), true);
  assert.equal(core.has('.agents/skills/adversarial-review-packet/SKILL.md'), true);
  assert.equal(core.has('docs/rules/codebase-memory-mcp.md'), false);
  assert.equal(core.has('.agents/skills/agentmemory/SKILL.md'), false);
  assert.equal(core.has('.codex/hooks.json'), false);
  assert.equal(full.has('.agents/skills/adversarial-review-packet/SKILL.md'), true);
  assert.equal(full.has('docs/rules/codebase-memory-mcp.md'), true);
  assert.equal(full.has('.agents/skills/agentmemory/SKILL.md'), true);
  assert.equal(full.has('.agents/memory/README.md'), true);
  assert.equal(full.has('.codex/hooks.json'), true);
  assert.equal(full.has('docs/rules/coding-rules.md'), true);
  assert.equal([...full].some((item) => item.includes('karpathy-guidelines')), false);
});

test('router only names registered skills', async () => {
  const manifests = await loadAllManifests(rootDir);
  const registered = new Set(manifests.skills.items.map((item) => item.id));
  const router = manifests.skills.items.find((item) => item.id === 'using-loopengine');
  for (const id of [...router.requiresSkills, ...router.optionalSkills]) assert.equal(registered.has(id), true, `${id} should be registered`);
});

test('rules absorb pruned thin skill guidance', async () => {
  const [coding, git, projectDirectory, frontend, release, pencil] = await Promise.all([
    readFile(path.join(rootDir, 'rules/coding-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/git-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/project-directory.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/frontend-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/release-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/pencil-rules.md'), 'utf8'),
  ]);

  assert.match(coding, /characterization test/u);
  assert.match(git, /验证只来自临时 worktree/u);
  assert.match(projectDirectory, /ADR/u);
  assert.match(frontend, /品牌展示|产品界面/u);
  assert.match(release, /本 skill 不维护第二套发布规则|规则是真值/u);
  assert.match(pencil, /同名预览|截图/u);
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
