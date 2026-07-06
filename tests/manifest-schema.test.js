import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadAllManifests, validateManifestSources } from '../scripts/lib/manifest.js';

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
