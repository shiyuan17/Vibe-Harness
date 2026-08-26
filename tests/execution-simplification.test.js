import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createInstallPlan, renderActionContent } from '../scripts/lib/install-planner.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('execution kernel keeps direct execution and optional task records', async () => {
  const kernel = await readFile(path.join(rootDir, 'rules/governance-core.md'), 'utf8');
  assert.match(kernel, /获取事实.*直接执行.*聚焦验证.*简洁交付/u);
  assert.match(kernel, /任务 Markdown 是可选的人读记录/u);
  assert.doesNotMatch(kernel, /固定.*完成门禁/u);
});

test('evidence labels stay human-readable and do not become workflow gates', async () => {
  const kernel = await readFile(path.join(rootDir, 'rules/governance-core.md'), 'utf8');
  for (const label of ['已确认事实', '静态结论', '待验证假设', '验证受阻']) {
    assert.match(kernel, new RegExp(label, 'u'));
  }
  assert.match(kernel, /不形成机器状态、完成门禁或固定交付格式/u);
  assert.match(kernel, /不得据此推断产品通过或失败/u);
});

test('lightweight Task DAG is optional and defines deterministic collaboration semantics', async () => {
  const [kernel, collaboration] = await Promise.all([
    readFile(path.join(rootDir, 'rules/governance-core.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/ai-collab-rules.md'), 'utf8'),
  ]);
  assert.match(kernel, /两个以上协作单元.*轻量 Task DAG/u);
  assert.match(kernel, /简单任务不创建 DAG/u);
  assert.match(kernel, /ready 节点/u);
  assert.match(kernel, /fan-in 后重新读取实际工作区与 diff/u);
  assert.match(collaboration, /单 Agent、简单顺序任务和纯对话不创建 DAG/u);
  assert.match(collaboration, /不由 Vibe-Harness 解析，也不形成固定完成门禁/u);
  for (const field of ['id', 'kind', 'output', 'dependsOn', 'trigger', 'writeScope', 'resourceLocks', 'verification', 'result']) {
    assert.match(collaboration, new RegExp(field, 'u'));
  }
  for (const result of ['succeeded', 'failed', 'blocked', 'skipped', 'cancelled']) {
    assert.match(collaboration, new RegExp(result, 'u'));
  }
  assert.match(collaboration, /all_success/u);
  assert.match(collaboration, /all_done.*不得把失败图改判为成功/u);
  assert.match(collaboration, /Windows 路径比较忽略大小写/u);
  assert.match(collaboration, /相同 resourceLocks.*唯一节点负责写入/u);
  assert.match(collaboration, /写节点失败后不再派发新的写节点/u);
  assert.match(collaboration, /最多尝试三次.*Retry-After/u);
  assert.match(collaboration, /权限、安全门禁、契约歧义、确定性测试失败和非幂等外部写入不得自动重试/u);
  assert.match(collaboration, /最后一次实质写入后运行集成验证/u);
});

test('task templates and installed projection expose the same optional collaboration graph', async () => {
  const [chinese, english] = await Promise.all([
    readFile(path.join(rootDir, 'templates/task.md'), 'utf8'),
    readFile(path.join(rootDir, 'templates/task.en-US.md'), 'utf8'),
  ]);
  for (const field of ['id', 'kind', 'output', 'dependsOn', 'trigger', 'writeScope', 'resourceLocks', 'verification', 'result']) {
    assert.match(chinese, new RegExp(field, 'u'));
    assert.match(english, new RegExp(field, 'u'));
  }
  assert.match(chinese, /协作图（仅使用协作时填写）/u);
  assert.match(english, /Collaboration Graph \(complete only when collaborating\)/u);
  assert.match(chinese, /不由 Vibe-Harness 解析或作为完成门禁/u);
  assert.match(english, /does not parse it or use it as a completion gate/u);
  assert.doesNotMatch(chinese, /Write Scope/u);
  assert.doesNotMatch(english, /Write Scope/u);

  const plan = await createInstallPlan({ dryRun: true, profile: 'minimal', rootDir, targetDir: path.join(rootDir, '.tmp-task-dag-template') });
  const action = plan.actions.find((item) => item.relativeTarget === 'docs/templates/task.md');
  assert.ok(action);
  assert.equal(await renderActionContent(action, plan.renderData), chinese);
});

test('capability catalog and online canary register lightweight Task DAG coverage', async () => {
  const [capabilities, suite] = await Promise.all([
    readFile(path.join(rootDir, 'manifests/capabilities.json'), 'utf8').then(JSON.parse),
    readFile(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'), 'utf8').then(JSON.parse),
  ]);
  const capability = capabilities.items.find((item) => item.id === 'lightweight-task-dag');
  assert.ok(capability);
  assert.deepEqual(capability.profiles, ['minimal', 'core', 'full', 'docs-only']);
  assert.deepEqual(capability.evaluation.suites, ['evals/suites/vibe-harness-online-canary.json']);
  assert.equal(suite.version, '2.8.0');
  const cases = suite.cases.filter((item) => item.capability === 'lightweight-task-dag');
  assert.deepEqual(cases.map((item) => item.id), [
    'EVAL-DAG-001',
    'EVAL-DAG-002',
    'EVAL-DAG-003',
    'EVAL-DAG-004',
    'EVAL-DAG-005',
    'EVAL-DAG-006',
    'EVAL-DAG-007',
  ]);
  assert.equal(cases.every((item) => item.risk === 'critical' && item.repetitions === 3), true);
});

test('plan split judgment gates execution without becoming a workflow gate', async () => {
  const kernel = await readFile(path.join(rootDir, 'rules/governance-core.md'), 'utf8');
  assert.match(kernel, /不默认直接执行，也不默认拆分/u);
  assert.match(kernel, /命中任一硬触发即拆分，不计入软信号/u);
  assert.match(kernel, /0–1 项直接执行计划；2–3 项拆分为实施任务；4 项及以上必须拆分并显式声明任务依赖/u);
  assert.match(kernel, /目标、依赖、修改范围、约束、验收标准、验证方式和产出/u);
  assert.match(kernel, /打开文件、修改代码、运行测试等操作步骤不是任务/u);
  assert.match(kernel, /单 Agent 顺序执行多个任务时不创建 DAG/u);
});

test('task templates expose the optional implementation task split table', async () => {
  const [chinese, english] = await Promise.all([
    readFile(path.join(rootDir, 'templates/task.md'), 'utf8'),
    readFile(path.join(rootDir, 'templates/task.en-US.md'), 'utf8'),
  ]);
  assert.match(chinese, /实施任务拆分（仅判定为拆分时填写）/u);
  assert.match(english, /Implementation task split \(complete only when the plan is split\)/u);
  for (const field of ['任务', '目标', '依赖', '修改范围', '约束', '验收标准', '验证方式', '产出']) {
    assert.match(chinese, new RegExp(field, 'u'));
  }
  for (const field of ['Task', 'Goal', 'Depends on', 'Change scope', 'Constraints', 'Acceptance criteria', 'Verification', 'Output']) {
    assert.match(english, new RegExp(field, 'u'));
  }
});

test('capability catalog and online canary register plan task split coverage', async () => {
  const [capabilities, suite] = await Promise.all([
    readFile(path.join(rootDir, 'manifests/capabilities.json'), 'utf8').then(JSON.parse),
    readFile(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'), 'utf8').then(JSON.parse),
  ]);
  const capability = capabilities.items.find((item) => item.id === 'plan-task-split');
  assert.ok(capability);
  assert.deepEqual(capability.profiles, ['minimal', 'core', 'full', 'docs-only']);
  assert.deepEqual(capability.evaluation.suites, ['evals/suites/vibe-harness-online-canary.json']);
  const cases = suite.cases.filter((item) => item.capability === 'plan-task-split');
  assert.deepEqual(cases.map((item) => item.id), [
    'EVAL-SPLIT-001',
    'EVAL-SPLIT-002',
    'EVAL-SPLIT-003',
  ]);
  assert.equal(cases.every((item) => item.risk === 'critical' && item.repetitions === 3), true);
  assert.equal(cases.every((item) => item.category === 'task-delivery-governance'), true);
});

test('Linear projection preserves native DAG dependency and fan-in semantics', async () => {
  const [collaboration, linear] = await Promise.all([
    readFile(path.join(rootDir, 'rules/ai-collab-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/linear-workflow.md'), 'utf8'),
  ]);
  for (const field of ['kind', 'trigger', 'resourceLocks']) {
    assert.match(linear, new RegExp(field, 'u'));
  }
  assert.match(linear, /Parent\/Sub-issue 只表示分解，不隐含顺序/u);
  assert.match(linear, /blocked-by \/ blocks 是唯一执行依赖/u);
  assert.match(linear, /all_done.*不能把失败 DAG 或 Root 判为成功/u);
  assert.match(linear, /Scope 是 writeScope 的 Linear 投影/u);
  assert.match(linear, /Windows 比较忽略大小写/u);
  assert.match(linear, /Scope 重叠或 resourceLocks 相同/u);
  assert.match(linear, /Fan-in Verification/u);
  assert.match(linear, /Parent.*不得 Done/u);
  assert.match(collaboration, /all_done.*不得把失败图改判为成功/u);
  assert.match(collaboration, /相同 resourceLocks.*唯一节点负责写入/u);
});
