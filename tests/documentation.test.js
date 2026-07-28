import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { validateDocumentation, validateReadmeParity } from '../scripts/lib/docs-validation.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('documentation catalog covers current and archived Markdown', async () => {
  const report = await validateDocumentation({ rootDir });
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

test('English and Chinese README expose the same commands and configuration', async () => {
  const [english, chinese] = await Promise.all([
    readFile(path.join(rootDir, 'README.md'), 'utf8'),
    readFile(path.join(rootDir, 'README.zh-CN.md'), 'utf8'),
  ]);
  assert.deepEqual(validateReadmeParity(english, chinese), []);
});
