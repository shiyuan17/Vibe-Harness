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
