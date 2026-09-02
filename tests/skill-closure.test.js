import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createInstallPlan, renderActionContent } from '../scripts/lib/install-planner.js';
import { readJson } from '../scripts/lib/manifest.js';
import { runSkillsAudit } from '../scripts/lib/skills-audit.js';

const rootDir = path.resolve(import.meta.dirname, '..');
const execFileAsync = promisify(execFile);
const coreSkills = ['clarify-requirements', 'define-goal', 'git-deliver', 'systematic-debugging', 'eval-driven-development', 'security-and-hardening'];
const fullSkills = ['api-and-interface-design', 'frontend-design', 'runtime-cross-repo-rollout'];
const nativeSkills = [...coreSkills, ...fullSkills];
const retiredSkills = [
  'using-vibe-harness', 'brainstorming', 'writing-plans', 'executing-plans', 'test-driven-development',
  'verification-before-completion', 'code-review-and-quality', 'adversarial-review-packet',
  'loop-planning', 'subagent-driven-development',
];

test('manifest exposes nine native and three explicit integration Skills', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  assert.deepEqual(manifest.items.filter((item) => item.kind === 'native').map((item) => item.id), nativeSkills);
  assert.deepEqual(manifest.items.filter((item) => item.kind === 'integration').map((item) => item.id), ['browser-verification', 'agentmemory', 'linear-workflow']);
  assert.equal(manifest.items.length, 12);
  for (const item of manifest.items) {
    assert.deepEqual(item.requiresSkills, []);
    assert.deepEqual(item.optionalSkills, []);
  }
});

test('git-deliver remains explicit and preserves Git safety boundaries', async () => {
  const directory = path.join(rootDir, 'skills/core/git-deliver');
  const [content, metadata, openai] = await Promise.all([
    readFile(path.join(directory, 'SKILL.md'), 'utf8'),
    readJson(path.join(directory, 'metadata.json')),
    readFile(path.join(directory, 'agents/openai.yaml'), 'utf8'),
  ]);
  assert.equal(metadata.triggers.includes('$git-deliver'), true);
  assert.match(openai, /allow_implicit_invocation: false/u);
  for (const term of ['归属不明', 'staged diff', 'no-verify', 'upstream', 'origin', 'main', 'master', 'develop', 'release', 'force push', '推送失败时保留本地提交']) {
    assert.match(content, new RegExp(term, 'u'));
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
    assert.ok(lineCount <= 50, `${item.id} line budget`);
    const yaml = await readFile(path.join(skillDir, 'agents/openai.yaml'), 'utf8');
    assert.match(yaml, /allow_implicit_invocation: (?:true|false)/u);
    assert.equal(yaml.includes('allow_implicit_invocation: false'), item.id === 'git-deliver');
    assert.match(yaml, new RegExp(`\\$${item.id}`, 'u'));
    const resources = (await readdir(skillDir)).filter((name) => !['SKILL.md', 'metadata.json', 'agents'].includes(name));
    assert.ok(resources.length <= 2, `${item.id} resource budget`);
  }
  assert.ok(lines <= 250);
  // Mirrors the pack-validation identity budget: 1300 characters is calibrated
  // for English descriptions and stays well under the Chinese-era surface in
  // token terms (CJK characters carry ~3 bytes and ~1 token each).
  assert.ok(identityCharacters <= 1300);
});

test('core and full install exactly six and nine native Skills', async () => {
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
  const agents = browser.actions.find((entry) => entry.relativeTarget === 'AGENTS.md');
  const agentsContent = await renderActionContent(agents, browser.renderData);
  assert.match(agentsContent, /integration Skills：browser-verification/u);
  assert.match(agentsContent, /不计入 profile 的原生领域 Skill 数量/u);

  const memory = await createInstallPlan({ dryRun: true, requestedModules: ['memory'], profile: 'full', rootDir, targetDir: path.join(rootDir, '.tmp-skills-memory') });
  assert.equal(memory.actions.some((entry) => entry.relativeTarget === '.agents/skills/agentmemory/SKILL.md'), true);
  const memoryAgents = memory.actions.find((entry) => entry.relativeTarget === 'AGENTS.md');
  const memoryAgentsContent = await renderActionContent(memoryAgents, memory.renderData);
  assert.match(memoryAgentsContent, /integration Skills：agentmemory/u);
  assert.match(memoryAgentsContent, /不计入 profile 的原生领域 Skill 数量/u);

  const combined = await createInstallPlan({ dryRun: true, requestedModules: ['playwright', 'memory'], profile: 'full', rootDir, targetDir: path.join(rootDir, '.tmp-skills-combined') });
  assert.equal(combined.actions.some((entry) => entry.relativeTarget === '.agents/skills/browser-verification/SKILL.md'), true);
  assert.equal(combined.actions.some((entry) => entry.relativeTarget === '.agents/skills/agentmemory/SKILL.md'), true);
  const combinedAgents = combined.actions.find((entry) => entry.relativeTarget === 'AGENTS.md');
  const combinedAgentsContent = await renderActionContent(combinedAgents, combined.renderData);
  assert.match(combinedAgentsContent, /integration Skills：browser-verification、agentmemory/u);
  assert.match(combinedAgentsContent, /不计入 profile 的原生领域 Skill 数量/u);
});

test('Linear integration remains explicit and installs its complete reference closure', async () => {
  const plain = await createInstallPlan({ dryRun: true, profile: 'full', rootDir, targetDir: path.join(rootDir, '.tmp-skills-linear-plain') });
  assert.equal(plain.actions.some((entry) => entry.relativeTarget === '.agents/skills/linear-workflow/SKILL.md'), false);

  const linear = await createInstallPlan({
    dryRun: true,
    requestedPlugins: ['linear-mcp'],
    profile: 'core',
    rootDir,
    targetDir: path.join(rootDir, '.tmp-skills-linear'),
  });
  const targets = new Set(linear.actions.map((entry) => entry.relativeTarget.replaceAll('\\', '/')));
  for (const reference of ['ai-coding-task.md', 'workspace-setup.md', 'triage-template.md', 'dag-parent.md', 'execution-receipt.md', 'release-issue.md']) {
    assert.equal(targets.has('.agents/skills/linear-workflow/references/' + reference), true, reference);
  }
  assert.equal(targets.has('.agents/skills/linear-workflow/SKILL.md'), true);
  const agents = linear.actions.find((entry) => entry.relativeTarget === 'AGENTS.md');
  assert.match(await renderActionContent(agents, linear.renderData), /integration Skills：linear-workflow/u);
});

test('retirement catalog covers every removed Router and flow Skill', async () => {
  const installMap = await readJson(path.join(rootDir, 'adapters/install-map.json'));
  const retired = new Set(installMap.retiredEntries.map((entry) => entry.target));
  for (const skill of retiredSkills) assert.equal(retired.has(`.agents/skills/${skill}/SKILL.md`), true, skill);
  for (const skill of retiredSkills) assert.equal(installMap.entries.some((entry) => entry.source?.includes(`/skills/${skill}/`)), false, skill);
});

test('skills audit derives the compact inventory and executes the graph validator', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/skills-audit.js'], { cwd: rootDir });
  assert.match(stdout, /总数：12/u);
  assert.match(stdout, /native：9/u);
  assert.match(stdout, /integration：3/u);
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
