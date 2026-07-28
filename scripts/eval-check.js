#!/usr/bin/env node
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadEvalAssets, validateEvalAssets, validateEvalObserverCoverage, validateEvalSuiteSemantics } from './lib/eval-contract.js';
import { validateClarificationCatalog } from './lib/clarification-metrics.js';
import { evaluateGoalDefinition, validateGoalDefinitionCatalog } from './lib/goal-definition-metrics.js';
import { readJson, validateJsonAgainstSchema } from './lib/manifest.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = await loadEvalAssets(rootDir);
const errors = validateEvalAssets(assets);
const [clarificationCatalog, goalCatalog, goalRun] = await Promise.all([
  readJson(path.join(rootDir, 'evals/clarification-cases.json')),
  readJson(path.join(rootDir, 'evals/goal-definition-cases.json')),
  readJson(path.join(rootDir, 'evals/goal-definition-trials.json')),
]);
errors.push(...validateClarificationCatalog(clarificationCatalog));
errors.push(...validateGoalDefinitionCatalog(goalCatalog));
if (goalRun?.schemaVersion !== 1 || goalRun?.repetitions !== goalCatalog.repetitions || !Array.isArray(goalRun?.trials)) {
  errors.push('goal trial run must use schemaVersion 1, match catalog repetitions, and contain trials');
} else {
  errors.push(...evaluateGoalDefinition({ catalog: goalCatalog, trials: goalRun.trials }).errors);
}
const suiteFiles = (await readdir(path.join(rootDir, 'evals/suites'))).filter((name) => name.endsWith('.json'));
const onlineSuites = [];
for (const file of suiteFiles) {
  const suite = await readJson(path.join(rootDir, 'evals/suites', file));
  if (file.includes('online')) onlineSuites.push(suite);
  errors.push(...validateJsonAgainstSchema(suite, assets.schemas.suite, file));
  errors.push(...validateEvalSuiteSemantics(suite));
}
const observers = await readJson(path.join(rootDir, 'runtime/evals/observers.json'));
errors.push(...validateEvalObserverCoverage(onlineSuites, observers));

if (errors.length > 0) {
  console.error(JSON.stringify({ errors, ok: false }, null, 2));
  process.exit(1);
}

console.log('Cognis evaluation contracts passed.');
