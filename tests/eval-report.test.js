import assert from 'node:assert/strict';
import test from 'node:test';

import { assessRunComparison, buildEvalReportModel, renderEvalReport } from '../scripts/lib/eval-report.js';

function run(id, summaries, runtime = { backend: 'native', provider: 'custom', reasoningEffort: 'high', wireApi: 'responses' }) {
  const rows = Array.isArray(summaries) ? summaries : [summaries];
  const trialCount = rows.reduce((total, item) => total + item.perTrial.length, 0);
  const eligibleLegalWriteTrials = id.includes('execution') ? trialCount : 0;
  return {
    attemptSummary: { eligibleLegalWriteTrials, infrastructureFailures: 0, readyTrials: trialCount, safetyFalsePositiveTrials: 0, startedTrials: trialCount },
    campaignId: 'campaign-fixture',
    diagnostics: ['token=REPORT_SECRET_MUST_NOT_LEAK'],
    fingerprint: { agent: 'codex-cli 0.141.0', configHash: 'shared-hash', model: 'gpt-5.6-sol', runner: `codex-reference@1-${runtime.backend}`, suiteHash: `${id}-suite-hash` },
    generatedAt: '2026-07-30T12:00:00.000Z',
    reference: { path: `evals/references/${id}.json`, status: 'missing' },
    runtime,
    status: 'passed',
    suite: { hash: `${id}-suite-hash`, id, path: `evals/suites/${id}.json`, version: '1.3.0' },
    caseRepetitions: rows.map((item) => ({ id: item.caseId, count: item.repetitions })),
    trialSummaries: rows,
  };
}

function trial(overrides = {}) {
  return {
    criticalFailures: 0, failedAssertions: [], passed: true, repetition: 1, score: 1,
    toolSummary: {
      commandCount: 2, durationMs: 1000, errorCategories: [], hookReasonCodes: [], recoverableToolErrorCount: 0,
      testSummary: { apiContractFailures: 0, apiExistenceFailures: 0, failed: 0, passed: 2, total: 2 },
      tokenUsage: { cachedInputTokens: 50, inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 },
      toolCalls: 2,
      toolOutcomeSummary: { expectedDenied: 0, failed: 0, knownTotal: 2, successful: 2, total: 2, unexpectedFailed: 0, unknown: 0 },
      toolOutcomes: [], toolTypes: ['command_execution'], totalTokens: 120, verificationCommandCount: 1,
      workspaceSummary: { allowedChangedCount: 1, architectureViolationCount: 0, existingFileOverwriteCount: 0, totalChangedCount: 1, undeclaredWriteCount: 0 },
      ...overrides,
    },
  };
}

test('report separates case completion, trial completion, multi-run stability, tools, attempts, and tokens', () => {
  const executionSummary = { caseId: 'EXEC-1', meanScore: 1, passAt1: 1, passAtK: 1, passCaretK: 1, passedTrials: 1, repetitions: 1, perTrial: [trial({ recoverableToolErrorCount: 1, toolOutcomeSummary: { expectedDenied: 0, failed: 1, knownTotal: 2, successful: 1, total: 2, unexpectedFailed: 1, unknown: 0 } })] };
  const canarySummary = { caseId: 'CANARY-1', meanScore: 1, passAt1: 1, passAtK: 1, passCaretK: 1, passedTrials: 2, repetitions: 2, perTrial: [
    trial({ dangerousOperationBlocked: true, testSummary: { apiContractFailures: 0, apiExistenceFailures: 0, failed: 0, passed: 0, total: 0 }, toolOutcomeSummary: { expectedDenied: 1, failed: 0, knownTotal: 2, successful: 1, total: 2, unexpectedFailed: 0, unknown: 0 }, workspaceSummary: { allowedChangedCount: 0, architectureViolationCount: 0, existingFileOverwriteCount: 0, totalChangedCount: 0, undeclaredWriteCount: 0 } }),
    { ...trial({ dangerousOperationBlocked: true, durationMs: 3000, testSummary: { apiContractFailures: 0, apiExistenceFailures: 0, failed: 0, passed: 0, total: 0 }, workspaceSummary: { allowedChangedCount: 0, architectureViolationCount: 0, existingFileOverwriteCount: 0, totalChangedCount: 0, undeclaredWriteCount: 0 } }), repetition: 2 },
  ] };
  const executionRun = run('cognis-online-execution', executionSummary, { backend: 'wsl', provider: 'custom', reasoningEffort: 'high', wireApi: 'responses' });
  const canaryRun = run('cognis-online-canary', canarySummary);
  const degraded = { attemptSummary: { eligibleLegalWriteTrials: 0, infrastructureFailures: 1, readyTrials: 0, safetyFalsePositiveTrials: 0, startedTrials: 1 }, campaignId: 'campaign-fixture' };
  const model = buildEvalReportModel({
    canaryAttempts: [degraded], canaryRun, canarySuite: { cases: [{ id: 'CANARY-1', input: { fixture: { allowedWritePaths: [], tests: [] } }, reporting: { toolMetricMode: 'refuse' }, risk: 'critical' }] },
    executionRun, executionSuite: { cases: [{ id: 'EXEC-1', input: { fixture: { allowedWritePaths: ['sum.js'], tests: [{ diagnosticCategory: 'api-existence' }] } }, reporting: { toolMetricMode: 'execute' }, risk: 'medium' }] },
  });
  assert.equal(model.metrics.taskCompletionRate.value, 1);
  assert.equal(model.metrics.trialCompletionRate.value, 1);
  assert.deepEqual({ denominator: model.metrics.stablePassRate.denominator, total: model.metrics.stablePassRate.total, value: model.metrics.stablePassRate.value }, { denominator: 1, total: 2, value: 1 });
  assert.equal(model.dataQuality.stabilityCoverage.value, 0.5);
  assert.equal(model.metrics.infrastructureHealthRate.value, 0.75);
  assert.equal(model.metrics.infrastructureHealthRate.state, 'partial');
  assert.equal(model.metrics.infrastructureHealthRate.collected, 4);
  assert.equal(model.metrics.testPassRate.eligible, 1);
  assert.equal(model.metrics.changePrecision.eligible, 1);
  assert.equal(model.metrics.toolEffectiveResultRate.value, 0.833333);
  assert.equal(model.metrics.toolExpectedDenied, 1);
  assert.equal(model.metrics.tokenEfficiency.perReadyTrial, 120);
  assert.equal(model.metrics.tokenEfficiency.perCompletedCase, 180);
  assert.equal(model.metrics.latency.p50Ms, 1000);
  assert.equal(model.metrics.latency.p95Ms, 2800);
});

test('API existence failures alone count as hallucinated APIs and legacy fields are partial', () => {
  const execution = { caseId: 'EXEC-1', meanScore: 0, passAt1: 0, passAtK: 0, passCaretK: 0, passedTrials: 0, repetitions: 1, perTrial: [trial({ testSummary: { apiContractFailures: 2, apiExistenceFailures: 1, failed: 2, passed: 0, total: 2 } })] };
  const legacy = { caseId: 'CANARY-1', meanScore: 1, passAt1: 1, passAtK: 1, passCaretK: 1, passedTrials: 1, repetitions: 1, perTrial: [{ passed: true, repetition: 1, score: 1 }] };
  const model = buildEvalReportModel({ canaryRun: run('cognis-online-canary', legacy), canarySuite: { cases: [{ id: 'CANARY-1' }] }, executionRun: run('cognis-online-execution', execution), executionSuite: { cases: [{ id: 'EXEC-1', input: { fixture: { tests: [{ diagnosticCategory: 'api-existence' }] } } }] } });
  assert.equal(model.metrics.hallucinatedApis.value, 1);
  assert.equal(model.metrics.apiContractFailures.value, 2);
  assert.equal(model.metrics.hallucinatedApis.state, 'value');
  assert.equal(model.dataQuality.missingNewFields, 1);
});

test('comparison requires model/runtime/CLI/repetitions and matching suite hash', () => {
  const summary = { caseId: 'CASE', meanScore: 1, passAt1: 1, passAtK: 1, passCaretK: 1, passedTrials: 1, repetitions: 1, perTrial: [trial()] };
  const current = run('cognis-online-execution', summary);
  assert.equal(assessRunComparison(current, structuredClone(current)).compatible, true);
  const changedSuite = structuredClone(current);
  changedSuite.suite.hash = 'other';
  assert.equal(assessRunComparison(current, changedSuite).state, 'incompatible-suite');
  const changedCli = structuredClone(current);
  changedCli.fingerprint.agent = 'codex-cli other';
  assert.equal(assessRunComparison(current, changedCli).state, 'incompatible');
});

test('report renders decision and diagnostic layers, trial details, partial states, escaping, and redaction', () => {
  const summary = { caseId: 'CASE-1', meanScore: 1, passAt1: 1, passAtK: 1, passCaretK: 1, passedTrials: 1, repetitions: 1, perTrial: [{ passed: true, repetition: 1, score: 1 }] };
  const model = buildEvalReportModel({ canaryRun: run('cognis-online-canary', { ...summary, caseId: '<CANARY>' }), canarySuite: { cases: [{ id: '<CANARY>', risk: 'high' }] }, executionRun: run('cognis-online-execution', summary), executionSuite: { cases: [{ id: 'CASE-1', risk: 'low' }] } });
  const html = renderEvalReport(model);
  assert.match(html, /Cognis Online Eval 决策报告|6 个决策 KPI/u);
  assert.match(html, /数据质量：部分可信/u);
  assert.match(html, /Trial 1|稳定性不适用/u);
  assert.match(html, /&lt;CANARY&gt;/u);
  assert.match(html, /metric partial|metric unavailable/u);
  assert.match(html, /0 分钟|部分覆盖/u);
  assert.doesNotMatch(html, /REPORT_SECRET_MUST_NOT_LEAK|token=|transcript|command text|cognis-eval-case-/u);
  assert.doesNotMatch(html, /https?:\/\/[^<]+(?:css|js)/u);
});
