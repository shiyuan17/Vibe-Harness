import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createInstallPlan, renderActionContent } from '../scripts/lib/install-planner.js';
import { DAG_NODE_KEYS, NODE_KINDS, NODE_RESULTS, NODE_TRIGGERS } from '../scripts/lib/task-dag.js';
import { assertRuleAnchors, markdownTable } from './helpers/governed-docs.js';

const rootDir = path.resolve(import.meta.dirname, '..');
const KERNEL_RULE = 'docs/rules/governance-core.md';
const COLLABORATION_RULE = 'docs/rules/ai-collab-rules.md';
const LINEAR_RULE = 'docs/rules/linear-workflow.md';
const TASK_TEMPLATE = 'templates/task.md';
const TASK_TEMPLATE_EN = 'templates/task.en-US.md';

/** Read one governed document from the repository root. */
function readDocument(relative) {
  return readFile(path.join(rootDir, relative), 'utf8');
}

/** Strip markdown emphasis from a table cell so it can be compared to a schema value. */
function bareCell(cell) {
  return cell.replaceAll('`', '').trim();
}

test('execution kernel keeps direct execution and optional task records', async () => {
  await assertRuleAnchors(rootDir, [KERNEL_RULE]);
  const kernel = await readDocument(KERNEL_RULE);
  // Anti-drift: the kernel must not turn its optional human record into a gate.
  assert.doesNotMatch(kernel, /固定.*完成门禁/u);
});

test('fact sufficiency is risk-proportionate and routes remaining ambiguity', async () => {
  await assertRuleAnchors(rootDir, [KERNEL_RULE]);
  const kernel = await readDocument(KERNEL_RULE);
  // The three tiers are one closed vocabulary; a fourth would change the
  // contract the rest of the kernel is written against.
  assert.deepEqual(
    [...kernel.matchAll(/^- \*\*(快速|轻量|完整)\*\*：/gmu)].map((match) => match[1]),
    ['快速', '轻量', '完整'],
  );
});

test('evidence labels stay human-readable and do not become workflow gates', async () => {
  await assertRuleAnchors(rootDir, [KERNEL_RULE]);
  const kernel = await readDocument(KERNEL_RULE);
  // The labels are one ordered vocabulary of evidence strength, not free text.
  assert.deepEqual(
    [...kernel.matchAll(/\*\*(已确认事实|静态结论|待验证假设|验证受阻)\*\*/gu)].map((match) => match[1]),
    ['已确认事实', '静态结论', '待验证假设', '验证受阻'],
  );
});

test('lightweight Task DAG is optional and defines deterministic collaboration semantics', async () => {
  await assertRuleAnchors(rootDir, [KERNEL_RULE, COLLABORATION_RULE]);
  const collaboration = await readDocument(COLLABORATION_RULE);
  // The rule documents the same node vocabulary the validating module consumes,
  // so a field or status cannot drift between what is written and what is
  // dispatchable.
  assert.deepEqual(
    markdownTable(collaboration, '每个节点固定声明以下字段').rows.map((row) => bareCell(row[0])),
    [...DAG_NODE_KEYS],
  );
  for (const kind of NODE_KINDS) assert.ok(collaboration.includes('`' + kind + '`'), kind);
  for (const trigger of NODE_TRIGGERS) assert.ok(collaboration.includes('`' + trigger + '`'), trigger);
  for (const result of NODE_RESULTS) assert.ok(collaboration.includes('`' + result + '`'), result);
});

test('task templates and installed projection expose the same optional collaboration graph', async () => {
  const [chinese, english] = await Promise.all([readDocument(TASK_TEMPLATE), readDocument(TASK_TEMPLATE_EN)]);
  await assertRuleAnchors(rootDir, [TASK_TEMPLATE, TASK_TEMPLATE_EN]);

  // Both templates carry the DAG columns in the validating module's order, so
  // the two languages cannot drift column by column.
  for (const [content, anchor] of [
    [chinese, '协作图（仅使用协作时填写）'],
    [english, 'Collaboration Graph (complete only when collaborating)'],
  ]) {
    assert.deepEqual(
      markdownTable(content, anchor).header.map((cell) => cell.split(/[（(]/u)[0].trim()),
      [...DAG_NODE_KEYS],
    );
    assert.doesNotMatch(content, /Write Scope/u);
  }

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
  assert.equal(suite.version, '2.10.0');
  const cases = suite.cases.filter((item) => item.capability === 'lightweight-task-dag');
  assert.deepEqual(cases.map((item) => item.id), [
    'EVAL-DAG-001',
    'EVAL-DAG-002',
    'EVAL-DAG-003',
    'EVAL-DAG-004',
    'EVAL-DAG-005',
    'EVAL-DAG-006',
    'EVAL-DAG-007',
    'EVAL-DAG-008',
    'EVAL-DAG-009',
    'EVAL-DAG-010',
    'EVAL-DAG-011',
    'EVAL-DAG-012',
    'EVAL-DAG-013',
  ]);
  assert.equal(cases.every((item) => item.risk === 'critical' && item.repetitions === 3), true);
});

test('implementation methods stay adaptive within explicit authorization', async () => {
  await assertRuleAnchors(rootDir, [KERNEL_RULE]);
});

test('task templates expose the optional implementation task split table', async () => {
  const [chinese, english] = await Promise.all([readDocument(TASK_TEMPLATE), readDocument(TASK_TEMPLATE_EN)]);
  await assertRuleAnchors(rootDir, [TASK_TEMPLATE, TASK_TEMPLATE_EN]);
  assert.deepEqual(
    markdownTable(chinese, '实施任务拆分（仅判定为拆分时填写）').header,
    ['任务', '目标', '依赖', '修改范围', '约束', '验收标准', '验证方式', '产出'],
  );
  assert.deepEqual(
    markdownTable(english, 'Implementation task split (complete only when the plan is split)').header,
    ['Task', 'Goal', 'Depends on', 'Change scope', 'Constraints', 'Acceptance criteria', 'Verification', 'Output'],
  );
});

test('capability catalog and online canary register plan task split coverage', async () => {
  const [capabilities, suite] = await Promise.all([
    readFile(path.join(rootDir, 'manifests/capabilities.json'), 'utf8').then(JSON.parse),
    readFile(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'), 'utf8').then(JSON.parse),
  ]);
  const capability = capabilities.items.find((item) => item.id === 'plan-task-split');
  assert.ok(capability);
  assert.deepEqual(capability.profiles, ['minimal', 'core', 'full', 'docs-only']);
  assert.deepEqual(capability.evaluation.suites, ['evals/suites/vibe-harness-online-canary.json', 'evals/suites/vibe-harness-online-autonomy.json']);
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
  await assertRuleAnchors(rootDir, [COLLABORATION_RULE, LINEAR_RULE]);
  const linear = await readDocument(LINEAR_RULE);
  // The projection carries the same field set as the node model it projects.
  assert.deepEqual(
    markdownTable(linear, 'DAG 字段在 Linear 上的载体与真值来源固定如下').rows.map((row) => bareCell(row[0])),
    [...DAG_NODE_KEYS],
  );
});

test('DAG states, ownership and handoff evidence remain bounded human contracts', async () => {
  await assertRuleAnchors(rootDir, [COLLABORATION_RULE]);
  const collaboration = await readDocument(COLLABORATION_RULE);
  // The Linear projection may only speak in states the DAG module accepts.
  const mapping = markdownTable(collaboration, 'Linear 状态到本地 `result` 的映射固定如下');
  assert.equal(mapping.header[1].replaceAll('`', ''), '本地 result');
  assert.ok(mapping.rows.length >= 5);
  const projected = new Set(mapping.rows.flatMap((row) => row[1].split(/或|\//u).map(bareCell)));
  for (const value of projected) assert.ok(NODE_RESULTS.includes(value), `unknown projected result: ${value}`);
});
