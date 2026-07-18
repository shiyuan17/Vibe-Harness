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
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-chinese-task-'));
  await mkdir(path.join(root, 'docs/tasks'), { recursive: true });
  await mkdir(path.join(root, 'docs/schemas'), { recursive: true });
  const schema = await readFile(path.join(rootDir, 'schemas/full-task-control.schema.json'), 'utf8');
  await writeFile(path.join(root, 'docs/schemas/full-task-control.schema.json'), schema, 'utf8');
  if (body) await writeFile(path.join(root, 'docs/tasks/T-001.md'), body, 'utf8');
  if (legacyJson) await writeFile(path.join(root, 'docs/tasks/task.json'), JSON.stringify(legacyJson), 'utf8');
  return root;
}

function fullControl(overrides = {}) {
  return {
    任务类型: '单任务',
    责任角色: '实现负责人',
    写入范围: ['src/example.js'],
    禁止动作: ['覆盖用户未归属改动'],
    依赖任务: [],
    并行安全: '独占写入',
    停止条件: '验收标准全部获得有效证据',
    回滚方案: '恢复修改前文件',
    人工确认: '不需要',
    核验者: '独立核验者',
    合并回主线状态: '不需要',
    ...overrides,
  };
}

function completedFullTask(control) {
  return `${baseTask.replace('工作流档位：快速', '工作流档位：完整').replace('处理结果：开放', '处理结果：完成')}

## 完整流程控制

\`\`\`json
${JSON.stringify(control, null, 2)}
\`\`\`

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-01 | 命令 | pnpm test | 0 | 2026-07-11T00:00:00Z | 独立核验者 | 通过 |

## 剩余风险

无已知剩余风险。
`;
}

function openFullTask(control) {
  return `${baseTask.replace('工作流档位：快速', '工作流档位：完整')}

## 完整流程控制

\`\`\`json
${JSON.stringify(control, null, 2)}
\`\`\`
`;
}

async function writeRedTeamPacket(root, {
  conclusion = '批准',
  deferrals = [],
  findings = [],
  reviewer = '独立核验者',
  taskId = 'T-001',
} = {}) {
  const reviewsRoot = path.join(root, 'docs/reviews');
  await mkdir(reviewsRoot, { recursive: true });
  const findingRows = findings.map((finding) => `| ${finding.id} | ${finding.severity} | ${finding.status} | src/example.js | 测试触发 | 影响说明 | 最小修复 |`).join('\n');
  const deferralRows = deferrals.map((deferral) => `| ${deferral.id} | 合理延期 | 负责人 | 条件满足 | 批准者 |`).join('\n');
  const body = `# ${taskId} Red Team 审查包

- 任务编号：${taskId}
- 审查者：${reviewer}
- 审查对象：当前任务 diff、规格与验证证据
- 审查时间：2026-07-11T00:00:00Z

## 审查范围

正确性、安全与滥用、架构、测试、发布回滚和治理合规。

## 问题列表

| 问题编号 | 严重度 | 状态 | 位置 | 触发方式 | 影响 | 最小修复方向 |
| --- | --- | --- | --- | --- | --- | --- |
${findingRows}

## Medium 延期

| 问题编号 | 理由 | 责任人 | 关闭条件 | 批准者 |
| --- | --- | --- | --- | --- |
${deferralRows}

## 已核验证据

- \`pnpm test\` 退出码 0。

## 未覆盖审查轴与剩余风险

无未覆盖审查轴；无已知剩余风险。

## 结论

${conclusion}
`;
  await writeFile(path.join(reviewsRoot, 'T-001-red-team.md'), body, 'utf8');
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

test('旧的未完成完整任务无需立即补齐 Red Team 字段', async () => {
  const incomplete = `${baseTask.replace('工作流档位：快速', '工作流档位：完整')}

## 完整流程控制

\`\`\`json
${JSON.stringify(fullControl(), null, 2)}
\`\`\`
`;
  const root = await taskProject(incomplete);
  try {
    assert.deepEqual(validateTasks(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('完成的完整任务要求 Red Team 控制字段', async () => {
  const root = await taskProject(completedFullTask(fullControl()));
  try {
    const errors = validateTasks(root).join('\n');
    assert.match(errors, /红队审查者/u);
    assert.match(errors, /红队审查包/u);
    assert.match(errors, /红队审查结论/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('完成的完整任务接受独立批准的结构化 Red Team 审查包', async () => {
  const root = await taskProject(completedFullTask(fullControl({
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/T-001-red-team.md',
    红队审查结论: '批准',
  })));
  try {
    await writeRedTeamPacket(root);
    assert.deepEqual(validateTasks(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Red Team 门禁拒绝自批、越界路径和缺失审查包', async () => {
  const cases = [
    {
      control: fullControl({ 红队审查者: '实现负责人', 红队审查包: 'docs/reviews/T-001-red-team.md', 红队审查结论: '批准' }),
      expected: /红队审查者不得与实现者相同/u,
    },
    {
      control: fullControl({ 红队审查者: ' 实现负责人 ', 红队审查包: 'docs/reviews/T-001-red-team.md', 红队审查结论: '批准' }),
      expected: /红队审查者不得与实现者相同/u,
    },
    {
      control: fullControl({ 红队审查者: '独立核验者', 红队审查包: '../escape.md', 红队审查结论: '批准' }),
      expected: /项目内相对路径/u,
    },
    {
      control: fullControl({ 红队审查者: '独立核验者', 红队审查包: 'C:\\outside.md', 红队审查结论: '批准' }),
      expected: /项目内相对路径/u,
    },
    {
      control: fullControl({ 红队审查者: '独立核验者', 红队审查包: 'docs/reviews/missing.md', 红队审查结论: '批准' }),
      expected: /产物不存在/u,
    },
  ];
  for (const scenario of cases) {
    const root = await taskProject(completedFullTask(scenario.control));
    try {
      assert.match(validateTasks(root).join('\n'), scenario.expected);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test('Red Team 门禁将目录伪装的 Markdown 路径视为无效产物', async () => {
  const root = await taskProject(completedFullTask(fullControl({
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/not-a-file.md',
    红队审查结论: '批准',
  })));
  try {
    await mkdir(path.join(root, 'docs/reviews/not-a-file.md'), { recursive: true });
    assert.match(validateTasks(root).join('\n'), /红队审查包必须是文件/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Red Team 门禁拒绝伪造元数据和非批准结论', async () => {
  const root = await taskProject(completedFullTask(fullControl({
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/T-001-red-team.md',
    红队审查结论: '批准',
  })));
  try {
    await writeRedTeamPacket(root, { conclusion: '要求修改', reviewer: '另一审查者', taskId: 'T-OTHER' });
    const errors = validateTasks(root).join('\n');
    assert.match(errors, /任务编号.*不一致/u);
    assert.match(errors, /审查者.*不一致/u);
    assert.match(errors, /结论.*不一致/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Red Team 门禁阻断未修复 Critical/High 和无记录的 Medium 延期', async () => {
  const root = await taskProject(completedFullTask(fullControl({
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/T-001-red-team.md',
    红队审查结论: '批准',
  })));
  try {
    await writeRedTeamPacket(root, { findings: [
      { id: 'RT-001', severity: 'High', status: '开放' },
      { id: 'RT-002', severity: 'Medium', status: '延期' },
      { id: 'RT-003', severity: 'Critical', status: '延期' },
    ] });
    const errors = validateTasks(root).join('\n');
    assert.match(errors, /RT-001.*High.*必须已修复/u);
    assert.match(errors, /RT-002.*Medium.*延期记录/u);
    assert.match(errors, /RT-003.*Critical.*必须已修复/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Red Team 门禁接受有完整记录的 Medium 延期和开放 Low finding', async () => {
  const root = await taskProject(completedFullTask(fullControl({
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/T-001-red-team.md',
    红队审查结论: '批准',
  })));
  try {
    await writeRedTeamPacket(root, {
      deferrals: [{ id: 'RT-001' }],
      findings: [
        { id: 'RT-001', severity: 'Medium', status: '延期' },
        { id: 'RT-002', severity: 'Low', status: '开放' },
      ],
    });
    assert.deepEqual(validateTasks(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Red Team 门禁拒绝省略 separator 以隐藏首条 High finding', async () => {
  const root = await taskProject(completedFullTask(fullControl({
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/T-001-red-team.md',
    红队审查结论: '批准',
  })));
  try {
    await writeRedTeamPacket(root, { findings: [{ id: 'RT-001', severity: 'High', status: '开放' }] });
    const packetPath = path.join(root, 'docs/reviews/T-001-red-team.md');
    const body = await readFile(packetPath, 'utf8');
    await writeFile(packetPath, body.replace('| --- | --- | --- | --- | --- | --- | --- |\n', ''), 'utf8');
    assert.match(validateTasks(root).join('\n'), /问题列表.*separator/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Red Team 门禁拒绝用 HTML 注释隐藏批准审查包', async () => {
  const root = await taskProject(completedFullTask(fullControl({
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/T-001-red-team.md',
    红队审查结论: '批准',
  })));
  try {
    await writeRedTeamPacket(root);
    const packetPath = path.join(root, 'docs/reviews/T-001-red-team.md');
    const approved = await readFile(packetPath, 'utf8');
    const visible = approved.replace('\n批准\n', '\n要求修改\n');
    await writeFile(packetPath, `<!--\n${approved}\n-->\n${visible}`, 'utf8');
    assert.match(validateTasks(root).join('\n'), /HTML 注释/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Red Team 门禁拒绝重复结论 section', async () => {
  const root = await taskProject(completedFullTask(fullControl({
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/T-001-red-team.md',
    红队审查结论: '批准',
  })));
  try {
    await writeRedTeamPacket(root);
    const packetPath = path.join(root, 'docs/reviews/T-001-red-team.md');
    const body = await readFile(packetPath, 'utf8');
    await writeFile(packetPath, `${body}\n## 结论\n\n要求修改\n`, 'utf8');
    assert.match(validateTasks(root).join('\n'), /“结论”区块必须且只能出现一次/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Red Team 门禁忽略 fenced code block 内的伪造审查结构', async () => {
  const root = await taskProject(completedFullTask(fullControl({
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/T-001-red-team.md',
    红队审查结论: '批准',
  })));
  try {
    await writeRedTeamPacket(root);
    const packetPath = path.join(root, 'docs/reviews/T-001-red-team.md');
    const body = await readFile(packetPath, 'utf8');
    await writeFile(packetPath, `\`\`\`md\n${body}\n## end\n\`\`\`\n`, 'utf8');
    assert.match(validateTasks(root).join('\n'), /“结论”区块必须且只能出现一次/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Red Team 审查包允许在证据 section 保存 fenced 命令输出', async () => {
  const root = await taskProject(completedFullTask(fullControl({
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/T-001-red-team.md',
    红队审查结论: '批准',
  })));
  try {
    await writeRedTeamPacket(root);
    const packetPath = path.join(root, 'docs/reviews/T-001-red-team.md');
    const body = await readFile(packetPath, 'utf8');
    await writeFile(packetPath, body.replace('- `pnpm test` 退出码 0。', '```text\npnpm test\n<div>captured output</div>\nexit 0\n```'), 'utf8');
    assert.deepEqual(validateTasks(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Red Team 门禁拒绝重复表头覆盖 finding 严重度', async () => {
  const root = await taskProject(completedFullTask(fullControl({
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/T-001-red-team.md',
    红队审查结论: '批准',
  })));
  try {
    await writeRedTeamPacket(root, { findings: [{ id: 'RT-001', severity: 'High', status: '开放' }] });
    const packetPath = path.join(root, 'docs/reviews/T-001-red-team.md');
    const body = await readFile(packetPath, 'utf8');
    const forged = body
      .replace('| 问题编号 | 严重度 | 状态 | 位置 | 触发方式 | 影响 | 最小修复方向 |', '| 问题编号 | 严重度 | 状态 | 位置 | 触发方式 | 影响 | 最小修复方向 | 严重度 |')
      .replace('| --- | --- | --- | --- | --- | --- | --- |', '| --- | --- | --- | --- | --- | --- | --- | --- |')
      .replace('| RT-001 | High | 开放 | src/example.js | 测试触发 | 影响说明 | 最小修复 |', '| RT-001 | High | 开放 | src/example.js | 测试触发 | 影响说明 | 最小修复 | Low |');
    await writeFile(packetPath, forged, 'utf8');
    assert.match(validateTasks(root).join('\n'), /问题列表.*表头必须严格匹配/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Red Team 门禁拒绝 findings 表格列数漂移', async () => {
  const root = await taskProject(completedFullTask(fullControl({
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/T-001-red-team.md',
    红队审查结论: '批准',
  })));
  try {
    await writeRedTeamPacket(root, { findings: [{ id: 'RT-001', severity: 'Low', status: '开放' }] });
    const packetPath = path.join(root, 'docs/reviews/T-001-red-team.md');
    const body = await readFile(packetPath, 'utf8');
    await writeFile(packetPath, body.replace('| RT-001 | Low | 开放 | src/example.js | 测试触发 | 影响说明 | 最小修复 |', '| RT-001 | Low | 开放 | src/example.js | 测试触发 | 影响说明 | 最小修复 | 额外列 |'), 'utf8');
    assert.match(validateTasks(root).join('\n'), /问题列表.*列数/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Red Team 门禁拒绝 raw HTML block 隐藏批准结构', async () => {
  const root = await taskProject(completedFullTask(fullControl({
    红队审查者: '独立核验者',
    红队审查包: 'docs/reviews/T-001-red-team.md',
    红队审查结论: '批准',
  })));
  try {
    await writeRedTeamPacket(root);
    const packetPath = path.join(root, 'docs/reviews/T-001-red-team.md');
    const body = await readFile(packetPath, 'utf8');
    await writeFile(packetPath, `<pre>\n${body}\n## end\n</pre>\n`, 'utf8');
    assert.match(validateTasks(root).join('\n'), /raw HTML/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Red Team 门禁拒绝 CommonMark 非标签 raw HTML block', async () => {
  const wrappers = [
    (body) => `<![CDATA[\n${body}\n## end\n]]>\n`,
    (body) => `<?review\n${body}\n## end\n?>\n`,
    (body) => `<!DOCTYPE review\n${body}\n## end\n>\n`,
  ];
  for (const wrap of wrappers) {
    const root = await taskProject(completedFullTask(fullControl({
      红队审查者: '独立核验者',
      红队审查包: 'docs/reviews/T-001-red-team.md',
      红队审查结论: '批准',
    })));
    try {
      await writeRedTeamPacket(root);
      const packetPath = path.join(root, 'docs/reviews/T-001-red-team.md');
      const body = await readFile(packetPath, 'utf8');
      await writeFile(packetPath, wrap(body), 'utf8');
      assert.match(validateTasks(root).join('\n'), /raw HTML/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
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

function childControl(overrides = {}) {
  return fullControl({
    任务类型: '子任务',
    父任务编号: 'T-PARENT',
    冲突任务: [],
    时间盒分钟: 15,
    输入: ['父任务验收标准和前置验证输出'],
    输出格式: ['docs/reports/T-001.md，包含状态、变更、测试和风险'],
    不得修改范围: ['写入范围之外的所有文件'],
    ...overrides,
  });
}

test('子任务要求输入、输出格式和不得修改范围', async () => {
  const root = await taskProject(openFullTask(childControl({ 输入: undefined })));
  try {
    const errors = validateTasks(root).join('\n');
    assert.match(errors, /子任务缺少或未填写“输入”/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('子任务拒绝空的交接契约字段', async () => {
  const root = await taskProject(openFullTask(childControl({
    输入: [],
    输出格式: [''],
    不得修改范围: [],
  })));
  try {
    const errors = validateTasks(root).join('\n');
    assert.match(errors, /输入/u);
    assert.match(errors, /输出格式/u);
    assert.match(errors, /不得修改范围/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('合法子任务交接契约通过治理校验', async () => {
  const root = await taskProject(openFullTask(childControl()));
  try {
    assert.deepEqual(validateTasks(root), []);
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

test('治理资产只暴露 adapters、规则、skills 和 profiles catalog', async () => {
  const manifests = await loadAllManifests(rootDir);
  assert.deepEqual(Object.keys(manifests).sort(), ['adapters', 'profiles', 'rules', 'skills']);
  assert.equal(manifests.rules.items.some((item) => item.id === 'governance-core'), true);
  assert.equal(manifests.skills.items.find((item) => item.id === 'using-cognis')?.kind, 'router');
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
  assert.equal(sources.has('skills/core/using-cognis/SKILL.md'), true);
  assert.equal(sources.has('runtime/governance/lib/red-team-validation.mjs'), true);
  assert.equal([...sources].some((source) => source.startsWith('workflows/')), false);
  assert.equal(sources.has('templates/workflow-packet.md'), false);
});

test('治理资产定义 Red Team 完成门禁和结构化审查包', async () => {
  const [kernel, taskTemplate, deliveryTemplate, reviewSkill, reviewTemplate] = await Promise.all([
    readFile(path.join(rootDir, 'rules/governance-core.md'), 'utf8'),
    readFile(path.join(rootDir, 'templates/task.md'), 'utf8'),
    readFile(path.join(rootDir, 'templates/delivery.md'), 'utf8'),
    readFile(path.join(rootDir, 'skills/core/adversarial-review-packet/SKILL.md'), 'utf8'),
    readFile(path.join(rootDir, 'skills/core/adversarial-review-packet/references/review.md'), 'utf8'),
  ]);
  for (const fragment of ['Red Team（红队审查）', '红队审查包', '批准']) {
    assert.match(`${kernel}\n${taskTemplate}\n${deliveryTemplate}\n${reviewSkill}`, new RegExp(fragment, 'u'));
  }
  assert.match(deliveryTemplate, /^- Red Team：/mu);
  for (const fragment of ['任务编号', '审查者', '审查对象', '审查时间', '状态', 'Medium 延期', '未覆盖审查轴与剩余风险']) {
    assert.match(reviewTemplate, new RegExp(fragment, 'u'));
  }
});

test('治理资产定义 Small Change 和 Fan-out/Fan-in 契约', async () => {
  const [coding, collaboration, subagent, task] = await Promise.all([
    readFile(path.join(rootDir, 'rules/coding-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/ai-collab-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'skills/core/subagent-driven-development/SKILL.md'), 'utf8'),
    readFile(path.join(rootDir, 'templates/task.md'), 'utf8'),
  ]);
  assert.match(coding, /一个任务只解决一个问题/u);
  assert.match(coding, /格式化.*业务/u);
  assert.match(collaboration, /Fan-out/u);
  assert.match(collaboration, /Fan-in/u);
  assert.match(subagent, /输出格式/u);
  assert.match(task, /不得修改范围/u);
});

test('AI 协作规则定义自适应信息呈现契约', async () => {
  const [collaboration, routing, capabilities] = await Promise.all([
    readFile(path.join(rootDir, 'rules/ai-collab-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/agent-skill-routing.md'), 'utf8'),
    readJson(path.join(rootDir, 'manifests/capabilities.json')),
  ]);
  for (const fragment of [
    '信息呈现', '目标、范围、约束、验收标准、待决策项',
    '`- [ ]` / `- [x]`', 'Markdown 表格', '信息块',
    '顺序流程', '并列要点', '代码、日志、JSON 和命令输出',
    '原始缩进、换行和字面量', '不嵌套信息块', '装饰性卡片',
    '简单回答', '用户明确指定格式',
  ]) {
    assert.match(collaboration, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.match(routing, /ai-collab-rules\.md.*复杂输入|复杂输入.*ai-collab-rules\.md/u);
  const capability = capabilities.items.find((item) => item.id === 'adaptive-information-presentation');
  assert.ok(capability, 'adaptive-information-presentation capability should be declared');
  assert.deepEqual(capability.profiles, ['core', 'full', 'docs-only']);
  assert.deepEqual(capability.evaluation.suites, ['evals/suites/cognis-core.json']);
});

test('治理内核和交付模板定义任务确认与完整会话交付', async () => {
  const kernel = await readFile(path.join(rootDir, 'rules/governance-core.md'), 'utf8');
  const agents = await readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8');
  const delivery = await readFile(path.join(rootDir, 'templates/delivery.md'), 'utf8');

  for (const fragment of ['任务确认', '验证计划', '非目标', '红区']) {
    assert.match(`${kernel}\n${agents}`, new RegExp(fragment, 'u'));
  }
  for (const fragment of [
    '结果状态', '变更摘要', '影响范围', '工作流档位', '验证证据', '未验证项',
    '剩余风险', 'Git 状态', 'Worktree / 分支 / merge-back 状态', '后续动作', 'Memory',
  ]) {
    assert.match(delivery, new RegExp(fragment.replaceAll('/', '\\/'), 'u'));
  }
  assert.match(delivery, /^- 验证证据：/mu);
  assert.match(delivery, /^- 未验证项：/mu);
  assert.match(delivery, /完成 \/ 未完成 \/ 阻塞 \/ 中断/u);
});

test('常驻治理表面不超过九十行', async () => {
  const agents = await readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8');
  const core = await readFile(path.join(rootDir, 'rules/governance-core.md'), 'utf8');
  const lines = agents.split(/\r?\n/u).length + core.split(/\r?\n/u).length;
  assert.ok(lines <= 90, `常驻治理表面当前为 ${lines} 行`);
});
