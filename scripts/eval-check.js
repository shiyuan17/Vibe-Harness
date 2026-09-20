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
import { createEvalAssetFingerprint } from './lib/eval-assets.js';
import { suiteHash } from './lib/eval-replay.js';
import { compareAssetFingerprints } from './lib/eval-scoring.js';
import { validateClarificationCatalog } from './lib/clarification-metrics.js';
import { evaluateGoalDefinition, validateGoalDefinitionCatalog } from './lib/goal-definition-metrics.js';
import { loadAllManifests, readJson, validateJsonAgainstSchema } from './lib/manifest.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = await loadEvalAssets(rootDir);
const errors = validateEvalAssets(assets);
// One fingerprint per run: both drift checks (approved reference, behavioral
// artifact) compare against the same checkout state, and recomputing it walks
// every rules/skills/hooks/config asset.
const currentAssetFingerprint = await createEvalAssetFingerprint(rootDir);
// The approved reference must still describe this checkout. Cross-checking run
// against reference cannot see a rule, Skill, Hook or config change, because
// both signed-in artifacts stay internally consistent while already stale.
errors.push(...await validateApprovedReferenceAssets(rootDir, currentAssetFingerprint));
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
// The behavioral run is repo-side stub-behavioral evidence: validate it against
// the run schema, couple it to the checked-in suite (id, version, suite hash,
// case ids) and to this checkout (asset fingerprint, hash-only). Re-executing
// the runtime is eval:behavioral's job; this check only catches a stale pair.
const behavioralSuite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-behavioral.json'));
const behavioralRun = await readJson(path.join(rootDir, 'evals/results/vibe-harness-behavioral.stub.json'));
errors.push(...validateJsonAgainstSchema(behavioralRun, assets.schemas.run, 'evals/results/vibe-harness-behavioral.stub.json'));
if (behavioralRun.proof !== 'stub-behavioral' || behavioralRun.mode !== 'offline') {
  errors.push('behavioral run must declare proof "stub-behavioral" and mode "offline"');
}
if (behavioralRun.suite?.id !== behavioralSuite.id || behavioralRun.suite?.version !== behavioralSuite.version) {
  errors.push('behavioral run suite id/version must match evals/suites/vibe-harness-behavioral.json');
}
if (behavioralRun.suite?.hash !== suiteHash(behavioralSuite)) {
  errors.push('behavioral run suite hash does not match the checked-in behavioral suite');
}
if (!behavioralRun.fingerprint?.assets) {
  errors.push('behavioral run must embed the asset fingerprint');
} else {
  errors.push(...compareAssetFingerprints(currentAssetFingerprint, behavioralRun.fingerprint.assets)
    .mismatches
    .map((mismatch) => ASSET_DRIFT_PREFIX + mismatch.field + ' (behavioral run)'));
}
const behavioralSuiteCaseIds = (behavioralSuite.cases ?? []).map((item) => item.id);
const behavioralRunCaseIds = (behavioralRun.cases ?? []).map((item) => item.id);
if (JSON.stringify(behavioralSuiteCaseIds) !== JSON.stringify(behavioralRunCaseIds)) {
  errors.push('behavioral run case ids must match the behavioral suite case ids one-to-one in order');
}
for (const definition of behavioralSuite.cases ?? []) {
  if ((definition.oracle?.llmRubrics ?? []).length > 0) {
    errors.push(`behavioral case ${definition.id} must not use llmRubrics (offline determinism)`);
  }
}
if ((behavioralRun.status === 'passed') !== behavioralRunCaseIds.every((_, index) => behavioralRun.cases[index]?.passed)) {
  errors.push('behavioral run status must be "passed" exactly when every case passed');
}
const observers = await readJson(path.join(rootDir, 'runtime/evals/observers.json'));
errors.push(...validateEvalObserverCoverage(onlineSuites, observers));

if (errors.length > 0) {
  const drifted = errors.some((error) => error.startsWith(ASSET_DRIFT_PREFIX));
  const behavioralDrifted = errors.some((error) => error.startsWith(ASSET_DRIFT_PREFIX) && error.endsWith(' (behavioral run)'));
  console.error(JSON.stringify({
    errors,
    nextAction: behavioralDrifted
      ? 'Confirm the drifted groups match this change, then regenerate the behavioral artifact with pnpm eval:behavioral --write.'
      : drifted
        ? 'Confirm the drifted groups match this change, then regenerate the pair: pnpm vibe-harness eval run --project . --mode offline --write, pnpm vibe-harness eval reference --project . --from <run> --write --confirm-reference-update --force, pnpm eval:sync --write, pnpm eval:replay --write.'
        : null,
    ok: false,
  }, null, 2));
  process.exit(1);
}

console.log('Vibe-Harness evaluation contracts passed.');
