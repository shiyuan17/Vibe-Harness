import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  MEMORY_ENTRY_FIELD_LABELS,
  memoryEntryViolations,
  validateMemoryEntry,
} from '../../scripts/lib/pack-validation.js';

const rootDir = path.resolve(import.meta.dirname, '../..');
const alwaysValidCommit = () => ({ exists: true, ancestorOfHead: true });

async function loadEntryBodies() {
  const starter = await readFile(path.join(rootDir, 'memory/CURRENT.md'), 'utf8');
  const live = await readFile(path.join(rootDir, '.agents/memory/CURRENT.md'), 'utf8');
  return { starter, live };
}

function withLine(body, label, value) {
  return body.replaceAll(new RegExp(`^- ${label}:.*$`, 'gmu'), `- ${label}: ${value}`);
}

test('memory 入口契约锁定单一入口字段集', () => {
  assert.deepEqual(MEMORY_ENTRY_FIELD_LABELS, [
    '目标',
    '当前状态',
    '已验证证据',
    '未完成事项',
    '下一步最小动作',
    '锚点提交',
    '最后更新',
    '最后验证',
  ]);
});

test('starter 与 dogfood 的 CURRENT.md 同时满足单一入口契约', async () => {
  const { starter, live } = await loadEntryBodies();
  assert.deepEqual(memoryEntryViolations(starter, true, alwaysValidCommit), []);
  assert.deepEqual(memoryEntryViolations(live, true, alwaysValidCommit), []);
});

test('真实仓库通过 HEAD 绑定核验', async () => {
  assert.deepEqual(await validateMemoryEntry(rootDir), []);
});

test('负控：丢失治理记忆引用时只报引用违规', async () => {
  const { starter } = await loadEntryBodies();
  const mutated = starter.replaceAll('docs/memory/PROJECT_STATE.md', 'docs/memory/MISSING.md');
  assert.deepEqual(memoryEntryViolations(mutated, true, alwaysValidCommit), [
    '.agents/memory/CURRENT.md must reference docs/memory/PROJECT_STATE.md instead of duplicating it',
  ]);
});

test('负控：复制 PROJECT_STATE 字段时只报引用不复制违规', async () => {
  const { starter } = await loadEntryBodies();
  const mutated = `${starter}- 当前阶段: 复制来的项目阶段`;
  assert.deepEqual(memoryEntryViolations(mutated, true, alwaysValidCommit), [
    '.agents/memory/CURRENT.md must reference docs/memory/PROJECT_STATE.md instead of copying its field: 当前阶段',
  ]);
});

test('负控：锚点提交不是 HEAD 祖先时报漂移违规', async () => {
  const { starter } = await loadEntryBodies();
  const driftedSha = 'a'.repeat(40);
  const mutated = withLine(starter, '锚点提交', driftedSha);
  assert.deepEqual(memoryEntryViolations(mutated, true, () => ({ exists: true, ancestorOfHead: false })), [
    `anchor commit ${driftedSha} is not an ancestor of HEAD; the memory entry drifted from this history`,
  ]);
});

test('负控：锚点提交不可解析与残缺 SHA 各自报锚点违规', async () => {
  const { starter } = await loadEntryBodies();
  const unknownSha = 'b'.repeat(40);
  const unknown = withLine(starter, '锚点提交', unknownSha);
  assert.deepEqual(memoryEntryViolations(unknown, true, () => ({ exists: false, ancestorOfHead: false })), [
    `anchor commit ${unknownSha} does not exist in this repository history`,
  ]);
  const short = withLine(starter, '锚点提交', '6bdf300');
  assert.deepEqual(memoryEntryViolations(short, true, alwaysValidCommit), [
    '锚点提交 must be the full 40-character commit SHA of the HEAD at update time',
  ]);
});

test('负控：日期字段使用相对表达时报绝对日期违规', async () => {
  const { starter } = await loadEntryBodies();
  const mutated = withLine(starter, '最后更新', '昨天');
  assert.deepEqual(memoryEntryViolations(mutated, true, alwaysValidCommit), [
    '最后更新 must be an absolute YYYY-MM-DD date, got: 昨天',
  ]);
});

test('负控：缺少锚点提交字段时只报字段缺失', async () => {
  const { starter } = await loadEntryBodies();
  const mutated = starter.replaceAll(/^- 锚点提交:[^\n]*\n/gmu, '');
  assert.deepEqual(memoryEntryViolations(mutated, true, alwaysValidCommit), [
    '.agents/memory/CURRENT.md must keep the field: 锚点提交',
  ]);
});
