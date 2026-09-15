import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInstallPlan, renderActionContent } from '../scripts/lib/install-planner.js';
import { loadAllManifests, readJson } from '../scripts/lib/manifest.js';
import { validateRuleCrossReferences, validateRulePortability } from '../scripts/lib/pack-validation.js';
import { scanForForbiddenTerms } from '../scripts/lib/redaction.js';
import { assertRuleAnchors } from './helpers/governed-docs.js';

const rootDir = path.resolve(import.meta.dirname, '..');
const coreSkills = ['clarify-requirements', 'define-goal', 'task-decomposition', 'git-deliver', 'systematic-debugging', 'bug-finding', 'stale-cleanup', 'eval-driven-development', 'security-and-hardening'];
const fullSkills = [...coreSkills, 'api-and-interface-design', 'frontend-design', 'runtime-cross-repo-rollout'];

test('canonical governance and twelve native Skills are declared', async () => {
  const manifests = await loadAllManifests(rootDir);
  const rules = new Set(manifests.rules.items.map((item) => item.id));
  for (const id of ['governance-core', 'git-rules', 'test-rules', 'agent-skill-routing']) assert.equal(rules.has(id), true);
  assert.deepEqual(manifests.skills.items.filter((item) => item.kind === 'native').map((item) => item.id), fullSkills);
});

test('completion evidence and task-scoped testing live in governance rules', async () => {
  await assertRuleAnchors(rootDir, [
    'docs/rules/governance-core.md',
    'docs/rules/test-rules.md',
    'docs/rules/troubleshooting.md',
    'docs/rules/project-directory.md',
    'docs/rules/git-rules.md',
    'templates/task.md',
    'templates/task.en-US.md',
    'adapters/codex/AGENTS.template.md',
    'adapters/claude/CLAUDE.template.md',
    'adapters/gemini/GEMINI.template.md',
  ]);

  // A delivery may cite only a verification sample taken after the last
  // substantive change, so the worked example has to keep that order.
  const kernel = await readFile(path.join(rootDir, 'docs/rules/governance-core.md'), 'utf8');
  const taskExample = kernel.match(/10:00[\s\S]*10:05[\s\S]*10:07[\s\S]*交付只能引用 10:07/u)?.[0];
  assert.ok(taskExample, 'governance-core must keep its verification-attribution example');
  assert.ok(taskExample.indexOf('10:00') < taskExample.indexOf('10:05'));
  assert.ok(taskExample.indexOf('10:05') < taskExample.indexOf('10:07'));
});

test('OBS-RULE-001 observability guidance stays concise and enforces behavior', async () => {
  const rule = await readFile(path.join(rootDir, 'docs/rules/log-management.md'), 'utf8');
  const lines = rule.trimEnd().split(/\r?\n/u);
  assert.ok(lines.length <= 60, 'log-management.md exceeds 60 lines: ' + lines.length);
  assert.deepEqual(lines.filter((line) => line.startsWith('## ')), [
    '## 目标与边界',
    '## 最小字段与关联',
    '## 指标与追踪底线',
    '## 安全与可靠性',
    '## 排障与验收',
  ]);
  await assertRuleAnchors(rootDir, ['docs/rules/log-management.md']);

  // Anti-drift: the rule stays a boundary contract, not a vendor feature tour,
  // a config dump, or a project-specific example.
  assert.doesNotMatch(rule, /https?:\/\//u);
  assert.doesNotMatch(rule, /OpenTelemetry|observedTimestamp|instrumentationScope|severityNumber|四个黄金信号|错误预算|多窗口|WAL|尾部采样|Eval 的 durationMs/u);
  assert.doesNotMatch(rule, /^\s+\{.*\}\s*$/mu);
  assert.doesNotMatch(rule, /ORDER_CREATE_FAILED|orders|req-123/u);
});

test('generic rules constrain process while retaining safety boundaries', async () => {
  const names = [
    'ai-collab-rules', 'ast-grep', 'chrome-devtools-mcp', 'codebase-memory-mcp',
    'coding-rules', 'frontend-rules', 'git-rules', 'log-management',
    'project-directory', 'release-rules', 'role-routing', 'rtk', 'test-rules', 'troubleshooting',
  ];
  await assertRuleAnchors(rootDir, names.map((name) => `docs/rules/${name}.md`));

  // Anti-drift: process scaffolding these rules deliberately reject. Each entry
  // is a gate a future edit could reintroduce by accident.
  const rejected = new Map([
    ['codebase-memory-mcp', /full\/internal profile|full profile.*安装/u],
    ['frontend-rules', /设计令牌系统必须存在|超过 50 项列表虚拟化|启用 CSP 与可信类型/u],
    ['project-directory', /跨模块边界变化必须创建 ADR/u],
    ['git-rules', /一个实现任务对应一个命名分支 worktree/u],
    ['release-rules', /tgz|SHA256|npm publish/u],
  ]);
  for (const [name, pattern] of rejected) {
    const content = await readFile(path.join(rootDir, 'docs/rules', name + '.md'), 'utf8');
    assert.doesNotMatch(content, pattern, name);
  }

  // A rule that cites another rule must stay honest about what the target
  // project has: `linear-workflow` is an integration rule, so git-rules may
  // only defer to it conditionally instead of assuming it is installed.
  const gitRules = await readFile(path.join(rootDir, 'docs/rules/git-rules.md'), 'utf8');
  const linearReferences = gitRules.split(/\r?\n/u).filter((line) => line.includes('`linear-workflow.md`'));
  assert.ok(linearReferences.length > 0, 'git-rules must cite linear-workflow.md for the branch model');
  for (const line of linearReferences) {
    assert.match(line, /若项目已安装该规则/u);
  }
});

test('portable rules stay free of repository-private references', async () => {
  assert.deepEqual(await validateRulePortability(rootDir), []);

  const pack = await mkdtemp(path.join(tmpdir(), 'vibe-rules-portability-'));
  try {
    await mkdir(path.join(pack, 'docs/rules'), { recursive: true });
    await writeFile(path.join(pack, 'docs/rules/portable.md'), '# Portable\n\n见 CONTRIBUTING.md 与 pnpm verify:focused。\n', 'utf8');
    const errors = await validateRulePortability(pack);
    assert.ok(errors.some((error) => error.includes('CONTRIBUTING.md')), JSON.stringify(errors));
    assert.ok(errors.some((error) => error.includes('repository script')), JSON.stringify(errors));
  } finally {
    await rm(pack, { force: true, recursive: true });
  }
});

test('the rendered project-specific rule file is exempt from the portability gate', async () => {
  const pack = await mkdtemp(path.join(tmpdir(), 'vibe-rules-portability-exempt-'));
  try {
    await mkdir(path.join(pack, 'docs/rules'), { recursive: true });
    // Carrying the target project's own commands and docs is the whole job of
    // this rendered file, so the private-reference gate must skip it.
    await writeFile(path.join(pack, 'docs/rules/project-specific-rules.md'), '# 项目规则\n\n- Lint：`pnpm lint`，见 CONTRIBUTING.md\n', 'utf8');
    assert.deepEqual(await validateRulePortability(pack), []);
  } finally {
    await rm(pack, { force: true, recursive: true });
  }
});

test('sibling rule references must resolve inside docs/rules', async () => {
  assert.deepEqual(await validateRuleCrossReferences(rootDir), []);

  const pack = await mkdtemp(path.join(tmpdir(), 'vibe-rules-cross-reference-'));
  try {
    await mkdir(path.join(pack, 'docs/rules'), { recursive: true });
    await writeFile(path.join(pack, 'docs/rules/alpha.md'), '# Alpha\n\n完整规范见 `beta.md` 与 `gamma.md`。\n', 'utf8');
    // Path-qualified references are not sibling references, so they stay out of
    // this contract even though they are also written in backticks.
    await writeFile(path.join(pack, 'docs/rules/beta.md'), '# Beta\n\n见 `.agents/memory/decisions.md`、`docs/rules/alpha.md` 与 `roles/prompts/<role-id>.md`。\n', 'utf8');
    assert.deepEqual(await validateRuleCrossReferences(pack), ['docs/rules/alpha.md references missing rule gamma.md']);
  } finally {
    await rm(pack, { force: true, recursive: true });
  }
});

test('profiles install zero, nine, or twelve native Skills at intended tiers', async () => {
  for (const [profile, expected] of [['minimal', []], ['docs-only', []], ['core', coreSkills], ['full', fullSkills]]) {
    const plan = await createInstallPlan({ dryRun: true, profile, rootDir, targetDir: path.join(rootDir, `.tmp-depth-${profile}`) });
    const targets = new Set(plan.actions.map((item) => item.relativeTarget));
    const installed = fullSkills.filter((skill) => targets.has(`.agents/skills/${skill}/SKILL.md`));
    assert.deepEqual(installed, expected);
    assert.equal(targets.has('.agents/skills/agentmemory/SKILL.md'), false);
    assert.equal(targets.has('.agents/memory/README.md'), false);
    assert.equal(targets.has('.codex/hooks.json'), profile === 'full');
  }
});

test('installed native Skills preserve the same dependency-free contracts across adapters', async () => {
  for (const adapterId of ['codex', 'claude', 'gemini']) {
    const plan = await createInstallPlan({ adapterId, dryRun: true, profile: 'core', rootDir, targetDir: path.join(rootDir, `.tmp-depth-${adapterId}`) });
    for (const skill of coreSkills) {
      const action = plan.actions.find((item) => item.relativeSource === `skills/core/${skill}/SKILL.md`);
      assert.ok(action);
      assert.match(await renderActionContent(action, plan.renderData), new RegExp(`name: ${skill}`, 'u'));
    }
    assert.equal(plan.actions.some((item) => item.relativeTarget.endsWith('/agents/openai.yaml')), adapterId === 'codex');
  }
});

test('reusable assets stay generic and source mapping points to existing assets', async () => {
  const leaks = await scanForForbiddenTerms({
    forbiddenTerms: ['SYBaseProjectWeb', 'SYBaseProject', 'D:\\Github\\JW', 'T-019', '患者', '病理'],
    includeDirs: ['rules', 'templates', 'skills/core', 'skills/integrations', 'memory', 'adapters/codex', 'adapters/claude', 'adapters/gemini', 'manifests', 'schemas'],
    rootDir,
  });
  assert.deepEqual(leaks, []);
  const mapping = await readFile(path.join(rootDir, 'docs/inventory/source-rules-mapping.md'), 'utf8');
  assert.match(mapping, /Skill descriptions/u);
  assert.equal((await readJson(path.join(rootDir, 'manifests/profiles.json'))).items.length, 4);
});
