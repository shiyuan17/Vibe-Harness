import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadAllManifests,
  validateCatalogManifest,
  validateJsonAgainstSchema,
  validateInstallMapShape,
  validateManifestSources,
  readJson,
} from '../scripts/lib/manifest.js';
import { findInvalidSkillDirs, validateGovernanceQuality, validatePack } from '../scripts/lib/pack-validation.js';

const rootDir = path.resolve('.');

test('manifests expose required rule, skill, workflow, and profile catalogs', async () => {
  const manifests = await loadAllManifests(rootDir);

  assert.ok(manifests.rules.items.length >= 10);
  assert.ok(manifests.skills.items.some((item) => item.id === 'task-intake'));
  assert.ok(manifests.workflows.items.some((item) => item.id === 'full'));
  assert.ok(manifests.profiles.items.some((item) => item.id === 'codex-internal'));
});

test('manifest source files all exist', async () => {
  const manifests = await loadAllManifests(rootDir);
  const missing = await validateManifestSources(rootDir, manifests);

  assert.deepEqual(missing, []);
});

test('structural remediation assets are declared and installed', async () => {
  const manifests = await loadAllManifests(rootDir);
  const installMap = await readJson(path.join(rootDir, 'adapters/codex/install-map.json'));
  const ruleIds = new Set(manifests.rules.items.map((item) => item.id));
  const installedSources = new Set(installMap.entries.map((entry) => entry.source));

  assert.equal(ruleIds.has('handoff-rules'), true);
  assert.equal(ruleIds.has('retrospective-rules'), true);
  assert.equal(installedSources.has('rules/handoff-rules.md'), true);
  assert.equal(installedSources.has('rules/retrospective-rules.md'), true);
  assert.equal(installedSources.has('schemas/task.schema.json'), true);
});

test('README documents the MVP and legacy command surfaces distinctly', async () => {
  const readme = await readFile(path.join(rootDir, 'README.md'), 'utf8');
  const readmeZh = await readFile(path.join(rootDir, 'README.zh-CN.md'), 'utf8');

  for (const content of [readme, readmeZh]) {
    assert.equal(content.includes('--project <path> --target codex --write'), true);
    assert.equal(content.includes('--target <path> --apply --confirm-red-zone'), true);
    assert.equal(content.includes('pnpm check'), true);
    assert.equal(content.includes('工作流 / 模板质量门禁'), true);
  }
});

test('task schema accepts complete tasks and rejects missing verification', async () => {
  const schema = await readJson(path.join(rootDir, 'schemas/task.schema.json'));
  const validTask = {
    id: 'T-001-C1',
    title: 'Strengthen workflow template',
    phase: 'ready',
    status: 'idle',
    resolution: 'open',
    goal: 'Make the template executable by agents.',
    acceptanceCriteria: ['Template declares required fields.'],
    nonGoals: ['No runtime code changes.'],
    writeScope: ['templates/workflow-packet.md'],
    forbiddenActions: ['Do not edit unrelated templates.'],
    verification: ['pnpm check'],
    stopCondition: 'Required fields are present and validation passes.',
    rollbackPlan: 'Revert the template and validation changes.',
  };

  assert.deepEqual(validateJsonAgainstSchema(validTask, schema, 'task'), []);
  assert.match(
    validateJsonAgainstSchema({ ...validTask, verification: [] }, schema, 'task').join('\n'),
    /task\.verification must contain at least 1 item/,
  );
});

test('manifest schema validation rejects missing sources and duplicate ids', () => {
  assert.throws(
    () => validateCatalogManifest('rules', { schemaVersion: 1, items: [{ id: 'quickstart' }] }),
    /rules.items\[0\].source is required/,
  );
  assert.throws(
    () => validateCatalogManifest('rules', {
      schemaVersion: 1,
      items: [
        { id: 'quickstart', source: 'rules/quickstart.md' },
        { id: 'quickstart', source: 'rules/quickstart-copy.md' },
      ],
    }),
    /Duplicate manifest id/,
  );
});

test('install-map schema validation rejects unknown groups and unsafe red-zone mappings', () => {
  assert.throws(
    () => validateInstallMapShape(
      { adapter: 'codex', entries: [{ group: 'unknown', source: 'rules/quickstart.md', target: 'docs/rules/quickstart.md' }] },
      new Set(['rules']),
    ),
    /Unknown install-map group/,
  );
  assert.throws(
    () => validateInstallMapShape(
      { adapter: 'codex', entries: [{ group: 'hooks', source: 'adapters/codex/hooks.template.json', target: '.codex/hooks.json' }] },
      new Set(['hooks']),
    ),
    /must be marked redZone/,
  );
  assert.throws(
    () => validateInstallMapShape(
      {
        adapter: 'codex',
        entries: [
          { group: 'rules', source: 'rules/a.md', target: 'docs/rules/a.md' },
          { group: 'rules', source: 'rules/b.md', target: 'docs/rules/a.md' },
        ],
      },
      new Set(['rules']),
    ),
    /Duplicate install target/,
  );
  assert.throws(
    () => validateInstallMapShape(
      { adapter: 'codex', entries: [{ group: 'rules', source: '../rules/a.md', target: 'docs/rules/a.md' }] },
      new Set(['rules']),
    ),
    /portable relative path/,
  );
  assert.throws(
    () => validateInstallMapShape(
      { adapter: 'codex', entries: [{ group: 'rules', source: 'rules/a.md', target: '/tmp/escape.md' }] },
      new Set(['rules']),
    ),
    /portable relative path/,
  );
  assert.throws(
    () => validateInstallMapShape(
      { adapter: 'codex', entries: [{ group: 'rules', source: 'rules/a.md', target: 'docs/../escape.md' }] },
      new Set(['rules']),
    ),
    /portable relative path/,
  );
});

test('every declared skill is installed by the codex install map', async () => {
  const manifests = await loadAllManifests(rootDir);
  const installMap = await readJson(path.join(rootDir, 'adapters/codex/install-map.json'));
  const installedSources = new Set(installMap.entries.map((entry) => entry.source));

  const missing = manifests.skills.items
    .filter((item) => !installedSources.has(item.source))
    .map((item) => item.id)
    .sort();

  assert.deepEqual(missing, []);
});

test('skill directory validation rejects empty skill shells', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-empty-skills-'));
  try {
    await mkdir(path.join(target, 'skills/core/empty-shell'), { recursive: true });
    await mkdir(path.join(target, 'skills/core/real-skill'), { recursive: true });
    await writeFile(path.join(target, 'skills/core/real-skill/SKILL.md'), '# Real Skill\n', 'utf8');

    const invalid = await findInvalidSkillDirs(target);

    assert.deepEqual(invalid, ['skills/core/empty-shell']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('pack validation enforces governance document quality gates', async () => {
  const report = await validatePack(rootDir);

  assert.deepEqual(report.governanceQualityErrors, []);
});

test('governance quality validation rejects hollow workflow and template files', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-hollow-governance-'));
  try {
    await mkdir(path.join(target, 'workflows'), { recursive: true });
    await mkdir(path.join(target, 'templates'), { recursive: true });
    await mkdir(path.join(target, 'rules'), { recursive: true });
    await writeFile(path.join(target, 'workflows/full.md'), '# Full\n一句话说明。\n', 'utf8');
    await writeFile(path.join(target, 'templates/spec-template.md'), '# Spec\n\n## 目标\n', 'utf8');
    await writeFile(path.join(target, 'rules/test-rules.md'), '# Test\n\n- 运行测试。\n', 'utf8');

    const errors = await validateGovernanceQuality(target);

    assert.match(errors.join('\n'), /workflows\/full\.md.*阶段目标/);
    assert.match(errors.join('\n'), /templates\/spec-template\.md.*必填/);
    assert.match(errors.join('\n'), /rules\/test-rules\.md.*验收矩阵/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('JSON schema validation rejects additional properties and missing required fields', () => {
  const schema = {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1 },
      tags: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
        uniqueItems: true,
      },
    },
    additionalProperties: false,
  };

  assert.deepEqual(validateJsonAgainstSchema({ id: 'ok', tags: ['a'] }, schema, 'sample'), []);
  assert.match(
    validateJsonAgainstSchema({ id: 'ok', extra: true }, schema, 'sample').join('\n'),
    /sample\.extra is not allowed/,
  );
  assert.match(
    validateJsonAgainstSchema({ tags: ['a'] }, schema, 'sample').join('\n'),
    /sample\.id is required/,
  );
  assert.match(
    validateJsonAgainstSchema({ id: 'ok', tags: ['a', 'a'] }, schema, 'sample').join('\n'),
    /sample\.tags must contain unique items/,
  );
});
