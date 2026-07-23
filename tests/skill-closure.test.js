import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createInstallPlan } from '../scripts/lib/install-planner.js';
import { readJson } from '../scripts/lib/manifest.js';
import { runSkillsAudit } from '../scripts/lib/skills-audit.js';

const rootDir = path.resolve('.');
const execFileAsync = promisify(execFile);
const coreSkills = ['clarify-requirements', 'systematic-debugging', 'eval-driven-development', 'security-and-hardening'];
const fullSkills = ['api-and-interface-design', 'frontend-design', 'runtime-cross-repo-rollout'];
const nativeSkills = [...coreSkills, ...fullSkills];
const retiredSkills = [
  'using-cognis', 'brainstorming', 'writing-plans', 'executing-plans', 'test-driven-development',
  'verification-before-completion', 'code-review-and-quality', 'adversarial-review-packet',
  'loop-planning', 'subagent-driven-development',
];

test('manifest exposes seven native and two explicit integration Skills', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  assert.deepEqual(manifest.items.filter((item) => item.kind === 'native').map((item) => item.id), nativeSkills);
  assert.deepEqual(manifest.items.filter((item) => item.kind === 'integration').map((item) => item.id), ['browser-verification', 'agentmemory']);
  assert.equal(manifest.items.length, 9);
  for (const item of manifest.items) {
    assert.deepEqual(item.requiresSkills, []);
    assert.deepEqual(item.optionalSkills, []);
  }
});

test('native Skill descriptions, bodies, resources, and OpenAI metadata stay within budget', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  let lines = 0;
  let identityCharacters = 0;
  for (const item of manifest.items.filter((candidate) => candidate.kind === 'native')) {
    const skillDir = path.dirname(path.join(rootDir, item.source));
    const content = await readFile(path.join(rootDir, item.source), 'utf8');
    const description = content.match(/^description:\s*(.+)$/mu)?.[1] ?? '';
    const lineCount = content.split(/\r?\n/u).length;
    lines += lineCount;
    identityCharacters += item.id.length + description.length;
    assert.ok(description.length <= 300, `${item.id} description budget`);
    assert.ok(lineCount <= 35, `${item.id} line budget`);
    const yaml = await readFile(path.join(skillDir, 'agents/openai.yaml'), 'utf8');
    assert.match(yaml, /allow_implicit_invocation: true/u);
    assert.match(yaml, new RegExp(`\\$${item.id}`, 'u'));
    const resources = (await readdir(skillDir)).filter((name) => !['SKILL.md', 'metadata.json', 'agents'].includes(name));
    assert.ok(resources.length <= 2, `${item.id} resource budget`);
  }
  assert.ok(lines <= 250);
  assert.ok(identityCharacters <= 900);
});

test('core and full install exactly four and seven native Skills', async () => {
  for (const [profile, expected] of [['core', coreSkills], ['full', nativeSkills]]) {
    const plan = await createInstallPlan({ dryRun: true, profile, rootDir, targetDir: path.join(rootDir, `.tmp-skills-${profile}`) });
    const installed = plan.actions
      .map((entry) => entry.relativeTarget.replaceAll('\\', '/'))
      .filter((target) => /^\.agents\/skills\/[^/]+\/SKILL\.md$/u.test(target))
      .map((target) => target.split('/')[2]);
    assert.deepEqual(new Set(installed), new Set(expected));
    assert.equal(installed.some((id) => retiredSkills.includes(id)), false);
  }
});

test('browser verification and Agentmemory remain explicit integrations', async () => {
  const plain = await createInstallPlan({ dryRun: true, profile: 'full', rootDir, targetDir: path.join(rootDir, '.tmp-skills-plain') });
  const plainTargets = new Set(plain.actions.map((entry) => entry.relativeTarget));
  assert.equal(plainTargets.has('.agents/skills/browser-verification/SKILL.md'), false);
  assert.equal(plainTargets.has('.agents/skills/agentmemory/SKILL.md'), false);

  const browser = await createInstallPlan({ dryRun: true, requestedModules: ['playwright'], profile: 'core', rootDir, targetDir: path.join(rootDir, '.tmp-skills-browser') });
  assert.equal(browser.actions.some((entry) => entry.relativeTarget === '.agents/skills/browser-verification/SKILL.md'), true);
  const memory = await createInstallPlan({ dryRun: true, requestedModules: ['memory'], profile: 'full', rootDir, targetDir: path.join(rootDir, '.tmp-skills-memory') });
  assert.equal(memory.actions.some((entry) => entry.relativeTarget === '.agents/skills/agentmemory/SKILL.md'), true);
});

test('retirement catalog covers every removed Router and flow Skill', async () => {
  const installMap = await readJson(path.join(rootDir, 'adapters/codex/install-map.json'));
  const retired = new Set(installMap.retiredEntries.map((entry) => entry.target));
  for (const skill of retiredSkills) assert.equal(retired.has(`.agents/skills/${skill}/SKILL.md`), true, skill);
  for (const skill of retiredSkills) assert.equal(installMap.entries.some((entry) => entry.source?.includes(`/skills/${skill}/`)), false, skill);
});

test('skills audit derives the compact inventory and executes the graph validator', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/skills-audit.js'], { cwd: rootDir });
  assert.match(stdout, /总数：9/u);
  assert.match(stdout, /native：7/u);
  assert.match(stdout, /integration：2/u);
  assert.match(stdout, /router：0/u);
  assert.deepEqual((await runSkillsAudit(rootDir)).errors, []);
});

test('debugging keeps only the deterministic polluter helper as an on-demand resource', async () => {
  const directory = path.join(rootDir, 'skills/core/systematic-debugging');
  const files = await readdir(directory, { recursive: true });
  assert.equal(files.includes('find-polluter.sh'), true);
  for (const removed of ['root-cause-tracing.md', 'condition-based-waiting.md', 'defense-in-depth.md', 'references/failure.md']) {
    assert.equal(files.includes(removed), false);
  }
});
