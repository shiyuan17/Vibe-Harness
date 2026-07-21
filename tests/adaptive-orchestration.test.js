import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const rootDir = path.resolve('.');

async function readContract(relativePath) {
  return readFile(path.join(rootDir, relativePath), 'utf8');
}

test('adaptive routing keeps simple request types on a single agent', async () => {
  const [governance, collaboration, routing] = await Promise.all([
    readContract('rules/governance-core.md'),
    readContract('rules/ai-collab-rules.md'),
    readContract('rules/agent-skill-routing.md'),
  ]);

  assert.match(governance, /风险分级[\s\S]*需求分类[\s\S]*编排判定/u);
  assert.match(governance, /轻量[\s/、和或与]*(?:完整|完整档)[\s\S]{0,160}需求类型[\s\S]{0,160}编排模式[\s\S]{0,160}判定依据/u);
  assert.match(governance, /快速[\s\S]{0,100}(?:保持|维持|只需).*简洁/u);

  assert.match(collaboration, /文档查询[\s、/和或与]*代码定位[\s、/和或与]*只读解释[\s\S]{0,120}单 Agent/u);
  assert.match(collaboration, /文案修改[\s、/和或与]*局部样式[\s、/和或与]*单页面调整[\s\S]{0,120}单 Agent/u);
  assert.match(collaboration, /单模块功能[\s、/和或与]*小型缺陷修复[\s\S]{0,120}单 Agent/u);
  assert.match(routing, /(?:查询|文档)[\s\S]{0,120}(?:局部页面|页面调整)[\s\S]{0,120}(?:固定|保持|默认)[\s\S]{0,40}单 Agent/u);
});

test('multi-agent admission is all-of, bounded, and degrades safely', async () => {
  const [collaboration, routing] = await Promise.all([
    readContract('rules/ai-collab-rules.md'),
    readContract('rules/agent-skill-routing.md'),
  ]);

  assert.match(collaboration, /至少两个[\s\S]{0,80}独立验收/u);
  assert.match(collaboration, /输入[、/和或与]*输出[、/和或与]*(?:写入)?范围[、/和或与]*依赖[\s\S]{0,100}(?:固定|明确)/u);
  assert.match(collaboration, /同批[\s\S]{0,100}写入范围不重叠/u);
  assert.match(collaboration, /每个 child[\s\S]{0,100}(?:确定性|可重复)[\s\S]{0,50}验证[\s\S]{0,100}父任务[\s\S]{0,50}集成验证/u);
  assert.match(collaboration, /(?:平台|adapter)[\s\S]{0,80}(?:真实|原生)[\s\S]{0,40}(?:子 Agent|多 Agent)[\s\S]{0,120}收益[\s\S]{0,80}(?:成本|开销)/u);
  assert.match(collaboration, /(?:全部|同时)满足[\s\S]{0,120}(?:才|方可|才能)[\s\S]{0,40}(?:启用|使用|进入)[\s\S]{0,30}多 Agent/u);
  assert.match(collaboration, /复杂(?:可拆)?任务[\s\S]{0,160}(?:至少两个|两个以上)[\s\S]{0,80}独立验收[\s\S]{0,120}(?:自动|无需额外确认)[\s\S]{0,50}多 Agent/u);

  assert.match(collaboration, /共享(?:契约|文件|边界)[\s\S]{0,120}(?:单 Agent|串行)/u);
  assert.match(collaboration, /(?:尽量多用|多用)[\s\S]{0,80}Agent[\s\S]{0,120}(?:不得|不能)[\s\S]{0,80}(?:绕过|替代)[\s\S]{0,60}(?:门禁|准入)/u);
  assert.match(collaboration, /能力不可用[\s\S]{0,100}(?:降级|回退)[\s\S]{0,40}单 Agent[\s\S]{0,120}(?:不得|不能)[\s\S]{0,60}(?:模拟|虚构)/u);
  assert.match(collaboration, /(?:新手|标准|专家|交互偏好)[\s\S]{0,180}(?:不影响|不得改变)[\s\S]{0,100}(?:安全|风险|验证|编排)/u);
  assert.match(routing, /(?:满足|通过)[\s\S]{0,80}(?:拆分门禁|准入条件)[\s\S]{0,100}(?:完整任务|完整档)[\s\S]{0,120}`subagent-driven-development`/u);
});

test('subagent execution is capped, fail-stopped, and independently verified', async () => {
  const skill = await readContract('skills/core/subagent-driven-development/SKILL.md');

  assert.match(skill, /(?:默认)?最多[\s\S]{0,30}(?:3|三)个[\s\S]{0,50}(?:ready|就绪)[\s\S]{0,30}child/u);
  assert.match(skill, /adapter[\s\S]{0,100}(?:降低|收紧)[\s\S]{0,60}(?:并发|上限)/u);
  assert.match(skill, /连续[\s\S]{0,20}(?:3|三)次[\s\S]{0,50}(?:验证)?失败[\s\S]{0,100}(?:停止|阻塞)[\s\S]{0,80}(?:上报|父 Agent)/u);
  assert.match(skill, /(?:Build|实现)[\s\S]{0,80}(?:不得|不能)[\s\S]{0,80}(?:修改|放宽)[\s\S]{0,50}验收(?:标准|条件)/u);
  assert.match(skill, /(?:Judge|Reviewer|核验者)[\s\S]{0,80}(?:必须|保持)[\s\S]{0,40}独立/u);
  assert.match(skill, /父 Agent[\s\S]{0,120}(?:fan-in|Fan-in)[\s\S]{0,160}(?:实际 diff|实际变更)[\s\S]{0,160}(?:重新运行|复验)[\s\S]{0,60}集成验证/u);
  assert.match(skill, /(?:不得|不能)[\s\S]{0,60}(?:再委派|创建孙任务)/u);
});
