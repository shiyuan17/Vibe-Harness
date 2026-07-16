import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createInstallPlan } from '../scripts/lib/install-planner.js';
import { loadAllManifests, readJson } from '../scripts/lib/manifest.js';
import * as packValidation from '../scripts/lib/pack-validation.js';

const rootDir = path.resolve('.');
const routingRuleSource = 'rules/agent-skill-routing.md';
const routingRuleTarget = 'docs/rules/AGENT_SKILL_ROUTING.md';

test('agent skill routing policy preserves governance priority and lifecycle routing', async () => {
  const rule = await readFile(path.join(rootDir, routingRuleSource), 'utf8');

  for (const term of [
    '不得覆盖',
    '一个流程 Skill',
    '一个领域 Skill',
    '一个验证或审查 Skill',
    'Clarify',
    'Spec',
    'Plan',
    'Tasks',
    'Execute',
    'Verify',
    'Review',
    'Handoff',
    'Retrospective',
    'OpenCodeReview',
    'fallback',
    'Memory',
    'using-loopengine',
  ]) {
    assert.equal(rule.includes(term), true, `routing policy should document ${term}`);
  }
  assert.match(rule, /营销.*`taste-skill`/u);
  assert.match(rule, /产品 UI.*`impeccable`/u);
  assert.match(rule, /方向不明确.*`frontend-design`/u);
});

test('agent skill routing policy is registered, installable, and tracked by capability evidence', async () => {
  const manifests = await loadAllManifests(rootDir);
  const installMap = await readJson(path.join(rootDir, 'adapters/codex/install-map.json'));
  const capabilities = await readJson(path.join(rootDir, 'manifests/capabilities.json'));

  assert.deepEqual(
    manifests.rules.items.find((item) => item.id === 'agent-skill-routing'),
    { id: 'agent-skill-routing', source: routingRuleSource },
  );
  assert.deepEqual(
    installMap.entries.find((entry) => entry.source === routingRuleSource),
    { contentStrategy: 'replace', group: 'rules-minimal', source: routingRuleSource, target: routingRuleTarget },
  );

  const capability = capabilities.items.find((item) => item.id === 'skill-routing');
  assert.equal(capability.targets.includes(routingRuleSource), true);
  assert.equal(capability.targets.includes('skills/core/using-loopengine/SKILL.md'), true);
  assert.equal(capability.tests.includes('tests/agent-skill-routing.test.js'), true);
});

test('all profiles install the routing policy while only skill profiles install the router', async () => {
  for (const profile of ['minimal', 'core', 'full', 'codex-minimal', 'codex-internal', 'docs-only']) {
    const plan = await createInstallPlan({
      dryRun: true,
      profile,
      rootDir,
      targetDir: path.join(rootDir, `.tmp-routing-${profile}`),
    });
    const targets = new Set(plan.actions.map((action) => action.relativeTarget));
    assert.equal(targets.has(routingRuleTarget), true, `${profile} should install the routing policy`);
    assert.equal(
      targets.has('.agents/skills/using-loopengine/SKILL.md'),
      !['minimal', 'codex-minimal', 'docs-only'].includes(profile),
      `${profile} router installation should match its skill surface`,
    );
  }
});

test('AGENTS and using-loopengine link the policy and document the no-skill fallback', async () => {
  const [agents, router] = await Promise.all([
    readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8'),
    readFile(path.join(rootDir, 'skills/core/using-loopengine/SKILL.md'), 'utf8'),
  ]);

  assert.equal(agents.includes(routingRuleTarget), true);
  assert.match(agents, /Skills 未安装时.*fallback/u);
  assert.equal(router.includes(routingRuleTarget), true);
});

test('brainstorming only gates tasks with unresolved high-impact design choices', async () => {
  const content = await readFile(path.join(rootDir, 'skills/core/brainstorming/SKILL.md'), 'utf8');
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? '';
  assert.match(frontmatter, /高影响歧义/u);
  assert.doesNotMatch(frontmatter, /任何创造性工作/u);
  assert.match(content, /已有决策完整规格.*不触发/u);
  assert.match(content, /纯修复.*不触发/u);
});

test('pack quality rejects routing policy registration, evidence, and link drift', async () => {
  const validate = packValidation.validateAgentSkillRoutingIntegrity;
  assert.equal(typeof validate, 'function', 'pack validation should expose the routing integrity gate');

  const [agentsContent, routerContent, ruleContent, manifests, installMap, capabilityMatrix] = await Promise.all([
    readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8'),
    readFile(path.join(rootDir, 'skills/core/using-loopengine/SKILL.md'), 'utf8'),
    readFile(path.join(rootDir, routingRuleSource), 'utf8'),
    loadAllManifests(rootDir),
    readJson(path.join(rootDir, 'adapters/codex/install-map.json')),
    readJson(path.join(rootDir, 'manifests/capabilities.json')),
  ]);
  const valid = {
    agentsContent,
    capabilityMatrix,
    installEntries: installMap.entries,
    routerContent,
    ruleContent,
    ruleItems: manifests.rules.items,
  };

  assert.deepEqual(validate(valid), []);
  assert.match(validate({ ...valid, ruleItems: [] }).join('\n'), /registered in manifests\/rules\.json/u);
  assert.match(validate({ ...valid, installEntries: [] }).join('\n'), /rules-minimal/u);
  assert.match(validate({ ...valid, capabilityMatrix: { schemaVersion: 2, items: [] } }).join('\n'), /skill-routing capability/u);
  assert.doesNotThrow(() => validate({ ...valid, capabilityMatrix: {} }));
  assert.match(validate({ ...valid, capabilityMatrix: {} }).join('\n'), /skill-routing capability/u);
  assert.match(validate({ ...valid, routerContent: '# router' }).join('\n'), /router must reference/u);
  assert.match(validate({ ...valid, ruleContent: '# policy' }).join('\n'), /policy must reference/u);
  assert.match(validate({ ...valid, agentsContent: '# AGENTS' }).join('\n'), /AGENTS template must reference/u);
});
