import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { scanForForbiddenTerms } from '../../scripts/lib/redaction.js';

const rootDir = path.resolve(import.meta.dirname, '../..');

// Identifiers from the source project that must never ship inside the
// reusable pack. vibe-harness.config.json declares this repository's own
// forbiddenProjectTerms — the one sanctioned home for those identifiers —
// so the config is scanned for undeclared terms only, while its declared
// set is pinned to keep the exception from widening silently.
const SOURCE_PROJECT_TERMS = [
  'SYBaseProjectWeb',
  'SYBaseProject',
  'D:\\Github\\JW',
  'PaProject',
  'SVN-Project',
  'global request layer',
  'shared components',
  'request clients',
  'T-019',
  'T-024',
  '患者',
  '病理',
  '医疗',
];

const PACK_DIRS = [
  'docs/rules',
  'templates',
  'skills/core',
  'skills/integrations',
  'memory',
  'adapters/codex',
  'manifests',
  'schemas',
  'examples',
];

test('core reusable pack does not leak source project identifiers or business terms', async () => {
  const config = JSON.parse(await readFile(path.join(rootDir, 'vibe-harness.config.json'), 'utf8'));
  const declared = config.forbiddenProjectTerms ?? [];
  assert.deepEqual(
    [...declared].sort(),
    ['SYBaseProject', 'SYBaseProjectWeb', 'localhost:5777', '病理'].sort(),
  );

  const packFindings = await scanForForbiddenTerms({
    forbiddenTerms: SOURCE_PROJECT_TERMS,
    includeDirs: PACK_DIRS,
    rootDir,
  });
  const configFindings = await scanForForbiddenTerms({
    forbiddenTerms: SOURCE_PROJECT_TERMS.filter((term) => !declared.includes(term)),
    includeDirs: ['vibe-harness.config.json'],
    rootDir,
  });

  assert.deepEqual([...packFindings, ...configFindings], []);
});
