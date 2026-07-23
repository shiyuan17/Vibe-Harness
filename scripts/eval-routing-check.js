#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateRoutingCatalog } from './lib/skill-routing-metrics.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [catalog, skills] = await Promise.all([
  readFile(path.join(rootDir, 'evals/skill-routing-cases.json'), 'utf8').then(JSON.parse),
  readFile(path.join(rootDir, 'manifests/skills.json'), 'utf8').then(JSON.parse),
]);
const skillIds = skills.items.filter((item) => item.kind === 'native').map((item) => item.id);
const errors = validateRoutingCatalog({ catalog, skillIds });
if (errors.length > 0) {
  console.error(JSON.stringify({ errors, ok: false }, null, 2));
  process.exitCode = 1;
} else {
  console.log(`Cognis routing evaluation catalog passed (${skillIds.length} native skills).`);
}
