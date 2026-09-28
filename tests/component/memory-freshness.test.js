import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  MEMORY_FRESHNESS_GRACE_DAYS,
  memoryFreshnessViolations,
  validateMemoryFreshness,
} from '../../scripts/lib/pack-validation.js';

const rootDir = path.resolve(import.meta.dirname, '../..');

async function loadStarterBodies() {
  const current = await readFile(path.join(rootDir, 'memory/CURRENT.md'), 'utf8');
  const state = await readFile(path.join(rootDir, 'templates/memory/PROJECT_STATE.md'), 'utf8');
  return { current, state };
}

function withDate(body, value) {
  return body.replaceAll(/^- 最后更新:.*$/gmu, `- 最后更新: ${value}`);
}

test('记忆新鲜度宽限锁定为 1 天', () => {
  assert.equal(MEMORY_FRESHNESS_GRACE_DAYS, 1);
});

test('starter 模板占位日期不参与新鲜度比对', async () => {
  const { current, state } = await loadStarterBodies();
  assert.deepEqual(memoryFreshnessViolations(current, state, '2026-09-22'), []);
});

test('最后更新落后不超过 1 天宽限时无违规', () => {
  assert.deepEqual(memoryFreshnessViolations('- 最后更新: 2026-09-21', '- 最后更新: 2026-09-21', '2026-09-22'), []);
});

test('负控：最后更新落后超 1 天宽限时按文件报违规', () => {
  assert.deepEqual(
    memoryFreshnessViolations('- 最后更新: 2026-09-19', '- 最后更新: 2026-09-20', '2026-09-22'),
    [
      '.agents/memory/CURRENT.md 最后更新 (2026-09-19) is 3 days behind HEAD (2026-09-22); refresh the memory entry',
      'docs/memory/PROJECT_STATE.md 最后更新 (2026-09-20) is 2 days behind HEAD (2026-09-22); refresh the memory entry',
    ],
  );
});

test('负控：占位日期替换为陈旧真实日期后报违规', async () => {
  const { current } = await loadStarterBodies();
  const mutated = withDate(current, '2026-09-19');
  assert.deepEqual(memoryFreshnessViolations(mutated, null, '2026-09-22'), [
    '.agents/memory/CURRENT.md 最后更新 (2026-09-19) is 3 days behind HEAD (2026-09-22); refresh the memory entry',
  ]);
});

test('负控：缺失的文件跳过自身、不虚报另一份文件', () => {
  assert.deepEqual(memoryFreshnessViolations(null, null, '2026-09-22'), []);
  assert.deepEqual(memoryFreshnessViolations('- 最后更新: 2026-09-19', null, '2026-09-22'), [
    '.agents/memory/CURRENT.md 最后更新 (2026-09-19) is 3 days behind HEAD (2026-09-22); refresh the memory entry',
  ]);
});

test('负控：HEAD 日期不可得时 fail-closed 报不可核验', () => {
  assert.deepEqual(memoryFreshnessViolations('- 最后更新: 2026-09-22', null, null), [
    'HEAD committer date is unavailable; memory freshness cannot be verified',
  ]);
});

test('真实仓库记忆新鲜度核验通过', async () => {
  assert.deepEqual(await validateMemoryFreshness(rootDir), []);
});
