import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { scanForForbiddenTerms } from '../scripts/lib/redaction.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('core reusable pack does not leak source project identifiers or business terms', async () => {
  const findings = await scanForForbiddenTerms({
    forbiddenTerms: [
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
      '医疗'
    ],
    includeDirs: [
      'rules',
      'templates',
      'skills/core',
      'skills/integrations',
      'memory',
      'adapters/codex',
      'manifests',
      'schemas',
      'examples',
      'cognis.config.json'
    ],
    rootDir,
  });

  assert.deepEqual(findings, []);
});
