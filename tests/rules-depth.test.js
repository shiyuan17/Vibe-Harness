import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createInstallPlan, renderActionContent } from '../scripts/lib/install-planner.js';
import { loadAllManifests, readJson } from '../scripts/lib/manifest.js';
import { scanForForbiddenTerms } from '../scripts/lib/redaction.js';

const rootDir = path.resolve(import.meta.dirname, '..');
const coreSkills = ['clarify-requirements', 'define-goal', 'systematic-debugging', 'eval-driven-development', 'security-and-hardening'];
const fullSkills = [...coreSkills, 'api-and-interface-design', 'frontend-design', 'runtime-cross-repo-rollout'];

test('canonical governance and eight native Skills are declared without a Router', async () => {
  const manifests = await loadAllManifests(rootDir);
  const rules = new Set(manifests.rules.items.map((item) => item.id));
  for (const id of ['governance-core', 'git-rules', 'test-rules', 'agent-skill-routing']) assert.equal(rules.has(id), true);
  assert.deepEqual(manifests.skills.items.filter((item) => item.kind === 'native').map((item) => item.id), fullSkills);
  assert.equal(manifests.skills.items.some((item) => ['router', 'compatibility'].includes(item.kind)), false);
});

test('completion evidence and task-scoped testing live in governance rules', async () => {
  const [kernel, testRules, troubleshootingRules, projectDirectoryRules, taskTemplate, englishTaskTemplate, gitRules, ...templates] = await Promise.all([
    readFile(path.join(rootDir, 'rules/governance-core.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/test-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/troubleshooting.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/project-directory.md'), 'utf8'),
    readFile(path.join(rootDir, 'templates/task.md'), 'utf8'),
    readFile(path.join(rootDir, 'templates/task.en-US.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/git-rules.md'), 'utf8'),
    ...['adapters/codex/AGENTS.template.md', 'adapters/claude/CLAUDE.template.md', 'adapters/gemini/GEMINI.template.md']
      .map((file) => readFile(path.join(rootDir, file), 'utf8')),
  ]);
  assert.match(kernel, /没有本轮有效验证不得声称完成/u);
  assert.match(kernel, /每个有实质修改的任务先按变更类型选择项目已定义的聚焦检查/u);
  assert.match(kernel, /最后一次实质修改后的状态重跑同一检查/u);
  assert.match(kernel, /覆盖同一受影响行为的等价检查及理由/u);
  assert.match(kernel, /handoff 只引用晚于最后一次实质修改的结果/u);
  for (const label of ['已确认事实', '静态结论', '待验证假设', '验证受阻']) assert.match(kernel, new RegExp(label, 'u'));
  for (const sensitive of ['密码', 'Secret', 'Token', 'Cookie', '验证码', '认证头', '会话标识', '个人敏感数据']) {
    assert.match(kernel, new RegExp(sensitive, 'u'));
  }
  assert.match(kernel, /不得进入回复、日志、错误、快照、Eval、任务记录或持久记忆/u);
  const taskExample = kernel.match(/10:00[\s\S]*10:05[\s\S]*10:07[\s\S]*交付只能引用 10:07/u)?.[0];
  assert.ok(taskExample);
  assert.ok(taskExample.indexOf('10:00') < taskExample.indexOf('10:05'));
  assert.ok(taskExample.indexOf('10:05') < taskExample.indexOf('10:07'));
  assert.match(testRules, /普通对话\s*\/\s*只读诊断/u);
  assert.match(testRules, /全量测试不是默认验证/u);
  assert.match(testRules, /验证受阻（degraded）/u);
  assert.match(testRules, /不得推断产品通过或失败/u);
  assert.match(troubleshootingRules, /验证受阻（degraded）/u);
  assert.match(troubleshootingRules, /失败阶段、替代证据、未验证行为和剩余风险/u);
  assert.match(projectDirectoryRules, /小型 Bug、单文件修改和简单问答不展开该清单/u);
  for (const item of ['技术栈', '目录结构', '业务流', '数据流', '模块依赖']) {
    assert.match(projectDirectoryRules, new RegExp(item, 'u'));
    assert.match(taskTemplate, new RegExp(item, 'u'));
  }
  assert.match(taskTemplate, /仅显式要求或影响范围无法缩小时填写/u);
  assert.match(englishTaskTemplate, /only when explicitly requested or impact cannot be narrowed/u);
  assert.match(testRules, /对抗式/u);
  assert.match(testRules, /测试类型/u);
  assert.match(testRules, /参考实现/u);
  assert.match(gitRules, /参考实现/u);
  for (const template of templates) assert.match(template, /测试范围细则/u);
});

test('profiles install zero, five, or eight native Skills at intended tiers', async () => {
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
