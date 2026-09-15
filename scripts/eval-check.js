#!/usr/bin/env node
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  ASSET_DRIFT_PREFIX,
  loadEvalAssets,
  validateApprovedReferenceAssets,
  validateEvalAssets,
  validateEvalObserverCoverage,
  validateEvalSuiteSemantics,
} from './lib/eval-contract.js';
import { validateClarificationCatalog } from './lib/clarification-metrics.js';
import { evaluateGoalDefinition, validateGoalDefinitionCatalog } from './lib/goal-definition-metrics.js';
import { loadAllManifests, readJson, validateJsonAgainstSchema } from './lib/manifest.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = await loadEvalAssets(rootDir);
const errors = validateEvalAssets(assets);
// The approved reference must still describe this checkout. Cross-checking run
// against reference cannot see a rule, Skill, Hook or config change, because
// both signed-in artifacts stay internally consistent while already stale.
errors.push(...await validateApprovedReferenceAssets(rootDir));
const manifests = await loadAllManifests(rootDir);
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
  errors.push(...validateEvalSuiteSemantics(suite, manifests));
}
const observers = await readJson(path.join(rootDir, 'runtime/evals/observers.json'));
errors.push(...validateEvalObserverCoverage(onlineSuites, observers));

if (errors.length > 0) {
  const drifted = errors.some((error) => error.startsWith(ASSET_DRIFT_PREFIX));
  console.error(JSON.stringify({
    errors,
    nextAction: drifted
      ? 'Confirm the drifted groups match this change, then regenerate the pair: pnpm vibe-harness eval run --project . --mode offline --write, pnpm vibe-harness eval reference --project . --from <run> --write --confirm-reference-update --force, pnpm eval:sync --write, pnpm eval:replay --write.'
      : null,
    ok: false,
  }, null, 2));
  process.exit(1);
}

console.log('Vibe-Harness evaluation contracts passed.');
