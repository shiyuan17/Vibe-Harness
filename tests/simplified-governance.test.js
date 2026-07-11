import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadAllManifests, readJson } from '../scripts/lib/manifest.js';
import { validateTasks } from '../runtime/governance/lib/task-validation.mjs';

const rootDir = path.resolve('.');

const baseTask = `# T-001 中文任务合同

- 工作流档位：快速
- 当前阶段：验证
- 当前状态：进行中
- 处理结果：开放

## 目标

验证中文 Markdown 任务合同。

## 验收标准

| AC-ID | 标准 |
| --- | --- |
| AC-01 | 合同可被治理运行时解析。 |

## 验证计划

- \`pnpm test\`

## 下一步动作

运行聚焦测试。
`;

async function taskProject(body, { legacyJson } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'loopengine-chinese-task-'));
  await mkdir(path.join(root, 'docs/tasks'), { recursive: true });
  await mkdir(path.join(root, 'docs/schemas'), { recursive: true });
  const schema = await readFile(path.join(rootDir, 'schemas/full-task-control.schema.json'), 'utf8');
  await writeFile(path.join(root, 'docs/schemas/full-task-control.schema.json'), schema, 'utf8');
  if (body) await writeFile(path.join(root, 'docs/tasks/T-001.md'), body, 'utf8');
  if (legacyJson) await writeFile(path.join(root, 'docs/tasks/task.json'), JSON.stringify(legacyJson), 'utf8');
  return root;
}

test('快速任务使用中文 Markdown 最小合同', async () => {
  const root = await taskProject(baseTask);
  try {
    assert.deepEqual(validateTasks(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('阻塞任务要求阻塞原因和恢复提示', async () => {
  const root = await taskProject(baseTask.replace('当前状态：进行中', '当前状态：阻塞'));
  try {
    const errors = validateTasks(root).join('\n');
    assert.match(errors, /阻塞原因/u);
    assert.match(errors, /恢复提示/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('只从文档头解析状态字段，剩余风险允许明确填写无', async () => {
  const completed = `${baseTask.replace('处理结果：开放', '处理结果：完成').replace('验证中文 Markdown 任务合同。', '验证中文 Markdown 任务合同。\n\n- 当前状态：阻塞')}

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-01 | 命令 | pnpm test | 0 | 2026-07-11T00:00:00Z | 独立核验者 | 通过 |

## 剩余风险

无
`;
  const root = await taskProject(completed);
  try {
    assert.deepEqual(validateTasks(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('轻量任务要求写入范围，等待任务要求恢复提示', async () => {
  const lightRoot = await taskProject(baseTask.replace('工作流档位：快速', '工作流档位：轻量'));
  const waitingRoot = await taskProject(baseTask.replace('当前状态：进行中', '当前状态：等待依赖'));
  try {
    assert.match(validateTasks(lightRoot).join('\n'), /写入范围/u);
    assert.match(validateTasks(waitingRoot).join('\n'), /恢复提示/u);
  } finally {
    await rm(lightRoot, { force: true, recursive: true });
    await rm(waitingRoot, { force: true, recursive: true });
  }
});

test('完整任务校验中文机器控制块和独立核验者', async () => {
  const full = `${baseTask.replace('工作流档位：快速', '工作流档位：完整')}

## 完整流程控制

\`\`\`json
{
  "任务类型": "单任务",
  "责任角色": "实现负责人",
  "写入范围": ["src/example.js"],
  "禁止动作": ["覆盖用户未归属改动"],
  "依赖任务": [],
  "并行安全": "独占写入",
  "停止条件": "验收标准全部获得有效证据",
  "回滚方案": "恢复修改前文件",
  "人工确认": "不需要",
  "核验者": "独立核验者",
  "合并回主线状态": "不需要"
}
\`\`\`
`;
  const root = await taskProject(full);
  try {
    assert.deepEqual(validateTasks(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('完成任务逐项校验命令、AC-ID 和产物路径', async () => {
  const completed = `${baseTask.replace('处理结果：开放', '处理结果：完成')}

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-UNKNOWN | 命令 | pnpm test | 1 | 2026-07-11T00:00:00Z | 独立核验者 | 失败 |
| AC-01 | 产物 | ../escape.md |  | 2026-07-11T00:00:00Z | 独立核验者 | 已生成 |

## 剩余风险

无已知剩余风险。
`;
  const root = await taskProject(completed);
  try {
    const errors = validateTasks(root).join('\n');
    assert.match(errors, /未知 AC-ID/u);
    assert.match(errors, /退出码必须为 0/u);
    assert.match(errors, /项目内相对路径/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('完成任务拒绝空命令和未知证据类型', async () => {
  const completed = `${baseTask.replace('处理结果：开放', '处理结果：完成')}

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-01 | 未知 |  | 0 | 2026-07-11T00:00:00Z | 独立核验者 | 通过 |

## 剩余风险

无已知剩余风险。
`;
  const root = await taskProject(completed);
  try {
    const errors = validateTasks(root).join('\n');
    assert.match(errors, /证据类型/u);
    assert.match(errors, /命令或产物/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('完整父子任务要求时间盒，完成时禁止实现者自批', async () => {
  const full = `${baseTask.replace('工作流档位：快速', '工作流档位：完整').replace('处理结果：开放', '处理结果：完成')}

## 完整流程控制

\`\`\`json
{
  "任务类型": "子任务",
  "父任务编号": "T-PARENT",
  "责任角色": "同一角色",
  "写入范围": ["src/example.js"],
  "禁止动作": ["覆盖用户未归属改动"],
  "依赖任务": [],
  "并行安全": "独占写入",
  "停止条件": "验收完成",
  "回滚方案": "恢复文件",
  "人工确认": "不需要",
  "核验者": "同一角色",
  "合并回主线状态": "不需要"
}
\`\`\`

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-01 | 命令 | pnpm test | 0 | 2026-07-11T00:00:00Z | 同一角色 | 通过 |

## 剩余风险

无已知剩余风险。
`;
  const root = await taskProject(full);
  try {
    const errors = validateTasks(root).join('\n');
    assert.match(errors, /时间盒分钟/u);
    assert.match(errors, /冲突任务/u);
    assert.match(errors, /核验者不得与实现者相同/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('旧 task.json 被明确拒绝', async () => {
  const root = await taskProject(null, { legacyJson: { id: 'T-OLD' } });
  try {
    assert.match(validateTasks(root).join('\n'), /不再支持 task\.json/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('治理资产只暴露规则、skills 和 profiles catalog', async () => {
  const manifests = await loadAllManifests(rootDir);
  assert.deepEqual(Object.keys(manifests).sort(), ['profiles', 'rules', 'skills']);
  assert.equal(manifests.rules.items.some((item) => item.id === 'governance-core'), true);
  assert.equal(manifests.skills.items.find((item) => item.id === 'using-loopengine')?.kind, 'router');
  await assert.rejects(access(path.join(rootDir, 'manifests/workflows.json')));
  await assert.rejects(access(path.join(rootDir, 'schemas/workflow-pack.schema.json')));
  await assert.rejects(access(path.join(rootDir, 'schemas/task.schema.json')));
});

test('安装表面使用精简模板并移除 workflows', async () => {
  const installMap = await readJson(path.join(rootDir, 'adapters/codex/install-map.json'));
  const sources = new Set(installMap.entries.map((entry) => entry.source));
  assert.equal(sources.has('rules/governance-core.md'), true);
  assert.equal(sources.has('templates/task.md'), true);
  assert.equal(sources.has('templates/delivery.md'), true);
  assert.equal(sources.has('skills/core/using-loopengine/SKILL.md'), true);
  assert.equal([...sources].some((source) => source.startsWith('workflows/')), false);
  assert.equal(sources.has('templates/workflow-packet.md'), false);
});

test('常驻治理表面不超过九十行', async () => {
  const agents = await readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8');
  const core = await readFile(path.join(rootDir, 'rules/governance-core.md'), 'utf8');
  const lines = agents.split(/\r?\n/u).length + core.split(/\r?\n/u).length;
  assert.ok(lines <= 90, `常驻治理表面当前为 ${lines} 行`);
});
