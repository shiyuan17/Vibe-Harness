import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pathExists, readJson } from '../scripts/lib/manifest.js';

const rootDir = path.resolve('.');
const validatorPath = path.join(rootDir, 'scripts/lib/docs-validation.js');

async function loadValidator() {
  assert.equal(await pathExists(validatorPath), true, 'documentation validator is missing');
  return import('../scripts/lib/docs-validation.js');
}

test('repository declares the documentation governance contract', async () => {
  for (const file of [
    'CONTRIBUTING.md',
    'docs/README.md',
    'docs/catalog.json',
    'schemas/docs-catalog.schema.json',
    'scripts/docs-audit.js',
    'scripts/lib/docs-validation.js',
    '.github/pull_request_template.md',
  ]) {
    assert.equal(await pathExists(path.join(rootDir, file)), true, `${file} is missing`);
  }
});

test('repository ignores project-local LoopEngine runtime state', async () => {
  const gitignore = await readFile(path.join(rootDir, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.loopengine\/$/mu);
});

test('source mapping points only at current governance assets', async () => {
  const mapping = await readFile(path.join(rootDir, 'docs/inventory/source-rules-mapping.md'), 'utf8');
  for (const retired of ['rules/workflow.md', 'rules/dynamic-workflow.md', 'rules/task-lifecycle.md']) {
    assert.equal(mapping.includes(retired), false, `retired source mapping remains: ${retired}`);
  }
  for (const current of [
    'rules/governance-core.md',
    'templates/task.md',
    'skills/core/adversarial-review-packet/SKILL.md',
  ]) {
    assert.equal(mapping.includes(current), true, `current source mapping is missing: ${current}`);
    assert.equal(await pathExists(path.join(rootDir, current)), true, `mapped target is missing: ${current}`);
  }
});

test('documentation catalog covers the governed knowledge base and passes policy checks', async () => {
  const { validateDocumentation } = await loadValidator();
  const report = await validateDocumentation({ rootDir });
  assert.deepEqual(report.errors, [], JSON.stringify(report, null, 2));
  assert.equal(report.counts.cataloged > 0, true);
  assert.equal(report.counts.governed, report.counts.cataloged);
});

test('documentation catalog rejects duplicates and invalid historical relationships', async () => {
  const { validateDocumentation } = await loadValidator();
  const catalog = await readJson(path.join(rootDir, 'docs/catalog.json'));
  const duplicate = { ...catalog, items: [...catalog.items, catalog.items[0]] };
  const duplicateReport = await validateDocumentation({ catalog: duplicate, rootDir });
  assert.match(duplicateReport.errors.join('\n'), /duplicate documentation path/iu);

  const missingEntry = { ...catalog, items: catalog.items.slice(1) };
  const missingEntryReport = await validateDocumentation({ catalog: missingEntry, rootDir });
  assert.match(missingEntryReport.errors.join('\n'), /missing from catalog/iu);

  const invalidStatus = {
    ...catalog,
    items: catalog.items.map((item, index) => index === 0 ? { ...item, status: 'stale' } : item),
  };
  const invalidStatusReport = await validateDocumentation({ catalog: invalidStatus, rootDir });
  assert.match(invalidStatusReport.errors.join('\n'), /status must be one of/iu);

  const superseded = catalog.items.find((item) => item.status === 'superseded');
  assert.ok(superseded, 'fixture requires one superseded document');
  const missingReplacement = {
    ...catalog,
    items: catalog.items.map((item) => item.path === superseded.path
      ? { ...item, supersededBy: 'docs/missing.md' }
      : item),
  };
  const replacementReport = await validateDocumentation({ catalog: missingReplacement, rootDir });
  assert.match(replacementReport.errors.join('\n'), /supersededBy/iu);

  const misplaced = {
    ...catalog,
    items: catalog.items.map((item) => item.path === superseded.path
      ? { ...item, path: 'docs/not-archived.md' }
      : item),
  };
  const misplacedReport = await validateDocumentation({ catalog: misplaced, rootDir });
  assert.match(misplacedReport.errors.join('\n'), /must be under docs\/archive/iu);

  const archiveMarkedCurrent = {
    ...catalog,
    items: catalog.items.map((item) => item.path === superseded.path
      ? Object.fromEntries(Object.entries({ ...item, status: 'current' }).filter(([key]) => key !== 'supersededBy'))
      : item),
  };
  const archiveStatusReport = await validateDocumentation({ catalog: archiveMarkedCurrent, rootDir });
  assert.match(archiveStatusReport.errors.join('\n'), /archived document must use completed or superseded status/iu);

  const malformedReport = await validateDocumentation({
    catalog: { schemaVersion: 1, items: 'invalid' },
    rootDir,
  });
  assert.match(malformedReport.errors.join('\n'), /docs catalog\.items must be array/iu);
});

test('documentation policy detects broken links, mixed lifecycle flags, relative time, and stale open items', async () => {
  const { validateCurrentDocumentContent } = await loadValidator();
  const errors = await validateCurrentDocumentContent({
    content: [
      '[broken](missing.md)',
      'pnpm loopengine install `',
      '  --project ../app `',
      '  --apply',
      '最近需要复核。',
      '待办：',
      '- 截止 2026-01-01，仍需处理。',
      '- [ ] 复核 2026-01-02 的结论。',
      '当前仍使用九阶段治理。',
    ].join('\n'),
    file: 'docs/example.md',
    rootDir,
    today: new Date('2026-07-15T00:00:00.000Z'),
  });
  assert.match(errors.join('\n'), /broken relative link/iu);
  assert.match(errors.join('\n'), /mixes --project with legacy --apply/iu);
  assert.match(errors.join('\n'), /relative time/iu);
  assert.match(errors.join('\n'), /stale open item/iu);
  assert.match(errors.join('\n'), /nine-stage governance/iu);
});

test('documentation coverage includes every root Markdown knowledge file', async () => {
  const { collectGovernedPaths } = await loadValidator();
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'loopengine-docs-coverage-'));
  try {
    await writeFile(path.join(fixture, 'README.md'), '# README\n', 'utf8');
    await writeFile(path.join(fixture, 'ROOT-NOTES.md'), '# Notes\n', 'utf8');
    assert.deepEqual(await collectGovernedPaths(fixture), ['README.md', 'ROOT-NOTES.md']);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test('documentation policy validates inline images and reference-style links', async () => {
  const { validateCurrentDocumentContent } = await loadValidator();
  const errors = await validateCurrentDocumentContent({
    content: [
      '![missing image](missing.png)',
      '[missing reference][guide]',
      '[guide]: missing-guide.md',
      '[undefined reference][not-declared]',
    ].join('\n'),
    file: 'docs/example.md',
    rootDir,
  });
  assert.match(errors.join('\n'), /missing\.png/iu);
  assert.match(errors.join('\n'), /missing-guide\.md/iu);
  assert.match(errors.join('\n'), /undefined reference: not-declared/iu);
});

test('completed task-list siblings do not inherit an open item stale date', async () => {
  const { validateCurrentDocumentContent } = await loadValidator();
  const errors = await validateCurrentDocumentContent({
    content: [
      '- [ ] Review by 2027-01-01',
      '- [x] Migrated on 2025-01-01',
    ].join('\n'),
    file: 'docs/example.md',
    rootDir,
    today: new Date('2026-07-15T00:00:00.000Z'),
  });
  assert.deepEqual(errors, []);
});

test('English and Chinese README command and JSON examples remain equivalent', async () => {
  const { validateReadmeParity } = await loadValidator();
  const [english, chinese] = await Promise.all([
    readFile(path.join(rootDir, 'README.md'), 'utf8'),
    readFile(path.join(rootDir, 'README.zh-CN.md'), 'utf8'),
  ]);
  assert.deepEqual(validateReadmeParity(english, chinese), []);
  assert.match(
    validateReadmeParity(english, chinese.replace('--profile core --write', '--profile full --write')).join('\n'),
    /command examples differ/iu,
  );
  assert.deepEqual(validateReadmeParity(
    '```json\n{"outer":{"b":2,"a":1}}\n```',
    '```json\n{"outer":{"a":1,"b":2}}\n```',
  ), []);
  assert.match(validateReadmeParity(
    'pnpm loopengine install \\\n  --project app \\\n  --write',
    'pnpm loopengine install \\\n  --project app \\\n  --dry-run',
  ).join('\n'), /command examples differ/iu);
});
