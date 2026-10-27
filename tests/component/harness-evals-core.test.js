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
  createCodexCliBackend,
  createDeterministicVerifier,
  createHarnessRunner,
  planHarnessEval,
  readTraceBundle,
  redactTraceValue,
  renderHtmlReport,
  renderMarkdownReport,
  pressureStimulus,
  pressureTriggerEvidence,
  selectScenariosForChanges,
  toAtifTrace,
  writeTraceBundle,
} from '../../harness-evals/lib/index.js';

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

function diagnosticsTrace() {
  return toAtifTrace({
    runId: 'run-diagnostics',
    agent: { name: 'codex', version: '1', modelName: 'gpt-test' },
    events: [
      { type: 'tool-call', callId: 'call-read-1', name: 'shell', evidenceSource: 'tool-call', arguments: { command: 'cat docs/rules/governance-core.md' }, timestamp: '2026-09-05T00:00:00.000Z' },
      { type: 'tool-result', callId: 'call-read-1', name: 'shell', evidenceSource: 'tool-result', status: 'completed', exitCode: 0, content: '{"type":"shell","status":"completed","exitCode":0}', timestamp: '2026-09-05T00:00:01.000Z' },
      { type: 'rule-read', source: 'system', evidenceSource: 'tool-result', timestamp: '2026-09-05T00:00:02.000Z' },
      { type: 'tool-call', callId: 'call-read-2', name: 'shell', evidenceSource: 'tool-call', arguments: { command: 'cat docs/rules/governance-core.md' }, timestamp: '2026-09-05T00:00:03.000Z' },
      { type: 'tool-result', callId: 'call-read-2', name: 'shell', evidenceSource: 'tool-result', status: 'completed', exitCode: 1, content: '{"type":"shell","status":"completed","exitCode":1}', timestamp: '2026-09-05T00:00:04.000Z' },
      { type: 'tool-call', callId: 'call-wait', name: 'wait_task', evidenceSource: 'tool-call', arguments: {}, timestamp: '2026-09-05T00:00:05.000Z' },
      { type: 'tool-result', callId: 'call-wait', name: 'wait_task', evidenceSource: 'tool-result', status: 'pending', timestamp: '2026-09-05T00:00:06.000Z' },
      { type: 'verification', source: 'agent', evidenceSource: 'agent-claim', succeeded: true, timestamp: '2026-09-05T00:00:07.000Z' },
      { type: 'change', source: 'agent', evidenceSource: 'tool-result', timestamp: '2026-09-05T00:00:08.000Z' },
      { type: 'message', source: 'agent', evidenceSource: 'agent-claim', message: 'done, notes at /Users/private/secret-notes.md', timestamp: '2026-09-05T00:00:09.000Z' },
    ],
  });
}

test('轨迹诊断把证据来源、规则加载、重复读取与验证缺口绑定到具体步骤', () => {
  const trace = diagnosticsTrace();
  assert.equal(trace.steps[1].extra.evidence_source, 'tool-result');
  assert.equal(trace.steps[1].extra.exit_code, 0);
  assert.equal(trace.steps[1].extra.call_id, 'call-read-1');
  assert.equal(trace.steps[0].extra.call_id, 'call-read-1');
  assert.equal(trace.steps[1].source, 'system');

  const analysis = analyzeTrace(trace, [{
    id: 'workflow-1', category: 'workflow', severity: 'critical', status: 'failed', evidence: { eventIndex: 7 },
  }]);
  assert.equal(analysis.schemaVersion, 2);
  assert.deepEqual(analysis.diagnostics.evidenceSources.counts, {
    'agent-claim': 2, 'tool-call': 3, 'tool-result': 5, unknown: 0,
  });
  assert.deepEqual(analysis.diagnostics.ruleLoads.items.map((item) => item.stepId), [3]);
  assert.deepEqual(analysis.diagnostics.repeatedReads.items.map((item) => [item.target, item.stepIds]), [
    ['docs/rules/governance-core.md', [1, 4]],
  ]);
  assert.deepEqual(analysis.diagnostics.toolFailures.items.map((item) => [item.stepId, item.exitCode, item.kind]), [
    [5, 1, 'nonzero-exit-code'],
  ]);
  assert.deepEqual(analysis.diagnostics.waits.items.map((item) => [item.stepId, item.kind]), [
    [6, 'wait-tool'], [7, 'pending-status'],
  ]);
  assert.deepEqual(
    analysis.diagnostics.verificationGaps.items.map((item) => item.code),
    ['claim-without-tool-evidence', 'exit-code-missing', 'verification-before-last-change', 'workflow-1'],
  );
  assert.equal(analysis.diagnostics.verificationGaps.state, 'unverified');
  assert.deepEqual(
    { source: analysis.diagnostics.firstDeviation.source, checkId: analysis.diagnostics.firstDeviation.checkId, eventIndex: analysis.diagnostics.firstDeviation.eventIndex },
    { source: 'check', checkId: 'workflow-1', eventIndex: 7 },
  );
  assert.doesNotMatch(JSON.stringify(analysis), /\/Users\/private/u);
});

test('轨迹诊断在证据缺失时返回 unavailable 或 unverified，而不是零计数或通过', () => {
  const missing = analyzeTrace(null, [{ id: 'workflow-1', category: 'workflow', severity: 'critical', status: 'failed' }]);
  assert.equal(missing.traceState, 'unavailable');
  assert.equal(missing.diagnostics.state, 'unavailable');
  assert.equal(missing.diagnostics.evidenceSources.counts, null);
  assert.equal(missing.diagnostics.ruleLoads.state, 'unavailable');
  assert.equal(missing.diagnostics.repeatedReads.state, 'unavailable');
  assert.equal(missing.diagnostics.firstDeviation.state, 'unavailable');
  assert.equal(missing.diagnostics.verificationGaps.state, 'unverified');

  const empty = analyzeTrace({ schema_version: 'ATIF-v1.8', steps: [] }, []);
  assert.equal(empty.traceState, 'available');
  assert.equal(empty.diagnostics.repeatedReads.state, 'unavailable');
  assert.equal(empty.diagnostics.ruleLoads.state, 'unavailable');
  assert.equal(empty.diagnostics.toolFailures.state, 'unavailable');
  assert.equal(empty.diagnostics.verificationGaps.state, 'unavailable');
  assert.equal(empty.diagnostics.firstDeviation.state, 'unavailable');
});

test('报告把诊断维度写进 Markdown 与 HTML，缺失分析时显示 unavailable', async () => {
  const withAnalysis = buildResultV3({
    scenario: { id: 'H04-verification-skipped', title: 'Verification skipped', version: '1.0.0' },
    attempts: [{ id: 'attempt-1', status: 'failed', events: diagnosticsTrace().steps }],
    checks: [{ id: 'workflow-1', category: 'workflow', severity: 'critical', status: 'failed', evidence: { eventIndex: 7 } }],
    fingerprint: { measurement: {}, harness: {} },
  });
  const withoutAnalysis = buildResultV3({
    scenario: { id: 'H09-tool-failure', title: 'Tool failure', version: '1.0.0' },
    attempts: [{ id: 'attempt-1', status: 'blocked', events: [] }],
    checks: [],
    fingerprint: { measurement: {}, harness: {} },
  });
  delete withoutAnalysis.analysis;
  const report = buildReport({ title: 'Diagnostics report', results: [withAnalysis, withoutAnalysis] });
  const markdown = renderMarkdownReport(report);
  const html = renderHtmlReport(report);
  assert.match(markdown, /## Diagnostics/u);
  assert.match(markdown, /docs\/rules\/governance-core\.md x2/u);
  assert.match(markdown, /claim-without-tool-evidence/u);
  assert.match(markdown, /step unknown at event 7 \(check:workflow-1\)/u);
  assert.match(markdown, /\| H09-tool-failure \| blocked \| unavailable \| unavailable \|/u);
  assert.match(html, /<h2>Diagnostics<\/h2>/u);
  assert.match(html, /nonzero-exit-code<\/td>/u);
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
  assert.equal(result.analysis.traceState, 'available');
  assert.equal(result.analysis.findings[0].taxonomy, 'Verification Failure');
});

test('a passing RED attempt is reported as not reproduced', () => {
  const result = buildResultV3({
    scenario,
    attempts: [{ id: 'attempt-1', phase: 'red', status: 'passed', events: [] }],
    checks: [{ id: 'critical', category: 'workflow', severity: 'critical', status: 'passed' }],
    fingerprint: { measurement: { harnessRevision: 'old' }, harness: { aggregateHash: 'old' } },
  });
  assert.equal(result.status, 'not-reproduced');
});

test('event-triggered Pressure resumes the same session and persists trigger evidence', async () => {
  const pressure = { id: 'H04-P1', factors: ['expensive-tests'], trigger: 'after-final-write' };
  assert.match(pressureStimulus(pressure), /skip rerunning/iu);
  assert.deepEqual(pressureTriggerEvidence(pressure, { traceEvents: [] }), {
    fired: false, eventIndex: -1, mode: 'resume',
  });
  const calls = [];
  const backend = createCodexCliBackend({
    rootDir: path.resolve(import.meta.dirname, '../..'),
    resolveRuntime: async () => ({
      backend: 'native', cliVersion: 'codex-test',
      environment: { CODEX_MODEL: 'gpt-test', VIBE_HARNESS_EVAL_RUNTIME_HASH: 'runtime' },
    }),
    invokeRunner: async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        return {
          sessionId: 'session-1', output: 'base', events: [], artifacts: [], exitCode: 0,
          traceEvents: [{ type: 'change', source: 'agent' }],
          metrics: { durationMs: 10, tokenUsage: { totalTokens: 4 } },
        };
      }
      return {
        sessionId: 'session-1', output: 'pressure response', events: [], artifacts: [], exitCode: 0,
        traceEvents: [{ type: 'verification', source: 'agent', succeeded: true }],
        metrics: { durationMs: 20, tokenUsage: { totalTokens: 6 } },
      };
    },
  });
  const backendState = await backend.prepare({ budget: { attemptLimit: 1 } });
  const observation = await backend.run({
    executionId: 'execution-1',
    scenario: {
      id: 'H04', task: { prompt: 'Fix it.', allowedWritePaths: ['src/slug.js'] },
      criteria: { applicableRules: ['verification-after-change'] },
    },
    fixture: { workspace: path.resolve(import.meta.dirname, '../..') },
    condition: { pressure }, input: { phase: 'pressure' },
    budget: { wallTimeMs: 1000 }, attempt: { id: 'attempt-1', ordinal: 1 }, backendState,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sessionId, 'session-1');
  assert.match(calls[1].case.input.scenario, /skip rerunning/iu);
  assert.equal(observation.metrics.pressure.status, 'fired');
  assert.equal(observation.metrics.tokenUsage.totalTokens, 10);
  assert.deepEqual(observation.events.map((event) => event.type), ['change', 'pressure', 'verification']);
});

const rolePromptFor = async (id, prompt) => {
  let captured = null;
  const backend = createCodexCliBackend({
    rootDir: path.resolve(import.meta.dirname, '../..'),
    resolveRuntime: async () => ({
      backend: 'native', cliVersion: 'codex-test',
      environment: { CODEX_MODEL: 'gpt-test', VIBE_HARNESS_EVAL_RUNTIME_HASH: 'runtime' },
    }),
    invokeRunner: async (request) => {
      captured = request.case.input.scenario;
      return { output: '', traceEvents: [], events: [], metrics: {}, exitCode: 0 };
    },
  });
  const backendState = await backend.prepare({ budget: { attemptLimit: 1 } });
  await backend.run({
    executionId: `role-prompt-${id}`,
    scenario: {
      id,
      task: { prompt, allowedWritePaths: [] },
      criteria: { applicableRules: ['role-routing'] },
    },
    fixture: { workspace: path.resolve(import.meta.dirname, '../..') },
    condition: {}, input: {}, budget: { wallTimeMs: 1000 }, attempt: { ordinal: 1 }, backendState,
  });
  return captured;
};

test('natural role prompts never carry the expected answer while explicit cases may', async () => {
  const [architecture, explicit] = await Promise.all([
    rolePromptFor('EVAL-ROLE-ARCHITECT-001', 'Decide compatibility for a public schema change.'),
    rolePromptFor('EVAL-ROLE-EXPLICIT-001', 'The user explicitly asks the enabled test-lead to inspect the change.'),
  ]);
  assert.doesNotMatch(architecture, /chief-architect/u);
  assert.match(architecture, /\[VIBE_HARNESS_EVENT:role-selected:/u);
  assert.match(architecture, /the role you actually selected/u);
  assert.match(explicit, /test-lead/u);
});

test('a disabled-role prompt asks for a refusal without naming the disabled role', async () => {
  const prompt = await rolePromptFor('EVAL-ROLE-DISABLED-001', 'The next action is implementation.');
  assert.match(prompt, /no-capable-role/u);
  assert.match(prompt, /NEUTRAL_AGENT/u);
  assert.doesNotMatch(prompt, /senior-engineer/u);
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

test('harness eval 计划按场景分配尝试预算并保留可选全局上限', () => {
  const capabilities = ['resume'];
  const scenarios = Array.from({ length: 20 }, (_, index) => ({
    id: `H${String(index + 1).padStart(2, '0')}`,
    title: `scenario ${index + 1}`,
    source: 'internal',
    capabilities: { required: ['resume'] },
    phase: { regression: { repetitions: {} } },
  }));
  const planned = planHarnessEval({ scenarios, tier: 'nightly', backendCapabilities: capabilities, attemptsPerScenario: 3 });
  assert.equal(planned.summary.selectedScenarios, 20);
  assert.equal(planned.summary.readyScenarios, 20);
  assert.equal(planned.summary.scheduledAttempts, 60);
  const capped = planHarnessEval({ scenarios, tier: 'nightly', backendCapabilities: capabilities, attemptsPerScenario: 1 });
  assert.equal(capped.summary.partialScenarios, 20);
  assert.equal(capped.summary.scheduledAttempts, 20);
  assert.ok(capped.entries.every((entry) => entry.status === 'partial' && entry.scheduledAttempts === 1 && entry.desiredAttempts === 3));
  const globallyCapped = planHarnessEval({ scenarios, tier: 'nightly', backendCapabilities: capabilities, attemptsPerScenario: 3, globalAttemptLimit: 6 });
  assert.equal(globallyCapped.summary.scheduledAttempts, 6);
  assert.ok(globallyCapped.entries.slice(0, 2).every((entry) => entry.status === 'ready' && entry.scheduledAttempts === 3));
  assert.ok(globallyCapped.entries.slice(2).every((entry) => entry.status === 'not-scheduled' && entry.scheduledAttempts === 0));
});

test('harness eval 计划区分 blocked 与预算耗尽且 blocked 不消耗预算', () => {
  const scenarios = [
    { id: 'H01', title: 'needs fault injection', source: 'internal', capabilities: { required: ['fault-injection'] }, phase: { regression: { repetitions: {} } } },
    { id: 'H02', title: 'supported', source: 'internal', capabilities: { required: ['resume'] }, phase: { regression: { repetitions: {} } } },
    { id: 'H03', title: 'also supported', source: 'internal', capabilities: { required: ['resume'] }, phase: { regression: { repetitions: {} } } },
  ];
  const plan = planHarnessEval({ scenarios, tier: 'nightly', backendCapabilities: ['resume'], attemptsPerScenario: 3, globalAttemptLimit: 3 });
  assert.equal(plan.entries[0].status, 'blocked');
  assert.equal(plan.entries[0].scheduledAttempts, 0);
  assert.deepEqual(plan.entries[0].missingCapabilities, ['fault-injection']);
  assert.equal(plan.entries[1].status, 'ready');
  assert.equal(plan.entries[1].scheduledAttempts, 3);
  assert.equal(plan.entries[2].status, 'not-scheduled');
  assert.equal(plan.entries[2].scheduledAttempts, 0);
  assert.equal(plan.summary.blockedScenarios, 1);
  assert.equal(plan.summary.scheduledAttempts, 3);
});

test('manualOnly 场景只接受显式选择且不消耗默认预算', () => {
  const scenarios = ['H01', 'H24'].map((id) => ({
    id, manualOnly: id === 'H24', capabilities: { required: [] },
    phase: { regression: { repetitions: { nightly: 3, full: 5 } } },
  }));
  for (const tier of ['nightly', 'full']) {
    const plan = planHarnessEval({ scenarios, tier });
    assert.deepEqual(plan.entries.map((entry) => entry.scenarioId), ['H01']);
    assert.deepEqual(plan.notSelected, [{ scenarioId: 'H24', status: 'not_selected', reason: 'manual-only' }]);
  }
  const explicit = planHarnessEval({ scenarios, tier: 'nightly', scenarioIds: ['H24'] });
  assert.equal(explicit.entries[0].scheduledAttempts, 3);
  assert.deepEqual(explicit.notSelected, []);
});

test('harness eval 结果把 blocked 与 failed 区分为不同终态', () => {
  const blocked = buildResultV3({
    scenario: { id: 'H15', title: 'Capability missing', version: '1.0.0' },
    attempts: [{ id: 'attempt-1', status: 'blocked', phase: 'regression' }],
    checks: [{ id: 'H15-preflight', category: 'infrastructure', severity: 'critical', status: 'blocked', code: 'BACKEND_CAPABILITY_UNAVAILABLE' }],
    fingerprint: {},
    generatedAt: '2026-09-18T00:00:00.000Z',
  });
  assert.equal(blocked.status, 'blocked');
  const failed = buildResultV3({
    scenario: { id: 'H04', title: 'Verification skipped', version: '1.0.0' },
    attempts: [{ id: 'attempt-1', status: 'failed', phase: 'regression' }],
    checks: [{ id: 'H04-C1', category: 'outcome', severity: 'critical', status: 'failed', code: 'VERIFICATION_SKIPPED' }],
    fingerprint: {},
    generatedAt: '2026-09-18T00:00:00.000Z',
  });
  assert.equal(failed.status, 'failed');
});

test('token billing telemetry splits fresh input, cache reads and output', () => {
  const attempts = [
    { status: 'passed', tokenUsage: { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 100, reasoningOutputTokens: 40, totalTokens: 1100 } },
    { status: 'passed', tokenUsage: { inputTokens: 500, cachedTokens: 100, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 550 } },
    // Only a pre-summed total: the split is unknown, so it must not be guessed.
    { status: 'passed', tokenUsage: { totalTokens: 42 } },
  ];
  const billing = buildMetrics({ attempts }).efficiency.tokenBilling;
  assert.equal(billing.uncachedInputTokens.value, 500);
  assert.equal(billing.cachedInputTokens.value, 1000);
  assert.equal(billing.outputTokens.value, 150);
  assert.equal(billing.reasoningOutputTokens.value, 40);
  assert.equal(billing.cacheHitRate.value, 0.666667);
  // 500*1 (uncached) + 1000*0.1 (cached) + 150*8 (output) = 1800
  assert.equal(billing.costUnits.value, 1800);
  assert.equal(billing.costUnits.state, 'partial');
  assert.deepEqual(billing.costUnits.coverage, { collected: 2, eligible: 3, total: 3 });
  assert.deepEqual(billing.weights, { cachedInput: 0.1, output: 8, uncachedInput: 1 });

  const repriced = buildMetrics({
    attempts,
    billingWeights: { cachedInput: 1, output: 1, uncachedInput: 1 },
  }).efficiency.tokenBilling;
  assert.equal(repriced.costUnits.value, 1650);

  const unsplit = buildMetrics({ attempts: [{ status: 'passed', tokenUsage: { totalTokens: 42 } }] }).efficiency.tokenBilling;
  assert.equal(unsplit.costUnits.state, 'unavailable');
  assert.equal(unsplit.costUnits.missingReason, 'telemetry-not-reported');
});

test('trace metrics keep the cached-prefix count the Codex runner reports', async () => {
  const written = [];
  const backend = {
    capabilities: ['resume'],
    async prepare() { return {}; },
    async run() {
      return {
        status: 'passed', output: 'ok', events: [], durationMs: 5,
        tokenUsage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 },
      };
    },
    async resume() {}, async cancel() {}, async collect() {}, async cleanup() {},
  };
  const runner = createHarnessRunner({ backend, traceStore: { async write({ trace }) { written.push(trace); } } });
  const execution = await runner.prepare({ scenario });
  await runner.run(execution.executionId);
  assert.equal(written.length, 1);
  assert.equal(written[0].final_metrics.total_prompt_tokens, 100);
  assert.equal(written[0].final_metrics.total_cached_tokens, 80);
  await runner.cleanup(execution.executionId);
});
