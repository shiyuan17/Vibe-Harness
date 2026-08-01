#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateGoalDefinition, validateGoalDefinitionCatalog } from './lib/goal-definition-metrics.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [catalog, run] = await Promise.all([
  readFile(path.join(rootDir, 'evals/goal-definition-cases.json'), 'utf8').then(JSON.parse),
  readFile(path.join(rootDir, 'evals/goal-definition-trials.json'), 'utf8').then(JSON.parse),
]);
const errors = validateGoalDefinitionCatalog(catalog);
if (run?.schemaVersion !== 1 || run?.repetitions !== catalog.repetitions || !Array.isArray(run?.trials)) {
  errors.push('goal trial run must use schemaVersion 1, match catalog repetitions, and contain trials');
} else {
  errors.push(...evaluateGoalDefinition({ catalog, trials: run.trials }).errors);
}
if (errors.length > 0) {
  console.error(JSON.stringify({ errors, ok: false }, null, 2));
  process.exitCode = 1;
} else {
  console.log(`Vibe-Harness goal-definition evaluation passed (${catalog.cases.length} cases, ${run.trials.length} trials).`);
}
