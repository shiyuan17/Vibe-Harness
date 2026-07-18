import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { readJson, validateJsonAgainstSchema } from '../scripts/lib/manifest.js';
import {
  loadEvalAssets,
  validateEvalAssets,
  validateEvalObserverCoverage,
  validateEvalSuiteSemantics,
} from '../scripts/lib/eval-contract.js';
import { buildOfflineRun } from '../scripts/lib/eval-replay.js';

const rootDir = path.resolve('.');
const execFileAsync = promisify(execFile);

test('eval schemas use draft 2020-12 and schemaVersion 1 contracts', async () => {
  for (const name of ['eval-suite', 'eval-run', 'eval-reference']) {
    const schema = await readJson(path.join(rootDir, `schemas/${name}.schema.json`));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.deepEqual(schema.properties.schemaVersion.enum, [1]);
  }
});

test('core suite contains exactly 23 generic cases in the required category split', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/cognis-core.json'));
  assert.equal(suite.cases.length, 23);
  const counts = suite.cases.reduce((result, item) => ({
    ...result,
    [item.category]: (result[item.category] ?? 0) + 1,
  }), {});
  assert.deepEqual(counts, {
    'install-lifecycle': 6,
    'task-delivery-governance': 7,
    'skill-routing': 6,
    'safety-isolation': 4,
  });
  assert.equal(new Set(suite.cases.map((item) => item.id)).size, 23);
  for (const item of suite.cases) {
    assert.deepEqual(Object.keys(item.weights).sort(), ['correctness', 'efficiency', 'evidenceQuality', 'safety']);
    assert.equal(Number.isInteger(item.repetitions) && item.repetitions >= 1, true);
  }
});

test('suite semantic validation rejects duplicate ids, all-zero weights, and weighted dimensions without assertions', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/cognis-core.json'));
  assert.deepEqual(validateEvalSuiteSemantics(suite), []);
  const invalid = structuredClone(suite);
  invalid.cases[1].id = invalid.cases[0].id;
  invalid.cases[2].weights = { correctness: 0, safety: 0, evidenceQuality: 0, efficiency: 0 };
  invalid.cases[3].oracle.requiredEvents = invalid.cases[3].oracle.requiredEvents.filter((item) => item.dimension !== 'efficiency');
  invalid.cases[3].oracle.forbiddenEvents = invalid.cases[3].oracle.forbiddenEvents.filter((item) => item.dimension !== 'efficiency');
  invalid.cases[3].oracle.requiredOutputFragments = invalid.cases[3].oracle.requiredOutputFragments.filter((item) => item.dimension !== 'efficiency');
  invalid.cases[3].oracle.forbiddenOutputFragments = invalid.cases[3].oracle.forbiddenOutputFragments.filter((item) => item.dimension !== 'efficiency');
  invalid.cases[3].oracle.requiredArtifacts = invalid.cases[3].oracle.requiredArtifacts.filter((item) => item.dimension !== 'efficiency');
  invalid.cases[3].oracle.forbiddenArtifacts = invalid.cases[3].oracle.forbiddenArtifacts.filter((item) => item.dimension !== 'efficiency');
  if (invalid.cases[3].oracle.exitCode.dimension === 'efficiency') invalid.cases[3].oracle.exitCode.dimension = 'correctness';
  assert.match(validateEvalSuiteSemantics(invalid).join('\n'), /duplicate case id/u);
  assert.match(validateEvalSuiteSemantics(invalid).join('\n'), /positive weight/u);
  assert.match(validateEvalSuiteSemantics(invalid).join('\n'), /efficiency has weight/u);
});

test('online forbidden events require registered observers', async () => {
  const [suite, observers] = await Promise.all([
    readJson(path.join(rootDir, 'evals/suites/cognis-online-canary.json')),
    readJson(path.join(rootDir, 'runtime/evals/observers.json')),
  ]);
  assert.deepEqual(validateEvalObserverCoverage([suite], observers), []);
  const incomplete = structuredClone(observers);
  delete incomplete.events['global-agent-write'];
  assert.match(validateEvalObserverCoverage([suite], incomplete).join('\n'), /global-agent-write/u);
});

test('checked-in suite, run, and reference satisfy their schemas and cross references', async () => {
  const assets = await loadEvalAssets(rootDir);
  const report = validateEvalAssets(assets);
  assert.deepEqual(report, []);
  for (const [name, value] of Object.entries({ suite: assets.suite, run: assets.run, reference: assets.reference })) {
    assert.deepEqual(validateJsonAgainstSchema(value, assets.schemas[name], name), []);
  }
});

test('eval asset validation rejects scores outside 0..1', async () => {
  const assets = await loadEvalAssets(rootDir);
  const invalid = structuredClone(assets);
  invalid.run.cases[0].score = 1.1;
  invalid.run.overallScore = 2;
  invalid.reference.criticalPassRate = -0.1;
  const errors = validateEvalAssets(invalid).join('\n');
  assert.match(errors, /run\.cases\[0\]\.score/u);
  assert.match(errors, /run\.overallScore/u);
  assert.match(errors, /reference\.criticalPassRate/u);
});

test('eval run schema rejects malformed dimension scores and assertions', async () => {
  const assets = await loadEvalAssets(rootDir);
  const invalid = structuredClone(assets.run);
  invalid.cases[0].dimensionScores = { correctness: 2 };
  invalid.cases[0].assertions = [{ passed: true }];
  const errors = validateJsonAgainstSchema(invalid, assets.schemas.run, 'run').join('\n');
  assert.match(errors, /dimensionScores/u);
  assert.match(errors, /assertions/u);
});

test('offline replay deterministically reproduces the checked-in run and matches reference fingerprint', async () => {
  const assets = await loadEvalAssets(rootDir);
  const replayed = buildOfflineRun(assets.suite);
  assert.deepEqual(replayed, assets.run);
  assert.equal(replayed.status, 'passed');
  assert.equal(replayed.overallScore, 1);
  assert.deepEqual(replayed.fingerprint, assets.reference.fingerprint);
});

test('offline replay evaluates forbidden secret text before sanitizing persisted output', async () => {
  const assets = await loadEvalAssets(rootDir);
  const suite = structuredClone(assets.suite);
  suite.cases = [suite.cases[0]];
  suite.cases[0].input.replay.output = 'preview ready secret=should-not-persist';
  suite.cases[0].oracle.forbiddenOutputFragments = [{
    critical: true,
    dimension: 'safety',
    value: 'secret=',
  }];

  const run = buildOfflineRun(suite);
  assert.equal(run.status, 'failed');
  assert.equal(run.cases[0].criticalFailures, 1);
  assert.doesNotMatch(JSON.stringify(run), /should-not-persist/u);
});

test('package exposes read-only eval check and offline scripts', async () => {
  const packageJson = await readJson(path.join(rootDir, 'package.json'));
  assert.equal(packageJson.scripts['eval:check'], 'node ./scripts/eval-check.js');
  assert.equal(packageJson.scripts['eval:offline'], 'node ./scripts/eval-offline.js');
});

test('eval scripts validate contracts and reproduce the approved offline reference', async () => {
  const check = await execFileAsync(process.execPath, [path.join(rootDir, 'scripts/eval-check.js')], { cwd: rootDir });
  assert.match(check.stdout, /evaluation contracts passed/u);
  const offline = await execFileAsync(process.execPath, [path.join(rootDir, 'scripts/eval-offline.js')], { cwd: rootDir });
  assert.match(offline.stdout, /offline evaluation passed/u);
  const summary = JSON.parse(offline.stdout.slice(offline.stdout.indexOf('{')));
  assert.deepEqual(summary, {
    criticalPassRate: 1,
    overallScore: 1,
    status: 'passed',
    suite: 'cognis-core',
  });
});
