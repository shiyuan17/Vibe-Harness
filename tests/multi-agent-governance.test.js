import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateTaskGraph } from '../runtime/governance/lib/task-graph-validation.mjs';
import { validateTasks } from '../runtime/governance/lib/task-validation.mjs';
import { validateJsonAgainstSchema } from '../runtime/governance/lib/schema-validation.mjs';

const rootDir = path.resolve('.');
const childOutputFields = ['状态', '变更摘要', '变更路径', '验证证据', '未验证项', '剩余风险', '下一步动作'];

function control(kind, overrides = {}) {
  return {
    控制版本: 2,
    任务类型: kind,
    责任角色: `${kind}实现者`,
    写入范围: [`src/${kind}.js`],
    禁止动作: ['覆盖用户改动'],
    依赖任务: [],
    冲突任务: [],
    并行安全: '相互独立',
    时间盒分钟: 30,
    停止条件: '验收完成或明确阻塞',
    回滚方案: '恢复本任务改动',
    人工确认: '不需要',
    核验者: `${kind}核验者`,
    合并回主线状态: '不需要',
    ...overrides,
  };
}

function document(id, taskControl, overrides = {}) {
  return {
    control: taskControl,
    evidence: [],
    id,
    result: 'open',
    source: { path: `docs/tasks/${id}.md` },
    status: 'in_progress',
    ...overrides,
  };
}

function validGraph() {
  const parent = document('T-PARENT', control('父任务', {
    子任务: ['T-A', 'T-B', 'T-C'],
    执行批次: [['T-A', 'T-B'], ['T-C']],
    集成验证: ['pnpm check'],
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/T-PARENT-red-team.md',
    红队审查结论: '待审查',
    写入范围: ['src/**'],
  }));
  const childA = document('T-A', control('子任务', {
    父任务编号: 'T-PARENT',
    输入: ['父任务 AC'],
    输出格式: childOutputFields,
    不得修改范围: ['写入范围之外的文件'],
    写入范围: ['src/a.js'],
  }));
  const childB = document('T-B', control('子任务', {
    父任务编号: 'T-PARENT',
    输入: ['父任务 AC'],
    输出格式: childOutputFields,
    不得修改范围: ['写入范围之外的文件'],
    写入范围: ['src/b.js'],
  }));
  const childC = document('T-C', control('子任务', {
    父任务编号: 'T-PARENT',
    输入: ['T-A 输出'],
    输出格式: childOutputFields,
    不得修改范围: ['写入范围之外的文件'],
    依赖任务: ['T-A'],
    写入范围: ['src/c.js'],
  }));
  return { childA, childB, childC, parent };
}

function markdown(id, taskControl) {
  return `# ${id} v2 合同

- 工作流档位：完整
- 当前阶段：执行
- 当前状态：进行中
- 处理结果：开放

## 目标

验证 v2 合同。

## 验收标准

| AC-ID | 标准 |
| --- | --- |
| AC-01 | 合同有效。 |

## 验证计划

运行聚焦测试。

## 下一步动作

继续验证。

## 完整流程控制

\`\`\`json
${JSON.stringify(taskControl, null, 2)}
\`\`\`
`;
}

async function taskProject(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-multi-agent-'));
  await mkdir(path.join(root, 'docs/tasks'), { recursive: true });
  await mkdir(path.join(root, 'docs/schemas'), { recursive: true });
  await writeFile(
    path.join(root, 'docs/schemas/full-task-control.schema.json'),
    await readFile(path.join(rootDir, 'schemas/full-task-control.schema.json'), 'utf8'),
    'utf8',
  );
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(root, 'docs/tasks', name), body, 'utf8');
  }
  return root;
}

test('v1 full task remains valid while v2 rejects unsafe paths and incomplete child output', async () => {
  const legacy = control('单任务');
  delete legacy.控制版本;
  delete legacy.冲突任务;
  delete legacy.时间盒分钟;
  const unsafeChild = control('子任务', {
    父任务编号: 'T-PARENT',
    输入: ['父任务 AC'],
    输出格式: ['状态'],
    不得修改范围: ['范围外文件'],
    写入范围: ['../escape.js', 'src/*.js'],
  });
  const root = await taskProject({
    'T-LEGACY.md': markdown('T-LEGACY', legacy),
    'T-UNSAFE.md': markdown('T-UNSAFE', unsafeChild),
  });
  try {
    const errors = validateTasks(root).join('\n');
    assert.doesNotMatch(errors, /T-LEGACY/u);
    assert.match(errors, /T-UNSAFE.*项目相对路径/u);
    assert.match(errors, /T-UNSAFE.*输出格式/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('v1 child output keeps duplicate-field compatibility while v2 remains fixed', async () => {
  const legacyChild = control('子任务', {
    父任务编号: 'T-PARENT',
    输入: ['父任务 AC'],
    输出格式: ['状态', '状态'],
    不得修改范围: ['范围外文件'],
  });
  delete legacyChild.控制版本;
  const root = await taskProject({ 'T-CHILD.md': markdown('T-CHILD', legacyChild) });
  try {
    assert.deepEqual(validateTasks(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('every v2 task variant requires conflict declarations and a timebox', async () => {
  const invalid = control('单任务');
  delete invalid.冲突任务;
  delete invalid.时间盒分钟;
  const root = await taskProject({ 'T-SINGLE.md': markdown('T-SINGLE', invalid) });
  try {
    const errors = validateTasks(root).join('\n');
    assert.match(errors, /冲突任务/u);
    assert.match(errors, /时间盒分钟/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('localized task templates contain a schema-valid v2 single-task control block', async () => {
  const schema = JSON.parse(await readFile(path.join(rootDir, 'schemas/full-task-control.schema.json'), 'utf8'));
  for (const name of ['task.md', 'task.en-US.md']) {
    const template = await readFile(path.join(rootDir, 'templates', name), 'utf8');
    const block = template.match(/```json\s*([\s\S]*?)```/u)?.[1];
    assert.ok(block, `${name} is missing its v2 control block`);
    assert.deepEqual(validateJsonAgainstSchema(JSON.parse(block), schema, name), []);
  }
});

test('v2 schema keeps single, parent, and child structural fields disjoint', async () => {
  const schema = JSON.parse(await readFile(path.join(rootDir, 'schemas/full-task-control.schema.json'), 'utf8'));
  const single = control('单任务', { 子任务: ['T-A'] });
  const parent = control('父任务', {
    父任务编号: 'T-ROOT',
    子任务: ['T-A'],
    执行批次: [['T-A']],
    集成验证: ['pnpm check'],
  });
  const child = control('子任务', {
    父任务编号: 'T-PARENT',
    输入: ['父任务 AC'],
    输出格式: childOutputFields,
    不得修改范围: ['范围之外'],
    集成验证: ['pnpm check'],
  });
  for (const value of [single, parent, child]) {
    assert.notDeepEqual(validateJsonAgainstSchema(value, schema, 'control'), []);
  }
});

test('valid flat v2 task graph passes', () => {
  assert.deepEqual(validateTaskGraph(Object.values(validGraph())), []);
});

test('task graph rejects missing lineage, grandchildren, unknown references, and cycles', () => {
  const { childA, childB, childC, parent } = validGraph();
  childA.control.父任务编号 = 'T-MISSING';
  childB.control.依赖任务 = ['T-C'];
  childC.control.依赖任务 = ['T-B', 'T-UNKNOWN'];
  const grandchild = document('T-GRANDCHILD', control('子任务', {
    父任务编号: 'T-A',
    输入: ['T-A'],
    输出格式: childOutputFields,
    不得修改范围: ['范围外文件'],
  }));
  const errors = validateTaskGraph([parent, childA, childB, childC, grandchild]).join('\n');
  assert.match(errors, /T-A.*父任务.*T-MISSING/u);
  assert.match(errors, /T-GRANDCHILD.*父任务.*必须是“父任务”/u);
  assert.match(errors, /T-UNKNOWN.*不存在/u);
  assert.match(errors, /依赖环/u);
});

test('task graph rejects asymmetric conflicts, invalid batches, and overlapping parallel writes', () => {
  const { childA, childB, childC, parent } = validGraph();
  parent.control.执行批次 = [['T-A', 'T-B'], ['T-B']];
  childA.control.写入范围 = ['src/shared/**'];
  childB.control.写入范围 = ['src/shared/file.js'];
  childA.control.冲突任务 = ['T-B'];
  childC.control.依赖任务 = ['T-B'];
  const errors = validateTaskGraph([parent, childA, childB, childC]).join('\n');
  assert.match(errors, /T-B.*执行批次.*恰好一次/u);
  assert.match(errors, /冲突关系.*对称/u);
  assert.match(errors, /写入范围重叠.*同一执行批次/u);
  assert.match(errors, /T-C.*执行批次/u);
});

test('task graph canonicalizes separators and case before checking parallel writes', () => {
  const { childA, childB, parent } = validGraph();
  childA.control.写入范围 = ['src//Shared.js'];
  childB.control.写入范围 = ['src/shared.js'];
  childA.control.冲突任务 = ['T-B'];
  childB.control.冲突任务 = ['T-A'];
  const errors = validateTaskGraph([parent, childA, childB]).join('\n');
  assert.match(errors, /写入范围重叠.*同一执行批次/u);
});

test('completion gates require completed dependencies, terminal children, and integration evidence', () => {
  const { childA, childB, childC, parent } = validGraph();
  childC.result = 'completed';
  childC.control.合并回主线状态 = '待处理';
  parent.result = 'completed';
  parent.evidence = [{ '证据类型': '命令', '命令或产物': 'pnpm test', '退出码': '0' }];
  const errors = validateTaskGraph([parent, childA, childB, childC]).join('\n');
  assert.match(errors, /T-C.*依赖任务 T-A.*尚未完成/u);
  assert.match(errors, /T-C.*待处理.*合并回主线状态/u);
  assert.match(errors, /T-PARENT.*子任务 T-A.*尚未终结/u);
  assert.match(errors, /T-PARENT.*集成验证.*pnpm check/u);
  assert.match(errors, /T-PARENT.*最终 diff.*独立审查/u);
});

test('parent integration evidence must follow completed child evidence', () => {
  const { childA, childB, childC, parent } = validGraph();
  const current = new Date().toISOString();
  const evidence = (command, verifiedAt) => ({ '证据类型': '命令', '命令或产物': command, '退出码': '0', '核验时间': verifiedAt });
  for (const child of [childA, childB, childC]) {
    child.result = 'completed';
    child.control.合并回主线状态 = '已完成';
    child.evidence = [evidence('pnpm test', current)];
  }
  parent.result = 'completed';
  parent.control.红队审查者 = '独立核验者';
  parent.control.红队审查结论 = '批准';
  parent.evidence = [evidence('pnpm check', '2000-01-01T00:00:00.000Z')];
  assert.match(validateTaskGraph([parent, childA, childB, childC]).join('\n'), /fan-in 后.*pnpm check/u);
  parent.evidence = [evidence('pnpm check', current)];
  assert.deepEqual(validateTaskGraph([parent, childA, childB, childC]), []);
});

test('v2 ids must match filenames and duplicate ids are rejected', () => {
  const { childA, parent } = validGraph();
  childA.source.path = 'docs/tasks/WRONG.md';
  const duplicate = { ...childA, source: { path: 'docs/tasks/T-A.md' } };
  const errors = validateTaskGraph([parent, childA, duplicate]).join('\n');
  assert.match(errors, /文件名 WRONG.*任务编号 T-A/u);
  assert.match(errors, /任务编号 T-A 重复/u);
});

test('v2 graph rejects legacy id shadowing and tolerates malformed scope values', () => {
  const { childA, parent } = validGraph();
  const legacyShadow = document('T-A', control('单任务'));
  delete legacyShadow.control.控制版本;
  legacyShadow.source.path = 'docs/tasks/LEGACY.md';
  childA.control.写入范围 = [42];
  const errors = validateTaskGraph([legacyShadow, parent, childA]).join('\n');
  assert.match(errors, /任务编号 T-A 重复/u);
});

test('v2 write scope rejects Windows drive-relative paths', async () => {
  const invalid = control('单任务', { 写入范围: ['C:relative.js'] });
  const root = await taskProject({ 'T-DRIVE.md': markdown('T-DRIVE', invalid) });
  try {
    assert.match(validateTasks(root).join('\n'), /项目相对路径/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('v2 single tasks cannot hide unknown dependencies or conflicts', () => {
  const single = document('T-SINGLE', control('单任务', {
    依赖任务: ['T-MISSING'],
    冲突任务: ['T-CONFLICT'],
  }));
  const errors = validateTaskGraph([single]).join('\n');
  assert.match(errors, /依赖任务 T-MISSING 不存在/u);
  assert.match(errors, /冲突任务 T-CONFLICT 不存在/u);
});
