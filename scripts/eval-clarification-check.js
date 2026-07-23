#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateClarificationCatalog } from './lib/clarification-metrics.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.join(rootDir, 'evals/clarification-cases.json'), 'utf8'));
const errors = validateClarificationCatalog(catalog);
if (errors.length > 0) {
  console.error(JSON.stringify({ errors, ok: false }, null, 2));
  process.exitCode = 1;
} else {
  console.log(`Cognis clarification evaluation catalog passed (${catalog.cases.length} cases).`);
}
