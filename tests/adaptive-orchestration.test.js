import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const rootDir = path.resolve('.');
const readContract = (relativePath) => readFile(path.join(rootDir, relativePath), 'utf8');

test('adaptive routing keeps simple work direct and single-Agent by default', async () => {
  const [governance, collaboration, routing] = await Promise.all([
    readContract('rules/governance-core.md'),
    readContract('rules/ai-collab-rules.md'),
    readContract('rules/agent-skill-routing.md'),
  ]);
  assert.match(governance, /获取事实 → 直接执行 → 聚焦验证 → 简洁交付/u);
  assert.match(governance, /不要求工具前任务确认、计划批准或任务文档/u);
  assert.match(governance, /单 Agent 默认/u);
  assert.match(governance, /确认前整个工作区保持只读/u);
  assert.match(collaboration, /单 Agent/u);
  assert.match(routing, /不使用 Router 或流程 Skill 链/u);
  assert.match(routing, /同一阶段默认只加载一个 Skill/u);
});

test('multi-Agent remains a runtime admission decision, not a Skill chain', async () => {
  const [governance, collaboration, skills] = await Promise.all([
    readContract('rules/governance-core.md'),
    readContract('rules/ai-collab-rules.md'),
    readContract('manifests/skills.json').then(JSON.parse),
  ]);
  assert.match(governance, /边界独立、验证独立且预计有明确墙钟收益/u);
  assert.match(governance, /父 Agent 单一派发与 fan-in/u);
  assert.match(collaboration, /至少两个[\s\S]{0,100}独立验收/u);
  assert.match(collaboration, /共享(?:契约|文件|边界)[\s\S]{0,120}(?:单 Agent|串行)/u);
  assert.equal(skills.items.some((item) => item.id === 'subagent-driven-development'), false);
});

test('failure stop and independent verification stay in governance and task runtime', async () => {
  const [governance, collaboration, taskTemplate] = await Promise.all([
    readContract('rules/governance-core.md'),
    readContract('rules/ai-collab-rules.md'),
    readContract('templates/task.md'),
  ]);
  assert.match(governance, /同一失败连续三次无进展时停止/u);
  assert.match(collaboration, /Judge|Reviewer|核验/u);
  assert.match(collaboration, /fan-in|Fan-in/u);
  assert.match(taskTemplate, /不得修改范围/u);
});
