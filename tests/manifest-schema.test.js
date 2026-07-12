import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  loadAllManifests,
  readJson,
  validateCatalogManifest,
  validateInstallMapShape,
  validateJsonAgainstSchema,
  validateManifestSources,
} from '../scripts/lib/manifest.js';
import { validateCapabilityMatrix, validatePack } from '../scripts/lib/pack-validation.js';

const rootDir = path.resolve('.');

test('manifests expose profiles, rules, and skills only', async () => {
  const manifests = await loadAllManifests(rootDir);
  assert.deepEqual(Object.keys(manifests).sort(), ['profiles', 'rules', 'skills']);
  assert.equal(manifests.rules.items.some((item) => item.id === 'governance-core'), true);
  assert.equal(manifests.skills.items.some((item) => item.id === 'using-loopengine'), true);
  assert.equal(manifests.profiles.items.some((item) => item.id === 'codex-internal'), true);
});

test('manifest source files all exist', async () => {
  assert.deepEqual(await validateManifestSources(rootDir, await loadAllManifests(rootDir)), []);
});

test('full task control schema rejects missing and unknown Chinese fields', async () => {
  const schema = await readJson(path.join(rootDir, 'schemas/full-task-control.schema.json'));
  const sample = {
    任务类型: '单任务', 责任角色: '实现负责人', 写入范围: ['src/a.js'], 禁止动作: ['覆盖无关改动'],
    依赖任务: [], 并行安全: '独占写入', 停止条件: '验证完成', 回滚方案: '恢复文件', 人工确认: '不需要',
    核验者: '独立核验者', 合并回主线状态: '不需要',
  };
  assert.deepEqual(validateJsonAgainstSchema(sample, schema, '控制'), []);
  assert.match(validateJsonAgainstSchema({ ...sample, 核验者: undefined }, schema, '控制').join('\n'), /核验者/u);
  assert.match(validateJsonAgainstSchema({ ...sample, 额外字段: true }, schema, '控制').join('\n'), /额外字段/u);
});

test('manifest validation rejects missing sources and duplicate ids', () => {
  assert.throws(() => validateCatalogManifest('rules', { schemaVersion: 1, items: [{ id: 'core' }] }), /source is required/u);
  assert.throws(() => validateCatalogManifest('rules', { schemaVersion: 1, items: [
    { id: 'core', source: 'rules/governance-core.md' },
    { id: 'core', source: 'rules/codebase-memory-mcp.md' },
  ] }), /Duplicate manifest id/u);
});

test('install map validation rejects unknown groups and unsafe red-zone mappings', () => {
  assert.throws(() => validateInstallMapShape({ adapter: 'codex', entries: [
    { group: 'unknown', source: 'rules/governance-core.md', target: 'docs/rules/governance-core.md' },
  ] }, new Set(['rules-minimal'])), /Unknown install-map group/u);
  assert.throws(() => validateInstallMapShape({ adapter: 'codex', entries: [
    { group: 'rules-minimal', source: 'rules/governance-core.md', target: '.codex/hooks.json' },
  ] }, new Set(['rules-minimal'])), /redZone/u);
});

test('install map validation accepts explicit retired entries and rejects unsafe retirement declarations', () => {
  const valid = {
    adapter: 'codex',
    entries: [
      { group: 'skills-memory', source: 'skills/integrations/agentmemory/SKILL.md', target: '.agents/skills/agentmemory/SKILL.md' },
    ],
    retiredEntries: [
      { group: 'skills-memory', target: '.agents/skills/recall/SKILL.md' },
    ],
  };
  assert.doesNotThrow(() => validateInstallMapShape(valid, new Set(['skills-memory'])));
  assert.throws(() => validateInstallMapShape({
    ...valid,
    retiredEntries: [{ group: 'missing', target: '.agents/skills/recall/SKILL.md' }],
  }, new Set(['skills-memory'])), /Unknown retired install-map group/u);
  assert.throws(() => validateInstallMapShape({
    ...valid,
    retiredEntries: [{ group: 'skills-memory', target: '../escape/SKILL.md' }],
  }, new Set(['skills-memory'])), /portable relative path/u);
  assert.throws(() => validateInstallMapShape({
    ...valid,
    retiredEntries: [{ group: 'skills-memory', target: '.agents/skills/agentmemory/SKILL.md' }],
  }, new Set(['skills-memory'])), /conflicts with active install target/u);
  assert.throws(() => validateInstallMapShape({
    ...valid,
    retiredEntries: [
      { group: 'skills-memory', target: '.agents/skills/recall/SKILL.md' },
      { group: 'skills-memory', target: '.agents/skills/recall/SKILL.md' },
    ],
  }, new Set(['skills-memory'])), /Duplicate retired install target/u);
  assert.throws(() => validateInstallMapShape({
    ...valid,
    retiredEntries: [{ group: 'skills-memory', target: '.codex/hooks.json' }],
  }, new Set(['skills-memory'])), /Red-zone retired target must be marked redZone/u);
  assert.throws(() => validateInstallMapShape({
    ...valid,
    retiredEntries: [{ group: 'skills-memory', target: '.agents/skills/recall/SKILL.md', source: 'legacy.md' }],
  }, new Set(['skills-memory'])), /source is not allowed/u);
});

test('capability matrix maps every reusable capability to current assets', async () => {
  const matrix = await readJson(path.join(rootDir, 'manifests/capabilities.json'));
  assert.deepEqual(await validateCapabilityMatrix(rootDir, matrix), []);
});

test('complete pack validates', async () => {
  const report = await validatePack(rootDir);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});
