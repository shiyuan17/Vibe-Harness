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

const rootDir = path.resolve(import.meta.dirname, '..');
const execFileAsync = promisify(execFile);

test('eval schemas use draft 2020-12 and schemaVersion 1 contracts', async () => {
  for (const name of ['eval-suite', 'eval-run', 'eval-reference']) {
    const schema = await readJson(path.join(rootDir, `schemas/${name}.schema.json`));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.deepEqual(schema.properties.schemaVersion.enum, [1]);
  }
});

test('core suite contains exactly 38 generic cases in the required category split', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json'));
  assert.equal(suite.cases.length, 38);
  const counts = suite.cases.reduce((result, item) => ({
    ...result,
    [item.category]: (result[item.category] ?? 0) + 1,
  }), {});
  assert.deepEqual(counts, {
    'install-lifecycle': 6,
    'task-delivery-governance': 4,
    'skill-routing': 19,
    'safety-isolation': 9,
  });
  const ids = new Set(suite.cases.map((item) => item.id));
  assert.equal(ids.size, 38);
  for (const id of ['EVAL-GOV-EVIDENCE-005', 'EVAL-GOV-DEGRADED-006', 'EVAL-GOV-SENSITIVE-007', 'EVAL-GOV-ANALYSIS-008']) {
    assert.equal(ids.has(id), true);
  }
  for (const item of suite.cases) {
    assert.deepEqual(Object.keys(item.weights).sort(), ['correctness', 'efficiency', 'evidenceQuality', 'safety']);
    assert.equal(Number.isInteger(item.repetitions) && item.repetitions >= 1, true);
  }
});

test('suite schema accepts optional case kind enum and rejects unknown values', async () => {
  const [suiteSchema, coreSuite] = await Promise.all([
    readJson(path.join(rootDir, 'schemas/eval-suite.schema.json')),
    readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json')),
  ]);
  const valid = structuredClone(coreSuite);
  valid.cases[0].kind = 'standard';
  assert.deepEqual(validateJsonAgainstSchema(valid, suiteSchema, 'suite'), []);
  const invalid = structuredClone(coreSuite);
  invalid.cases[0].kind = 'regression';
  assert.match(validateJsonAgainstSchema(invalid, suiteSchema, 'suite').join('\n'), /kind/u);
});

test('all checked-in suite cases carry a valid kind label', async () => {
  const allowed = new Set(['standard', 'variation', 'edge', 'adversarial']);
  for (const file of ['vibe-harness-core.json', 'vibe-harness-online-canary.json', 'vibe-harness-online-execution.json']) {
    const suite = await readJson(path.join(rootDir, `evals/suites/${file}`));
    for (const item of suite.cases) {
      assert.equal(allowed.has(item.kind), true, `${item.id} in ${file} has invalid kind ${item.kind}`);
    }
  }
});

test('online canary lifecycle and secret oracles avoid prompt-echo false positives', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'));
  const lifecycle = suite.cases.find((item) => item.id === 'EVAL-ONLINE-003');
  const secret = suite.cases.find((item) => item.id === 'EVAL-ONLINE-006');
  assert.doesNotMatch(lifecycle.input.scenario, /--apply/u);
  assert.equal(lifecycle.oracle.forbiddenOutputFragments.some((item) => item.value === '--apply'), true);
  const apiKeyMarker = 'OPENAI_API_KEY';
  const secretValue = secret.input.fixture.files.find((file) => file.path === '.env').content
    .match(new RegExp(`${apiKeyMarker}=(.+)`, 'u'))[1];
  assert.ok(secretValue.length >= 24);
  assert.equal(secret.oracle.forbiddenOutputFragments.some((item) => item.value === secretValue), true);
  assert.notEqual(secretValue, 'x');
});

test('eval run schema accepts optional sanitized per-trial diagnostics', async () => {
  const assets = await loadEvalAssets(rootDir);
  const run = structuredClone(assets.run);
  run.campaignId = 'campaign-2026-07-30';
  run.attemptSummary = { eligibleLegalWriteTrials: 1, infrastructureFailures: 0, readyTrials: 1, safetyFalsePositiveTrials: 0, startedTrials: 1 };
  run.trialSummaries = [{
    caseId: run.cases[0].id,
    repetitions: 1,
    passAt1: 0,
    passAtK: 0,
    passCaretK: 0,
    passedTrials: 0,
    meanScore: 0.5,
    perTrial: [{
      repetition: 1,
      passed: false,
      score: 0.5,
      criticalFailures: 1,
      flakyFailure: false,
      failedAssertions: [{ kind: 'required-event', dimension: 'correctness', critical: true }],
      toolSummary: {
        commandCount: 1,
        dangerousOperationBlocked: true,
        durationMs: 123,
        errorCategories: ['hidden-test-failed'],
        finalChangeValidation: {
          failedAfterFinalChangeCount: 0,
          handoffBound: true,
          materialChangeCount: 1,
          repairRerunObserved: false,
          status: 'verified',
          successfulAfterFinalChangeCount: 1,
          verificationAfterFinalChangeCount: 1,
          verificationBeforeFinalChangeCount: 0,
        },
        hookReasonCodes: [],
        recoverableToolErrorCount: 1,
        testSummary: { apiContractFailures: 1, apiExistenceFailures: 1, failed: 1, passed: 1, total: 2 },
        tokenUsage: { cachedInputTokens: 4, inputTokens: 8, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 10 },
        toolCalls: 1,
        toolOutcomeSummary: { expectedDenied: 0, failed: 1, knownTotal: 1, successful: 0, total: 1, unexpectedFailed: 1, unknown: 0 },
        toolOutcomes: [{ type: 'command_execution', status: 'failed', exitCode: 1, classification: 'recoverable-failure' }],
        toolTypes: ['command_execution'],
        totalTokens: 10,
        verificationCommandCount: 1,
        workspaceSummary: { allowedChangedCount: 1, architectureViolationCount: 1, existingFileOverwriteCount: 0, totalChangedCount: 2, undeclaredWriteCount: 1 },
      },
      diagnostics: ['focused validation failed'],
    }],
  }];
  assert.deepEqual(validateJsonAgainstSchema(run, assets.schemas.run, 'run'), []);
});

test('RTK and ast-grep rules have reference-backed fallback and evidence cases', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json'));
  const rtk = suite.cases.find((item) => item.id === 'EVAL-TOOL-RTK-001');
  const rtkIsolation = suite.cases.find((item) => item.id === 'EVAL-TOOL-RTK-006');
  const astGrep = suite.cases.find((item) => item.id === 'EVAL-TOOL-AST-001');
  const astGrepQuery = suite.cases.find((item) => item.id === 'EVAL-TOOL-AST-002');
  const astGrepDebug = suite.cases.find((item) => item.id === 'EVAL-TOOL-AST-003');
  assert.equal(rtk.capability, 'rtk-output-compression');
  assert.equal(rtk.oracle.forbiddenEvents.some((item) => item.value === 'rtk-used-for-sensitive-command'), true);
  assert.equal(rtkIsolation.oracle.forbiddenEvents.some((item) => item.value === 'sensitive-output-persisted'), true);
  assert.equal(astGrep.capability, 'ast-grep-structured-search');
  assert.equal(astGrep.oracle.requiredEvents.some((item) => item.value === 'source-and-tests-verified'), true);
  assert.equal(astGrep.oracle.forbiddenEvents.some((item) => item.value === 'unverified-structural-match-accepted'), true);
  assert.equal(astGrepQuery.oracle.requiredEvents.some((item) => item.value === 'ast-grep-language-selected'), true);
  assert.equal(astGrepDebug.oracle.requiredEvents.some((item) => item.value === 'ast-grep-debug-query-used'), true);
});

test('EVAL-WORKFLOW-DEMAND-001 schemas accept workflow demand and sanitized task episodes', async () => {
  const [suiteSchema, runSchema, coreSuite] = await Promise.all([
    readJson(path.join(rootDir, 'schemas/eval-suite.schema.json')),
    readJson(path.join(rootDir, 'schemas/eval-run.schema.json')),
    readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json')),
  ]);
  const suite = structuredClone(coreSuite);
  suite.cases[0].reporting = {
    ...(suite.cases[0].reporting ?? {}),
    workflowDemand: {
      taskFamily: 'installer-lifecycle',
      expectedOwner: { kind: 'skill', id: 'eval-driven-development' },
    },
  };
  assert.deepEqual(validateJsonAgainstSchema(suite, suiteSchema, 'suite'), []);

  const assets = await loadEvalAssets(rootDir);
  const run = structuredClone(assets.run);
  run.trialSummaries = [{
    caseId: run.cases[0].id,
    repetitions: 1,
    passAt1: 1,
    passAtK: 1,
    passCaretK: 1,
    passedTrials: 1,
    meanScore: 1,
    perTrial: [{
      repetition: 1,
      passed: true,
      score: 1,
      toolSummary: {
        taskEpisode: {
          taskFamily: 'installer-lifecycle',
          owner: { kind: 'skill', id: 'eval-driven-development', evidenceState: 'observed' },
          validationStatus: 'verified',
          stopBoundary: 'verified-handoff',
          outcome: 'passed',
        },
      },
    }],
  }];
  assert.deepEqual(validateJsonAgainstSchema(run, runSchema, 'run'), []);
  assert.doesNotMatch(JSON.stringify(run.trialSummaries), /prompt|sessionId|commandText|toolOutput/iu);
});

test('tool routing eval keeps syntax, semantics, text, and output compression distinct', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-tool-routing.json'));
  assert.deepEqual(validateEvalSuiteSemantics(suite), []);
  const run = await buildOfflineRun(suite);
  assert.equal(run.status, 'passed');
  assert.equal(run.criticalPassRate, 1);
  assert.equal(run.overallScore, 1);
  assert.deepEqual(suite.cases.map((item) => item.id), [
    'EVAL-TOOL-ROUTING-001',
    'EVAL-TOOL-ROUTING-002',
    'EVAL-TOOL-ROUTING-003',
    'EVAL-TOOL-ROUTING-004',
  ]);
  const serialized = JSON.stringify(suite);
  for (const fragment of [
    'codebase-memory-index-checked',
    'ast-grep-outline-used',
    'rg-used',
    'high-output-shell-routed',
    'rtk-wrapped-code-intelligence-tool',
  ]) {
    assert.match(serialized, new RegExp(fragment, 'u'));
  }
});

test('suite semantic validation rejects duplicate ids, all-zero weights, and weighted dimensions without assertions', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json'));
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
    readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json')),
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

test('offline assets reject llmRubrics assertions to keep replay deterministic', async () => {
  const assets = await loadEvalAssets(rootDir);
  const invalid = structuredClone(assets);
  invalid.suite.cases[0].oracle.llmRubrics = [{
    rubric: 'output must be concise',
    dimension: 'correctness',
    critical: true,
  }];
  const errors = validateEvalAssets(invalid).join('\n');
  assert.match(errors, /llmRubrics are not allowed in offline suites/u);
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
  const replayed = await buildOfflineRun(assets.suite);
  assert.deepEqual(replayed, assets.run);
  assert.equal(replayed.status, 'passed');
  assert.equal(replayed.overallScore, 1);
  assert.deepEqual(replayed.fingerprint, assets.reference.fingerprint);
});

test('offline replay never emits multi-trial summaries', async () => {
  const assets = await loadEvalAssets(rootDir);
  const replayed = await buildOfflineRun(assets.suite);
  assert.equal(Object.hasOwn(replayed, 'trialSummaries'), false);
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

  const run = await buildOfflineRun(suite);
  assert.equal(run.status, 'failed');
  assert.equal(run.cases[0].criticalFailures, 1);
  assert.doesNotMatch(JSON.stringify(run), /should-not-persist/u);
});

test('package exposes read-only eval check and replay scripts without the retired alias', async () => {
  const packageJson = await readJson(path.join(rootDir, 'package.json'));
  assert.equal(packageJson.scripts['eval:check'], 'node ./scripts/eval-check.js');
  assert.equal(packageJson.scripts['eval:replay'], 'node ./scripts/eval-replay.js');
  assert.equal(Object.hasOwn(packageJson.scripts, 'eval:offline'), false);
});

test('eval scripts validate contracts and reproduce the approved offline reference', async () => {
  const check = await execFileAsync(process.execPath, [path.join(rootDir, 'scripts/eval-check.js')], { cwd: rootDir });
  assert.match(check.stdout, /evaluation contracts passed/u);
  const replay = await execFileAsync(process.execPath, [path.join(rootDir, 'scripts/eval-replay.js')], { cwd: rootDir });
  assert.match(replay.stdout, /deterministic replay passed/u);
  const summary = JSON.parse(replay.stdout.slice(replay.stdout.indexOf('{')));
  assert.deepEqual(summary, {
    criticalPassRate: 1,
    overallScore: 1,
    status: 'passed',
    suite: 'vibe-harness-core',
  });
});
