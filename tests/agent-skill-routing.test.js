import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createInstallPlan } from '../scripts/lib/install-planner.js';
import { loadAllManifests, readJson } from '../scripts/lib/manifest.js';
import { validateAgentSkillRoutingIntegrity } from '../scripts/lib/pack-validation.js';

const rootDir = path.resolve('.');
const routingRuleSource = 'rules/agent-skill-routing.md';
const routingRuleTarget = 'docs/rules/AGENT_SKILL_ROUTING.md';
const nativeSkills = [
  'clarify-requirements',
  'systematic-debugging',
  'eval-driven-development',
  'security-and-hardening',
  'api-and-interface-design',
  'frontend-design',
  'runtime-cross-repo-rollout',
];

test('routing policy delegates directly to one description-selected native Skill', async () => {
  const rule = await readFile(path.join(rootDir, routingRuleSource), 'utf8');
  for (const term of ['description', '不使用 Router', '同一阶段默认只加载一个 Skill', '计划', 'Review', '多 Agent', 'Red Team']) {
    assert.equal(rule.includes(term), true, `routing policy should document ${term}`);
  }
  for (const retired of ['using-cognis', 'brainstorming', 'writing-plans', 'verification-before-completion']) {
    assert.equal(rule.includes(retired), false, `routing policy must not retain ${retired}`);
  }
  for (const skill of nativeSkills) assert.equal(rule.includes(`\`${skill}\``), true);
});

test('native Skill set has no Router, compatibility aliases, or dependency chain', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  const native = manifest.items.filter((item) => item.kind === 'native');
  assert.deepEqual(native.map((item) => item.id), nativeSkills);
  for (const item of native) {
    assert.deepEqual(item.requiresSkills, []);
    assert.deepEqual(item.optionalSkills, []);
  }
  assert.equal(manifest.items.some((item) => ['router', 'compatibility'].includes(item.kind)), false);
});

test('core installs four Skills and full installs all seven without a Router', async () => {
  for (const [profile, expected] of [['minimal', 0], ['docs-only', 0], ['core', 4], ['full', 7]]) {
    const plan = await createInstallPlan({ dryRun: true, profile, rootDir, targetDir: path.join(rootDir, `.tmp-routing-${profile}`) });
    const targets = new Set(plan.actions.map((action) => action.relativeTarget));
    const installed = nativeSkills.filter((skill) => targets.has(`.agents/skills/${skill}/SKILL.md`));
    assert.equal(targets.has(routingRuleTarget), true);
    assert.equal(installed.length, expected);
    assert.equal([...targets].some((target) => target.includes('/using-cognis/')), false);
  }
});

test('OpenAI metadata installs only for Codex', async () => {
  for (const target of ['codex', 'claude', 'gemini']) {
    const plan = await createInstallPlan({ adapterId: target, dryRun: true, profile: 'core', rootDir, targetDir: path.join(rootDir, `.tmp-routing-${target}`) });
    const openaiMetadata = plan.actions.filter((action) => action.relativeTarget.endsWith('/agents/openai.yaml'));
    assert.equal(openaiMetadata.length, target === 'codex' ? 4 : 0);
  }
});

test('routing integrity tracks policy, clarification capability, and native AGENTS text', async () => {
  const [agentsContent, ruleContent, manifests, installMap, capabilityMatrix] = await Promise.all([
    readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8'),
    readFile(path.join(rootDir, routingRuleSource), 'utf8'),
    loadAllManifests(rootDir),
    readJson(path.join(rootDir, 'adapters/codex/install-map.json')),
    readJson(path.join(rootDir, 'manifests/capabilities.json')),
  ]);
  const valid = { agentsContent, capabilityMatrix, installEntries: installMap.entries, ruleContent, ruleItems: manifests.rules.items };
  assert.deepEqual(validateAgentSkillRoutingIntegrity(valid), []);
  assert.match(validateAgentSkillRoutingIntegrity({ ...valid, ruleItems: [] }).join('\n'), /registered/u);
  assert.match(validateAgentSkillRoutingIntegrity({ ...valid, agentsContent: '# AGENTS' }).join('\n'), /AGENTS template/u);
});
