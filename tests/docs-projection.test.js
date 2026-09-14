import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  ADR_CATALOG_PATH,
  CATALOG_PATH,
  DECISIONS_PATH,
  PRIMARY_INDEX,
  applyDocSync,
  classifyGovernedPath,
  collectDocSyncPlan,
  runDocSync,
} from '../scripts/lib/docs-projection.js';
import { ADR_PATH, adrSyncOptions, createDocsFixture, removeDocsFixture } from './helpers/docs-fixture.js';

test('classification covers rule and schema trees but leaves ADRs to a catalog override', () => {
  assert.equal(classifyGovernedPath('docs/rules/example-rule.md').kind, 'agent-rules');
  assert.equal(classifyGovernedPath('docs/schemas/adr.schema.json').status, 'current');
  assert.equal(classifyGovernedPath(ADR_PATH), null);
  assert.equal(classifyGovernedPath('docs/unknown/topic.md'), null);
});

test('docs:sync projects the catalog, ADR index, decisions index and README links', async () => {
  const root = await createDocsFixture();
  try {
    await writeFile(path.join(root, 'docs/rules/new-rule.md'), '# New rule\n', 'utf8');

    // Without an ADR override the ADR is not classifiable, so the run fails
    // closed and reports the missing owner decision instead of guessing.
    const unclassified = await collectDocSyncPlan({ rootDir: root });
    assert.equal(unclassified.ok, false);
    assert.deepEqual(
      unclassified.manualActions.filter((item) => item.code === 'GOVERNED_PATH_UNCLASSIFIED').map((item) => item.path),
      [ADR_PATH],
    );

    const plan = await collectDocSyncPlan({ rootDir: root, ...adrSyncOptions() });
    assert.deepEqual(plan.fixable.catalog.find((item) => item.path === 'docs/rules/new-rule.md'), {
      audiences: ['agent', 'contributor', 'maintainer'],
      kind: 'agent-rules',
      language: 'zh-CN',
      path: 'docs/rules/new-rule.md',
      status: 'current',
    });
    assert.deepEqual(plan.manualActions, []);

    const written = await applyDocSync({ plan, rootDir: root });
    assert.ok(written.includes(CATALOG_PATH));
    assert.ok(written.includes(ADR_CATALOG_PATH));
    assert.ok(written.includes(DECISIONS_PATH));
    assert.ok(written.includes(PRIMARY_INDEX));

    const catalog = await readFile(path.join(root, CATALOG_PATH), 'utf8');
    assert.match(catalog, /"path": "docs\/rules\/new-rule\.md"/u);
    assert.match(catalog, /"audiences": \[\n {8}"agent"/u, 'catalog keeps the indented object style');
    assert.equal((await readFile(path.join(root, ADR_CATALOG_PATH), 'utf8')).includes(ADR_PATH), true);
    assert.match(await readFile(path.join(root, DECISIONS_PATH), 'utf8'), /- \*\*ADR-0001\*\* First decision - accepted - First decision/u);

    // Generated links land next to their siblings instead of at the file end.
    const index = await readFile(path.join(root, PRIMARY_INDEX), 'utf8');
    assert.match(index, /- \[Example rule\]\(rules\/example-rule\.md\)\n- \[New rule\]\(rules\/new-rule\.md\)\n/u);
    assert.match(index, /- \[ADR catalog\]\(adr\/catalog\.json\)\n- \[First decision\]\(adr\/ADR-0001-first-decision\.md\)\n/u);

    // A second run is a no-op: the projections are now complete.
    const second = await runDocSync({ rootDir: root, write: true, ...adrSyncOptions() });
    assert.deepEqual(second.written, []);
    assert.equal(second.plan.fixableCount, 0);
    assert.deepEqual(second.plan.manualActions, []);
    assert.equal(second.plan.ok, true);
  } finally {
    await removeDocsFixture(root);
  }
});

test('docs:sync copies a drifted schema render instead of editing the catalog', async () => {
  const root = await createDocsFixture();
  try {
    await writeFile(path.join(root, 'docs/schemas/adr.schema.json'), '{}\n', 'utf8');
    const plan = await collectDocSyncPlan({ rootDir: root, ...adrSyncOptions() });
    assert.deepEqual(plan.fixable.schemas, [{ path: 'docs/schemas/adr.schema.json', reason: 'content-drift' }]);

    await runDocSync({ rootDir: root, write: true, ...adrSyncOptions() });
    assert.equal(
      await readFile(path.join(root, 'docs/schemas/adr.schema.json'), 'utf8'),
      await readFile(path.join(root, 'schemas/adr.schema.json'), 'utf8'),
    );
  } finally {
    await removeDocsFixture(root);
  }
});

test('docs:sync reports dangling and unmanaged catalog paths without touching them', async () => {
  const root = await createDocsFixture();
  try {
    await runDocSync({ rootDir: root, write: true, ...adrSyncOptions() });
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'scripts/not-documentation.js'), '// not documentation\n', 'utf8');
    const catalogPath = path.join(root, CATALOG_PATH);
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    catalog.items.push({ audiences: ['maintainer'], kind: 'operations', language: 'zh-CN', path: 'docs/gone.md', status: 'current' });
    catalog.items.push({ audiences: ['maintainer'], kind: 'spec', language: 'en', path: 'scripts/not-documentation.js', status: 'current' });
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

    const plan = await collectDocSyncPlan({ rootDir: root, ...adrSyncOptions() });
    const codes = plan.manualActions.map((item) => item.code);
    assert.ok(codes.includes('CATALOG_DANGLING_PATH'));
    assert.ok(codes.includes('CATALOG_UNMANAGED_PATH'));
    assert.equal(plan.ok, false);

    await applyDocSync({ plan, rootDir: root });
    const after = await readFile(catalogPath, 'utf8');
    assert.match(after, /"path": "docs\/gone\.md"/u);
    assert.match(after, /"path": "scripts\/not-documentation\.js"/u);
    // A path that is not on disk never becomes an index entry.
    assert.doesNotMatch(await readFile(path.join(root, PRIMARY_INDEX), 'utf8'), /gone\.md/u);
  } finally {
    await removeDocsFixture(root);
  }
});
