import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const rootDir = path.resolve('.');
const clarifyDir = path.join(rootDir, 'skills/core/clarify-requirements');

test('clarification Skill is self-contained and does not generate specifications by default', async () => {
  const files = await readdir(clarifyDir, { recursive: true });
  const skill = await readFile(path.join(clarifyDir, 'SKILL.md'), 'utf8');
  assert.deepEqual(files.sort(), ['SKILL.md', 'agents', 'agents/openai.yaml', 'metadata.json']);
  assert.match(skill, /除非用户要求，不创建规格文档/u);
  assert.match(skill, /回答关闭分支后立即继续/u);
  assert.doesNotMatch(skill, /visual companion|浏览器辅助|本地服务器/iu);
});

test('clarification Skill excludes discoverable facts, implementation choices, and approvals', async () => {
  const skill = await readFile(path.join(clarifyDir, 'SKILL.md'), 'utf8');
  for (const term of ['安全审批', '阻塞产品决定', '可逆实现选择', '最多三个', '推荐项']) {
    assert.match(skill, new RegExp(term, 'u'));
  }
  assert.match(skill, /不要向用户询问可发现事实/u);
  assert.match(skill, /实现选择沿用仓库惯例/u);
});
