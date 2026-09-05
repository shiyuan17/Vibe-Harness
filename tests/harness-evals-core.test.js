import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  adaptLegacyRun,
  analyzeTrace,
  buildMetrics,
  buildReport,
  buildResultV3,
  compareAgentConditions,
  compareResults,
  createBaseline,
  createDeterministicVerifier,
  createHarnessRunner,
  readTraceBundle,
  redactTraceValue,
  renderHtmlReport,
  renderMarkdownReport,
  selectScenariosForChanges,
  toAtifTrace,
  writeTraceBundle,
} from '../harness-evals/lib/index.js';

const scenario = {
  id: 'H04-verification-skipped',
  title: 'Verification skipped',
  source: 'internal',
  requirements: { capabilities: ['resume'] },
};

test('trace conversion emits ATIF-v1.8 and redacts credentials and absolute paths', async () => {
  const secret = 'PRIVATE_VALUE';
  const absolute = '/Users/private/work/project.js';
  const value = redactTraceValue({
    authorization: `Bearer ${secret}`,
    command: `node ${absolute} --token=${secret}`,
    tokenUsage: { totalTokens: 12 },
  });
  assert.equal(value.authorization, '<redacted>');
  assert.doesNotMatch(value.command, /PRIVATE_VALUE|\/Users\/private/u);
  assert.equal(value.tokenUsage.totalTokens, 12);

  const trace = toAtifTrace({
    runId: 'run-1',
    agent: { name: 'codex', version: '1', modelName: 'gpt-test' },
    events: [
      { type: 'message', source: 'user', message: `inspect ${absolute}`, timestamp: '2026-09-05T00:00:00.000Z' },
      { type: 'tool-call', callId: 'call-1', name: 'shell', arguments: { command: `cat ${absolute}`, apiKey: secret }, timestamp: '2026-09-05T00:00:01.000Z' },
      { type: 'tool-result', callId: 'call-1', content: `read ${absolute}`, timestamp: '2026-09-05T00:00:02.000Z' },
    ],
    metrics: { inputTokens: 10, outputTokens: 4, cachedTokens: 2, toolCalls: 1 },
  });
  assert.equal(trace.schema_version, 'ATIF-v1.8');
  assert.deepEqual(trace.steps.map((step) => step.step_id), [1, 2, 3]);
  assert.equal(trace.steps[1].tool_calls[0].tool_call_id, 'call-1');
  assert.equal(trace.steps[2].observation.results[0].source_call_id, 'call-1');
  assert.equal(trace.final_metrics.total_prompt_tokens, 10);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_VALUE|\/Users\/private/u);

  const directory = await mkdtemp(path.join(tmpdir(), 'harness-evals-trace-'));
  try {
    const refs = await writeTraceBundle(directory, {
      trace,
      events: [{ command: `node ${absolute}`, password: secret }],
      artifacts: [{ path: absolute, sha256: 'abc' }],
    });
    assert.deepEqual(refs, {
      artifacts: 'artifacts.json',
      events: 'events.json',
      trajectory: 'trajectory.json',
    });
    const persisted = await readTraceBundle(directory);
    assert.equal(persisted.trace.schema_version, 'ATIF-v1.8');
    assert.doesNotMatch(await readFile(path.join(directory, 'events.json'), 'utf8'), /PRIVATE_VALUE|\/Users\/private/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('deterministic verifier fails closed and trace analysis attributes the first deviation', async () => {
  const verifier = createDeterministicVerifier([
    {
      id: 'verify-after-change',
      category: 'workflow',
      severity: 'critical',
      check: ({ events }) => events.at(-1)?.type === 'verification'
        ? { passed: true, evidence: { eventIndex: events.length - 1 } }
        : { passed: false, code: 'VERIFICATION_STALE', evidence: { eventIndex: 1 } },
    },
    {
      id: 'fixture-check', category: 'fixture', severity: 'major',
      check: () => { throw new Error('oracle unavailable at /Users/private/oracle'); },
    },
  ]);
  const outcome = await verifier.verify({ events: [{ type: 'change' }, { type: 'completion' }] });
  assert.equal(outcome.status, 'failed');
  assert.deepEqual(outcome.checks.map((check) => check.status), ['failed', 'blocked']);
  assert.doesNotMatch(JSON.stringify(outcome), /\/Users\/private/u);

  const analysis = analyzeTrace({ steps: [] }, outcome.checks);
  assert.equal(analysis.findings[0].taxonomy, 'Verification Failure');
  assert.equal(analysis.findings[0].firstDeviation.eventIndex, 1);
  assert.equal(analysis.findings[1].taxonomy, 'Fixture Failure');
});

test('v3 metrics retain denominators, unavailable telemetry, and critical failures', () => {
  const attempts = [
    {
      id: 'attempt-1', status: 'failed', completionClaim: true, durationMs: 100,
      verification: { passed: false },
      events: [{ type: 'tool-call', name: 'search', query: 'same' }, { type: 'replan' }],
    },
    {
      id: 'attempt-2', status: 'passed', completionClaim: true, durationMs: 80,
      verification: { passed: true },
      events: [{ type: 'tool-call', name: 'search', query: 'same' }, { type: 'recovery', succeeded: true }],
    },
  ];
  const checks = [
    { id: 'critical-workflow', category: 'workflow', severity: 'critical', status: 'failed' },
    { id: 'verification', category: 'verification', severity: 'major', status: 'passed' },
  ];
  const metrics = buildMetrics({ attempts, checks });
  assert.deepEqual(metrics.outcome.taskSuccessRate, {
    value: 0.5, unit: 'ratio', numerator: 1, denominator: 2,
    coverage: { collected: 2, eligible: 2, total: 2 }, state: 'value', missingReason: null,
  });
  assert.equal(metrics.outcome.firstPassSuccessRate.value, 0);
  assert.equal(metrics.outcome.falseCompletionRate.value, 0.5);
  assert.equal(metrics.efficiency.tokenUsage.state, 'unavailable');
  assert.equal(metrics.efficiency.repeatedSearch.value, 1);

  const result = buildResultV3({
    scenario,
    attempts,
    checks,
    traceRefs: [{ attemptId: 'attempt-1', trajectory: 'traces/attempt-1/trajectory.json' }],
    fingerprint: {
      measurement: { scenarioHash: 'scenario', model: 'gpt-test', runner: 'local' },
      harness: { rulesHash: 'rules' },
    },
    generatedAt: '2026-09-05T00:00:00.000Z',
  });
  assert.equal(result.schemaVersion, 3);
  assert.equal(result.status, 'failed');
  assert.equal(result.summary.criticalFailures, 1);
  assert.equal(result.metrics.outcome.taskSuccessRate.denominator, 2);
});

test('runner exposes lifecycle methods and preserves failed attempts for collection', async () => {
  const calls = [];
  let invocation = 0;
  const backend = {
    capabilities: ['resume'],
    async prepare(context) { calls.push('backend.prepare'); return { backendRef: context.executionId }; },
    async run() {
      invocation += 1;
      if (invocation === 1) throw new Error('tool failed with token=PRIVATE');
      return {
        status: 'passed', completionClaim: true, output: 'done',
        events: [{ type: 'verification', succeeded: true }], durationMs: 20,
      };
    },
    async resume() { calls.push('backend.resume'); return { status: 'passed', events: [] }; },
    async cancel() { calls.push('backend.cancel'); },
    async collect() { calls.push('backend.collect'); return { diagnostics: [] }; },
    async cleanup() { calls.push('backend.cleanup'); },
  };
  const fixtureManager = {
    async prepare() { calls.push('fixture.prepare'); return { id: 'fixture-1' }; },
    async cleanup() { calls.push('fixture.cleanup'); },
  };
  const verifier = createDeterministicVerifier([{
    id: 'completion', category: 'outcome', severity: 'critical',
    check: ({ observation }) => ({ passed: observation?.status === 'passed' }),
  }]);
  const runner = createHarnessRunner({ backend, fixtureManager, verifier, now: () => new Date('2026-09-05T00:00:00.000Z') });
  assert.deepEqual(Object.keys(runner).sort(), ['cancel', 'capabilities', 'cleanup', 'collect', 'prepare', 'resume', 'run']);
  const execution = await runner.prepare({ scenario, fingerprint: { measurement: { model: 'gpt-test' }, harness: {} } });
  const first = await runner.run(execution.executionId);
  assert.equal(first.status, 'degraded');
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE/u);
  const second = await runner.run(execution.executionId);
  assert.equal(second.status, 'passed');
  await runner.resume(execution.executionId);
  await runner.cancel(execution.executionId, 'budget');
  const result = await runner.collect(execution.executionId);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.attempts[0].status, 'degraded');
  assert.equal(result.status, 'blocked');
  await runner.cleanup(execution.executionId);
  assert.ok(calls.includes('backend.cleanup'));
  assert.ok(calls.includes('fixture.cleanup'));
});

test('runner cleans a prepared fixture when backend preparation fails', async () => {
  let cleaned = false;
  const backend = {
    capabilities: ['resume'],
    async prepare() { throw new Error('runtime unavailable'); },
    async run() {}, async resume() {}, async cancel() {}, async collect() {}, async cleanup() {},
  };
  const runner = createHarnessRunner({
    backend,
    fixtureManager: {
      async prepare() { return { root: '/temporary', agent: { workspace: '/temporary/workspace' } }; },
      async cleanup() { cleaned = true; },
    },
  });
  await assert.rejects(runner.prepare({ scenario }), /runtime unavailable/u);
  assert.equal(cleaned, true);
});

test('legacy adapter, baselines, comparison, and reports share the v3 model', () => {
  const legacy = {
    schemaVersion: 2,
    generatedAt: '2026-09-04T00:00:00.000Z',
    status: 'passed',
    suite: { id: 'legacy-suite', version: '1.0.0', hash: 'suite-hash' },
    runtime: { backend: 'native', provider: 'openai', reasoningEffort: 'medium' },
    fingerprint: { model: 'gpt-test', agent: 'codex@1', runner: 'legacy', configHash: 'config' },
    trialSummaries: [{
      caseId: 'H04', repetitions: 1, passAt1: 1, passAtK: 1, passCaretK: 1,
      perTrial: [{ repetition: 1, passed: true, score: 1, toolSummary: { durationMs: 20, tokenUsage: { totalTokens: 10 } } }],
    }],
  };
  const [adapted] = adaptLegacyRun(legacy);
  assert.equal(adapted.schemaVersion, 3);
  assert.equal(adapted.source.kind, 'internal');
  assert.equal(adapted.evidence.trace.state, 'unavailable');

  const baseline = createBaseline({ id: 'baseline-1', results: [adapted], generatedAt: '2026-09-04T00:00:00.000Z' });
  assert.equal(baseline.schemaVersion, 1);
  const changed = structuredClone(adapted);
  changed.generatedAt = '2026-09-05T00:00:00.000Z';
  changed.status = 'failed';
  changed.metrics.outcome.taskSuccessRate.value = 0;
  changed.failures = [{ taxonomy: 'Verification Failure', code: 'STALE_CHECK' }];
  const comparison = compareResults({ baseline, candidateResults: [changed] });
  assert.equal(comparison.status, 'comparable');
  assert.equal(comparison.conclusion, 'regressed');
  assert.deepEqual(comparison.newFailureModes, ['Verification Failure:STALE_CHECK']);

  const report = buildReport({ title: 'Harness report', results: [changed], comparison });
  const markdown = renderMarkdownReport(report);
  const html = renderHtmlReport(report);
  assert.match(markdown, /Harness report/u);
  assert.match(markdown, /Verification Failure/u);
  assert.match(html, /<!doctype html>/iu);
  assert.doesNotMatch(html, /<script>/iu);
});

test('multi-agent comparison requires a measurable benefit and protects quality', () => {
  const make = ({ durationMs, status = 'passed', tokenUsage = 100 }) => buildResultV3({
    scenario: { id: 'H16', title: 'Dependency coordination', version: '1.0.0' },
    attempts: [{ id: 'attempt-1', status, durationMs, tokenUsage: { totalTokens: tokenUsage }, events: [] }],
    checks: [{ id: 'workflow', category: 'workflow', severity: 'critical', status }],
    fingerprint: { measurement: {}, harness: {} },
  });
  const single = make({ durationMs: 100, tokenUsage: 100 });
  const faster = compareAgentConditions({ single, multi: make({ durationMs: 75, tokenUsage: 110 }) });
  assert.equal(faster.effective, true);
  assert.deepEqual(faster.benefits, ['wall-time']);
  const lowerQuality = compareAgentConditions({ single, multi: make({ durationMs: 60, status: 'failed', tokenUsage: 80 }) });
  assert.equal(lowerQuality.effective, false);
  assert.equal(lowerQuality.qualityProtected, false);
});

test('impact selection adds fixed critical scenarios and falls back on unknown paths', () => {
  const impactMap = {
    fixedCritical: ['H01'],
    rules: [{ prefix: 'docs/rules/', scenarios: ['H04'] }],
  };
  const mapped = selectScenariosForChanges({ changedPaths: ['docs/rules/test-rules.md'], impactMap, allScenarioIds: ['H01', 'H04', 'H20'] });
  assert.deepEqual(mapped.selectedScenarioIds, ['H01', 'H04']);
  assert.equal(mapped.fallbackUsed, false);
  const unknown = selectScenariosForChanges({ changedPaths: ['unknown/file'], impactMap, allScenarioIds: ['H01', 'H04', 'H20'] });
  assert.deepEqual(unknown.selectedScenarioIds, ['H01', 'H04', 'H20']);
  assert.equal(unknown.fallbackUsed, true);
});
