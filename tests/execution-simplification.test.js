import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

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
