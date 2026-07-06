import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  loadAllManifests,
  validateCatalogManifest,
  validateInstallMapShape,
  validateManifestSources,
} from '../scripts/lib/manifest.js';

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
});
