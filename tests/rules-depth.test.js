import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInstallPlan, previewInstallPlan } from '../scripts/lib/install-planner.js';
import { readJson } from '../scripts/lib/manifest.js';
import { scanForForbiddenTerms } from '../scripts/lib/redaction.js';

const rootDir = path.resolve('.');

async function planTargets(profile) {
  const targetDir = await mkdtemp(path.join(tmpdir(), `loopengine-depth-${profile}-`));
  try {
    const plan = await createInstallPlan({ dryRun: true, profile, rootDir, targetDir });
    return plan.actions.map((action) => action.relativeTarget).sort();
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
}

test('deep reusable rules and skills are declared in manifests', async () => {
  const manifests = {
    rules: await readJson(path.join(rootDir, 'manifests/rules.json')),
    skills: await readJson(path.join(rootDir, 'manifests/skills.json')),
  };
  const ruleIds = new Set(manifests.rules.items.map((item) => item.id));
  const skillIds = new Set(manifests.skills.items.map((item) => item.id));

  for (const id of [
    'ai-collab-rules',
    'api-rules',
    'coding-rules',
    'db-rules',
    'frontend-rules',
    'log-management',
    'pencil-rules',
    'project-directory',
    'release-rules',
    'session-protocol',
    'task-management',
    'troubleshooting',
  ]) {
    assert.equal(ruleIds.has(id), true, `${id} rule should be declared`);
  }

  for (const id of [
    'brainstorming',
    'api-and-interface-design',
    'writing-plans',
    'test-driven-development',
    'systematic-debugging',
    'verification-before-completion',
    'code-review-and-quality',
    'requesting-code-review',
    'skill-authoring-check',
    'subagent-driven-development',
    'open-code-review',
    'browser-verification',
    'workflow-handoff',
    'handoff',
    'recall',
    'remember',
    'forget',
    'recap',
    'session-history',
    'commit-history',
    'commit-context',
    'api-contract-check',
    'frontend-implementation-check',
    'release-checklist',
    'task-decomposition',
    'worktree-mergeback-check',
    'pencil-design-check',
  ]) {
    assert.equal(skillIds.has(id), true, `${id} skill should be declared`);
  }
});

test('profiles install deep rules and memory skills at the intended tiers', async () => {
  const minimalTargets = await planTargets('minimal');
  const coreTargets = await planTargets('core');
  const fullTargets = await planTargets('full');

  assert.equal(minimalTargets.includes('docs/rules/release-rules.md'), false);
  assert.equal(minimalTargets.includes('docs/rules/pencil-rules.md'), false);
  assert.equal(minimalTargets.includes('.agents/skills/handoff/SKILL.md'), false);

  const bundledSkillTargets = [
    '.agents/skills/brainstorming/SKILL.md',
    '.agents/skills/api-and-interface-design/SKILL.md',
    '.agents/skills/writing-plans/SKILL.md',
    '.agents/skills/test-driven-development/SKILL.md',
    '.agents/skills/systematic-debugging/SKILL.md',
    '.agents/skills/verification-before-completion/SKILL.md',
    '.agents/skills/code-review-and-quality/SKILL.md',
    '.agents/skills/requesting-code-review/SKILL.md',
    '.agents/skills/skill-authoring-check/SKILL.md',
    '.agents/skills/open-code-review/SKILL.md',
    '.agents/skills/browser-verification/SKILL.md',
    '.agents/skills/handoff/SKILL.md',
    '.agents/skills/recall/SKILL.md',
    '.agents/skills/remember/SKILL.md',
  ];

  for (const target of bundledSkillTargets) {
    assert.equal(coreTargets.includes(target), true, `${target} should be in core`);
    assert.equal(fullTargets.includes(target), true, `${target} should be in full`);
  }

  for (const target of [
    'docs/rules/coding-rules.md',
    'docs/rules/frontend-rules.md',
    'docs/rules/api-rules.md',
    'docs/rules/ai-collab-rules.md',
    'docs/rules/log-management.md',
    'docs/rules/project-directory.md',
    '.agents/skills/workflow-handoff/SKILL.md',
    '.agents/skills/api-contract-check/SKILL.md',
    '.agents/skills/frontend-implementation-check/SKILL.md',
    '.agents/skills/task-decomposition/SKILL.md',
    '.agents/skills/worktree-mergeback-check/SKILL.md',
  ]) {
    assert.equal(coreTargets.includes(target), true, `${target} should be in core`);
  }

  for (const target of [
    'docs/rules/release-rules.md',
    'docs/rules/pencil-rules.md',
    'docs/rules/task-management.md',
    'docs/rules/log-management.md',
    'docs/rules/troubleshooting.md',
    '.agents/skills/handoff/SKILL.md',
    '.agents/skills/recall/SKILL.md',
    '.agents/skills/remember/SKILL.md',
    '.agents/skills/pencil-design-check/SKILL.md',
    '.agents/skills/release-checklist/SKILL.md',
    '.agents/skills/subagent-driven-development/SKILL.md',
  ]) {
    assert.equal(fullTargets.includes(target), true, `${target} should be in full`);
  }

  for (const target of [
    '.agents/skills/review-checklist/SKILL.md',
    '.agents/skills/loop-planning/SKILL.md',
    '.agents/skills/subagent-driven-development/SKILL.md',
  ]) {
    assert.equal(coreTargets.includes(target), false, `${target} should be reserved for full`);
    assert.equal(minimalTargets.includes(target), false, `${target} should not be in minimal`);
  }
});

test('rendered AGENTS describes installed deep surfaces for core and full', async () => {
  const coreDir = await mkdtemp(path.join(tmpdir(), 'loopengine-depth-agents-core-'));
  const fullDir = await mkdtemp(path.join(tmpdir(), 'loopengine-depth-agents-full-'));
  try {
    const corePlan = await createInstallPlan({ dryRun: true, profile: 'core', rootDir, targetDir: coreDir });
    const fullPlan = await createInstallPlan({ dryRun: true, profile: 'full', rootDir, targetDir: fullDir });
    const coreAgents = (await previewInstallPlan(corePlan)).find((file) => file.target === 'AGENTS.md').content;
    const fullAgents = (await previewInstallPlan(fullPlan)).find((file) => file.target === 'AGENTS.md').content;

    assert.equal(coreAgents.includes('工程专项规则'), true);
    assert.equal(coreAgents.includes('agentmemory skills'), true);
    assert.equal(fullAgents.includes('agentmemory skills'), true);
    assert.equal(fullAgents.includes('发布 / 设计 / 排障规则'), true);
  } finally {
    await rm(coreDir, { force: true, recursive: true });
    await rm(fullDir, { force: true, recursive: true });
  }
});

test('workflow tier guidance keeps three tiers and documents Full escalation triggers', async () => {
  const dynamicWorkflow = await readFile(path.join(rootDir, 'rules/dynamic-workflow.md'), 'utf8');
  const workflowPacket = await readFile(path.join(rootDir, 'templates/workflow-packet.md'), 'utf8');
  const workflowSkill = await readFile(path.join(rootDir, 'skills/core/workflow-packet/SKILL.md'), 'utf8');

  assert.match(dynamicWorkflow, /快速路径（`Fast Path`）：纯文档、只读分析、测试-only、低风险文案/);
  assert.match(dynamicWorkflow, /轻量流程（`Lightweight`）：低风险实现，且不触发安全、数据库、发布、生产、红区、跨层或外部契约/);
  assert.match(dynamicWorkflow, /完整流程（`Full`）：任何红区、安全、DB、生产、发布、高风险、跨层或外部契约工作/);
  assert.match(dynamicWorkflow, /升级优先/);
  assert.match(dynamicWorkflow, /不确定时先按更高档位处理/);

  assert.match(workflowPacket, /按触发器必填/);
  assert.match(workflowPacket, /Red Team.*红区、安全、DB、生产、发布、高风险或跨层/);
  assert.match(workflowPacket, /跨仓 \/ 外部契约证据.*外部契约或跨仓/);
  assert.match(workflowPacket, /工作流档位（必填）：`Fast Path` \/ `Lightweight` \/ `Full`/);
  assert.match(workflowSkill, /不得将触发完整流程（`Full`）的任务降级为轻量流程（`Lightweight`）/);
});

test('session protocol defines start and end requirements', async () => {
  const sessionProtocol = await readFile(path.join(rootDir, 'rules/session-protocol.md'), 'utf8');

  for (const required of [
    'Session Start Protocol',
    'git status --short',
    'CodeGraph',
    '风险档位',
    '红区确认',
    '验证计划',
    '默认继续',
    '不可逆',
    '范围变化',
    '完成后再汇报',
  ]) {
    assert.equal(sessionProtocol.includes(required), true, `${required} should be documented for session start`);
  }

  for (const required of [
    'Session End Protocol',
    '摘要',
    '影响范围',
    '验证证据',
    '未验证项',
    'Git 状态',
    'worktree',
    'merge-back',
    '后续动作',
  ]) {
    assert.equal(sessionProtocol.includes(required), true, `${required} should be documented for session end`);
  }
});

test('task rules define compatible parent-child decomposition boundaries', async () => {
  const taskRules = await readFile(path.join(rootDir, 'rules/task-rules.md'), 'utf8');
  const taskLifecycle = await readFile(path.join(rootDir, 'rules/task-lifecycle.md'), 'utf8');
  const taskDecompositionSkill = await readFile(path.join(rootDir, 'skills/core/task-decomposition/SKILL.md'), 'utf8');
  const subagentSkill = await readFile(path.join(rootDir, 'skills/core/subagent-driven-development/SKILL.md'), 'utf8');

  for (const required of [
    '小任务保持 `single`',
    '子任务不能拆得太细',
    '约 5 分钟内完成或明确阻塞',
    '父任务不得直接改业务实现',
    '所有子任务验证、审查、merge-back、集成验证',
  ]) {
    assert.equal(taskRules.includes(required), true, `${required} should be documented in task rules`);
  }

  for (const required of [
    '多 agent',
    '多个 worktree',
    '写入范围可并行拆分',
    '依赖 / 冲突关系',
  ]) {
    assert.equal(taskLifecycle.includes(required), true, `${required} should be documented in task lifecycle`);
  }

  for (const required of [
    '先判断是否需要父子任务',
    '小任务直接输出 `single`',
    '不能把机械步骤拆成 child',
    '约 5 分钟内完成或暴露阻塞',
  ]) {
    assert.equal(taskDecompositionSkill.includes(required), true, `${required} should be documented in task decomposition skill`);
  }

  for (const required of [
    '只接收 child brief',
    '父任务维护 progress ledger',
    '最终集成验证',
  ]) {
    assert.equal(subagentSkill.includes(required), true, `${required} should be documented in subagent skill`);
  }
});

test('deep rules and integration skills do not leak source project terms', async () => {
  const findings = await scanForForbiddenTerms({
    forbiddenTerms: ['SYBaseProjectWeb', 'SYBaseProject', 'D:\\Github\\JW', 'T-019', 'T-024', '患者', '病理', '医疗', 'localhost:5777'],
    includeDirs: ['rules', 'skills/core', 'skills/integrations', 'memory', 'templates', 'workflows', 'adapters/codex', 'manifests', 'schemas'],
    rootDir,
  });

  assert.deepEqual(findings, []);
});

test('skill routing only names bundled skills', async () => {
  const skillRouting = await readFile(path.join(rootDir, 'rules/skill-routing.md'), 'utf8');

  assert.equal(skillRouting.includes('外部 skill'), false);
  assert.equal(skillRouting.includes('类 skill'), false);
  assert.equal(skillRouting.includes('verification-before-completion'), true);
  assert.equal(skillRouting.includes('browser-verification'), true);
  assert.equal(skillRouting.includes('code-review-and-quality'), true);
});
