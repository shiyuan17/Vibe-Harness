import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexHookResult } from '../runtime/hooks/lib/policy.mjs';
import { inputEventFromContext, isGitCommitCommand, transcript } from '../runtime/evals/codex-runner.mjs';
import { buildEvalReportModel } from '../scripts/lib/eval-report.js';
import { summarizeTrials } from '../scripts/lib/eval-trials.js';
import { validateJsonAgainstSchema } from '../scripts/lib/manifest.js';
import { readJson } from '../scripts/lib/manifest.js';

const rootDir = new URL('..', import.meta.url);

function runFixture(caseId, perTrial) {
  return {
    attemptSummary: { eligibleLegalWriteTrials: 0, infrastructureFailures: 0, readyTrials: perTrial.length, safetyFalsePositiveTrials: 0, startedTrials: perTrial.length },
    campaignId: 'campaign-governance',
    fingerprint: { agent: 'codex-cli', configHash: 'h', model: 'm', runner: 'codex-reference@2-native', suiteHash: `${caseId}-h` },
    generatedAt: '2026-07-31T00:00:00.000Z',
    reference: { path: `evals/references/${caseId}.json`, status: 'missing' },
    runtime: { backend: 'native', provider: 'custom', reasoningEffort: 'medium', wireApi: 'responses' },
    status: 'passed',
    suite: { hash: `${caseId}-h`, id: caseId, path: `evals/suites/${caseId}.json`, version: '1.0.0' },
    caseRepetitions: [{ id: caseId, count: perTrial.length }],
    trialSummaries: [{ caseId, meanScore: 1, passAt1: 1, passAtK: 1, passCaretK: 1, passedTrials: perTrial.length, repetitions: perTrial.length, perTrial }],
  };
}

function trialWithGovernance(overrides = {}) {
  return {
    criticalFailures: 0, failedAssertions: [], passed: true, repetition: 1, score: 1,
    toolSummary: {
      commandCount: 1, durationMs: 1000, errorCategories: [], hookReasonCodes: [], hookTimings: [],
      recoverableToolErrorCount: 0, ruleCoverage: { expected: [], measured: [] }, skillTriggers: [],
      testSummary: { apiContractFailures: 0, apiExistenceFailures: 0, failed: 0, passed: 1, total: 1 },
      tokenUsage: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 },
      toolCalls: 1, toolOutcomeSummary: { expectedDenied: 0, failed: 0, knownTotal: 1, successful: 1, total: 1, unexpectedFailed: 0, unknown: 0 },
      toolOutcomes: [], toolTypes: ['command_execution'], totalTokens: 15, verificationCommandCount: 0,
      workspaceSummary: { allowedChangedCount: 0, architectureViolationCount: 0, existingFileOverwriteCount: 0, totalChangedCount: 0, undeclaredWriteCount: 0 },
      ...overrides,
    },
  };
}

test('createCodexHookResult embeds durationMs in the policy marker for deny decisions', () => {
  const result = createCodexHookResult('PreToolUse', { action: 'deny', reason: 'blocked', reasonCode: 'DESTRUCTIVE_GIT' }, { durationMs: 12 });
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /\[VIBE_HARNESS_POLICY:DESTRUCTIVE_GIT:12\]/u);
});

test('createCodexHookResult omits duration suffix when not provided for backward compatibility', () => {
  const result = createCodexHookResult('PreToolUse', { action: 'deny', reason: 'blocked', reasonCode: 'RED_ZONE' });
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /\[VIBE_HARNESS_POLICY:RED_ZONE\] blocked/u);
  assert.doesNotMatch(result.hookSpecificOutput.permissionDecisionReason, /:\d+\]/u);
});

test('createCodexHookResult returns empty for allow decisions regardless of durationMs', () => {
  const result = createCodexHookResult('PreToolUse', { action: 'allow' }, { durationMs: 5 });
  assert.deepEqual(result, {});
});

test('transcript parses policy markers with optional durationMs into hookTimings and hookReasonCodes', () => {
  const stdout = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: 'denied: [VIBE_HARNESS_POLICY:DESTRUCTIVE_GIT:12] blocked' } });
  const parsed = transcript(stdout);
  assert.deepEqual(parsed.hookReasonCodes, ['DESTRUCTIVE_GIT']);
  assert.equal(parsed.hookTimings.length, 1);
  assert.equal(parsed.hookTimings[0].reasonCode, 'DESTRUCTIVE_GIT');
  assert.equal(parsed.hookTimings[0].durationMs, 12);
  assert.equal(parsed.hookTimings[0].action, 'deny');
  assert.equal(parsed.hookTimings[0].event, 'PreToolUse');
});

test('transcript parses legacy markers without durationMs and defaults durationMs to 0', () => {
  const stdout = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: 'denied: [VIBE_HARNESS_POLICY:RED_ZONE] warn' } });
  const parsed = transcript(stdout);
  assert.deepEqual(parsed.hookReasonCodes, ['RED_ZONE']);
  assert.equal(parsed.hookTimings[0].durationMs, 0);
});

test('transcript leaves event null for agent_message items', () => {
  const stdout = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '[VIBE_HARNESS_POLICY:GLOBAL_AGENT_CONFIG:3]' } });
  const parsed = transcript(stdout);
  assert.equal(parsed.hookTimings[0].event, null);
});

test('inputEventFromContext returns PreToolUse for tool items and null for reasoning', () => {
  assert.equal(inputEventFromContext({ type: 'item.completed', item: { type: 'command_execution' } }), 'PreToolUse');
  assert.equal(inputEventFromContext({ type: 'item.completed', item: { type: 'reasoning' } }), null);
  assert.equal(inputEventFromContext({ type: 'turn.completed' }), null);
});

test('git commit observer detects commit invocations without persisting command text', () => {
  assert.equal(isGitCommitCommand('git commit -m change'), true);
  assert.equal(isGitCommitCommand('git -C project commit -m change'), true);
  assert.equal(isGitCommitCommand('git status --short'), false);
});

test('summarizeTrials passes hookTimings, ruleCoverage, and skillTriggers through to toolSummary', () => {
  const observation = {
    metrics: {
      hookTimings: [{ event: 'PreToolUse', action: 'deny', reasonCode: 'DESTRUCTIVE_GIT', durationMs: 9 }],
      ruleCoverage: { expected: ['governance-core'], measured: ['governance-core'] },
      skillTriggers: [{ id: 'eval-driven-development', source: 'declared' }],
    },
  };
  const summary = summarizeTrials('CASE-1', [{ caseResult: { passed: true, score: 1 }, observation }]);
  const toolSummary = summary.perTrial[0].toolSummary;
  assert.equal(toolSummary.hookTimings.length, 1);
  assert.deepEqual(toolSummary.ruleCoverage.expected, ['governance-core']);
  assert.equal(toolSummary.skillTriggers[0].id, 'eval-driven-development');
});

test('summarizeTrials supplies empty defaults when observation metrics omit governance fields', () => {
  const summary = summarizeTrials('CASE-1', [{ caseResult: { passed: true, score: 1 }, observation: { metrics: {} } }]);
  const toolSummary = summary.perTrial[0].toolSummary;
  assert.deepEqual(toolSummary.hookTimings, []);
  assert.deepEqual(toolSummary.ruleCoverage, { expected: [], measured: [] });
  assert.deepEqual(toolSummary.skillTriggers, []);
});

test('summarizeTrials reconciles comparable knowledge coverage Episodes without a new gate', () => {
  const base = {
    schemaVersion: 1,
    requestRoot: 'eval/knowledge-routing',
    inventoryComplete: true,
    events: [
      { type: 'request-root', id: 'eval/knowledge-routing' },
      { type: 'validation', status: 'passed' },
      { type: 'stop-boundary', expected: 'validated-handoff', observed: 'validated-handoff', reached: true },
    ],
    matchStatus: 'no-match-confirmed',
    state: 'needs-more-evidence',
    promotionStatus: 'blocked-insufficient-evidence',
  };
  const trials = ['case-1/r1', 'case-1/r2'].map((episodeRef) => ({
    caseResult: { passed: true, score: 1 },
    observation: { metrics: { knowledgeCoverage: { ...base, episodeRef } } },
  }));
  const summary = summarizeTrials('CASE-1', trials);
  assert.equal(summary.knowledgeCoverageSummary.state, 'confirmed-uncovered');
  assert.equal(summary.passCaretK, 1);
});

test('buildEvalReportModel aggregates rule coverage, skill triggers, and hook timings across trials', () => {
  const trialA = trialWithGovernance({
    hookTimings: [{ event: 'PreToolUse', action: 'deny', reasonCode: 'DESTRUCTIVE_GIT', durationMs: 10 }],
    ruleCoverage: { expected: ['governance-core', 'git-rules'], measured: ['governance-core'] },
    skillTriggers: [{ id: 'eval-driven-development', source: 'declared' }],
  });
  const trialB = trialWithGovernance({
    hookTimings: [{ event: 'PreToolUse', action: 'deny', reasonCode: 'RED_ZONE', durationMs: 20 }],
    ruleCoverage: { expected: ['governance-core'], measured: ['governance-core'] },
    skillTriggers: [{ id: 'api-and-interface-design', source: 'declared' }],
  });
  trialB.passed = false;
  const executionRun = runFixture('vibe-harness-online-execution', [trialA]);
  const canaryRun = runFixture('vibe-harness-online-canary', [trialB]);
  const model = buildEvalReportModel({
    canaryRun, canarySuite: { cases: [{ id: 'CANARY-CASE', risk: 'low' }] },
    executionRun, executionSuite: { cases: [{ id: 'EXEC-CASE', risk: 'low' }] },
  });
  // rule coverage: only observed invocation counts; declarations remain the denominator.
  assert.equal(model.metrics.ruleCoverage.uniqueRules, 2);
  assert.equal(model.metrics.ruleCoverage.totalDeclared, 3);
  assert.equal(model.metrics.ruleCoverage.totalPassed, 1);
  assert.equal(model.metrics.ruleCoverage.value, Math.round((1 / 3) * 1_000_000) / 1_000_000);
  const govRule = model.metrics.ruleCoverage.byRule.find((item) => item.id === 'governance-core');
  assert.equal(govRule.declaredCases, 2);
  assert.equal(govRule.passedCases, 1);
  // skill triggers: 2 distinct skills, 1 passed each => 2/2
  assert.equal(model.metrics.skillTriggers.uniqueSkills, 2);
  assert.equal(model.metrics.skillTriggers.totalPassed, 1);
  // hook timings: 2 invocations, durations 10 + 20 => avg 15, p50 15, p95 19.5
  assert.equal(model.metrics.hookTimings.totalInvocations, 2);
  assert.equal(model.metrics.hookTimings.averageMs, 15);
  assert.equal(model.metrics.hookTimings.p50Ms, 15);
  assert.equal(model.metrics.hookTimings.p95Ms, 19.5);
  assert.equal(model.metrics.hookTimings.slowestMs, 20);
  assert.equal(model.metrics.hookTimings.byReasonCode.length, 2);
});

test('buildEvalReportModel reports unavailable governance metrics when no trials declare them', () => {
  const executionRun = runFixture('vibe-harness-online-execution', [trialWithGovernance()]);
  const canaryRun = runFixture('vibe-harness-online-canary', [trialWithGovernance()]);
  const model = buildEvalReportModel({
    canaryRun, canarySuite: { cases: [{ id: 'CANARY-CASE', risk: 'low' }] },
    executionRun, executionSuite: { cases: [{ id: 'EXEC-CASE', risk: 'low' }] },
  });
  assert.equal(model.metrics.ruleCoverage.state, 'unavailable');
  assert.equal(model.metrics.skillTriggers.state, 'unavailable');
  assert.equal(model.metrics.hookTimings.state, 'unavailable');
  assert.equal(model.metrics.hookTimings.totalInvocations, 0);
});

test('rendered report includes the governance coverage group and trial-level governance rows', async () => {
  const { renderEvalReport } = await import('../scripts/lib/eval-report.js');
  const trial = trialWithGovernance({
    hookTimings: [{ event: 'PreToolUse', action: 'deny', reasonCode: 'DESTRUCTIVE_GIT', durationMs: 8 }],
    ruleCoverage: { expected: ['governance-core'], measured: ['governance-core'] },
    skillTriggers: [{ id: 'eval-driven-development', source: 'declared' }],
  });
  const executionRun = runFixture('vibe-harness-online-execution', [trial]);
  const canaryRun = runFixture('vibe-harness-online-canary', [trialWithGovernance()]);
  const model = buildEvalReportModel({
    canaryRun, canarySuite: { cases: [{ id: 'CANARY-CASE', risk: 'low' }] },
    executionRun, executionSuite: { cases: [{ id: 'EXEC-CASE', risk: 'low' }] },
  });
  const html = renderEvalReport(model);
  assert.match(html, /治理覆盖/u);
  assert.match(html, /规则覆盖通过率/u);
  assert.match(html, /技能覆盖通过率/u);
  assert.match(html, /Hook 平均耗时/u);
  assert.match(html, /声明规则/u);
  assert.match(html, /声明技能/u);
  assert.match(html, /Hook 耗时/u);
});

test('eval-run schema accepts toolSummary with the new governance fields', async () => {
  const runSchema = await readJson(new URL('schemas/eval-run.schema.json', rootDir));
  const minimalTrialSummary = {
    caseId: 'CASE-1', repetitions: 1, passAt1: 1, passAtK: 1, passCaretK: 1, passedTrials: 1, meanScore: 1,
    perTrial: [{
      repetition: 1, passed: true, score: 1,
      toolSummary: {
        hookTimings: [{ event: 'PreToolUse', action: 'deny', reasonCode: 'RED_ZONE', durationMs: 5 }],
        knowledgeCoverage: {
          schemaVersion: 1,
          episodeRef: 'case-1/r1',
          requestRoot: 'eval/knowledge-routing',
          inventoryComplete: true,
          events: [
            { type: 'request-root', id: 'eval/knowledge-routing' },
            { type: 'owner', kind: 'skill', id: 'eval-driven-development', status: 'invoked' },
            { type: 'validation', status: 'passed' },
            { type: 'stop-boundary', expected: 'validated-handoff', observed: 'validated-handoff', reached: true },
          ],
          matchStatus: 'covered',
          state: 'covered',
          promotionStatus: 'blocked-existing-owner',
        },
        ruleCoverage: { expected: ['governance-core'], measured: ['governance-core'] },
        skillTriggers: [{ id: 'eval-driven-development', source: 'declared' }],
      },
    }],
  };
  const run = {
    schemaVersion: 1, id: 'r', generatedAt: '2026-07-31T00:00:00.000Z', mode: 'online', status: 'passed',
    suite: { id: 's', version: '1.0.0', hash: 'h', path: 'p' },
    fingerprint: { suiteHash: 'h', runner: 'codex-reference@2-native', model: 'm', agent: 'a', configHash: 'c' },
    caseRepetitions: [{ id: 'CASE-1', count: 1 }],
    trialSummaries: [minimalTrialSummary],
    cases: [{ id: 'CASE-1', capability: 'cap', passed: true, score: 1, weight: 1, criticalAssertions: 0, criticalFailures: 0, dimensionScores: { correctness: 1, safety: 1, evidenceQuality: 1, efficiency: 1 }, assertions: [{ kind: 'required-event', dimension: 'correctness', critical: false, expected: 'e', passed: true }] }],
    capabilities: [{ id: 'cap', caseCount: 1, passedCount: 1, score: 1 }],
    overallScore: 1, criticalPassRate: 1, diagnostics: [],
  };
  const errors = validateJsonAgainstSchema(run, runSchema, 'governance-run');
  assert.equal(errors.length, 0, `expected no schema errors, got: ${JSON.stringify(errors)}`);
});

test('eval-suite schema accepts case.reporting.expected with rules and skills', async () => {
  const suiteSchema = await readJson(new URL('schemas/eval-suite.schema.json', rootDir));
  const suite = {
    schemaVersion: 1, id: 's', version: '1.0.0', description: 'd', defaultRepetitions: 1,
    cases: [{
      id: 'CASE-1', category: 'safety-isolation', capability: 'cap', risk: 'low', repetitions: 1,
      reporting: {
        expected: { rules: ['governance-core'], skills: ['eval-driven-development'] },
        knowledgeCoverage: {
          requestRoot: 'eval/knowledge-routing',
          candidateOwners: [{ kind: 'skill', id: 'eval-driven-development' }],
          inventoryComplete: true,
          stopBoundary: 'validated-handoff',
        },
      },
      input: { scenario: 's', replay: { events: [], output: '', artifacts: [], exitCode: 0 } },
      oracle: { requiredEvents: [], forbiddenEvents: [], requiredOutputFragments: [], forbiddenOutputFragments: [], requiredArtifacts: [], forbiddenArtifacts: [], exitCode: { value: 0, dimension: 'correctness', critical: false } },
      weights: { correctness: 1, safety: 0, evidenceQuality: 0, efficiency: 0 },
    }],
  };
  const errors = validateJsonAgainstSchema(suite, suiteSchema, 'governance-suite');
  assert.equal(errors.length, 0, `expected no schema errors, got: ${JSON.stringify(errors)}`);
});

test('validateEvalSuiteSemantics flags declared rule/skill ids absent from manifests', async () => {
  const { validateEvalSuiteSemantics } = await import('../scripts/lib/eval-contract.js');
  const suite = {
    defaultRepetitions: 1,
    cases: [{
      id: 'CASE-1', repetitions: 1,
      reporting: { expected: { rules: ['governance-core', 'nonexistent-rule'], skills: ['eval-driven-development', 'nonexistent-skill'] } },
      weights: { correctness: 1, safety: 0, evidenceQuality: 0, efficiency: 0 },
      oracle: { requiredEvents: [{ value: 'e', dimension: 'correctness', critical: false }] },
    }],
  };
  const manifests = {
    rules: { items: [{ id: 'governance-core', source: 'rules/governance-core.md' }] },
    skills: { items: [{ id: 'eval-driven-development', source: 'skills/core/eval-driven-development/SKILL.md', metadata: 'm', kind: 'native' }] },
  };
  const errors = validateEvalSuiteSemantics(suite, manifests);
  assert.ok(errors.some((item) => /unknown rule id: nonexistent-rule/u.test(item)));
  assert.ok(errors.some((item) => /unknown skill id: nonexistent-skill/u.test(item)));
  assert.ok(!errors.some((item) => /governance-core/u.test(item)));
});

test('validateEvalSuiteSemantics rejects unknown knowledge coverage owners', async () => {
  const { validateEvalSuiteSemantics } = await import('../scripts/lib/eval-contract.js');
  const suite = {
    defaultRepetitions: 1,
    cases: [{
      id: 'CASE-1', repetitions: 1,
      reporting: { knowledgeCoverage: {
        requestRoot: 'eval/knowledge-routing',
        candidateOwners: [{ kind: 'skill', id: 'nonexistent-skill' }],
        inventoryComplete: true,
        stopBoundary: 'validated-handoff',
      } },
      weights: { correctness: 1, safety: 0, evidenceQuality: 0, efficiency: 0 },
      oracle: { requiredEvents: [{ value: 'e', dimension: 'correctness', critical: false }] },
    }],
  };
  const manifests = {
    rules: { items: [] },
    skills: { items: [{ id: 'eval-driven-development' }] },
  };
  const errors = validateEvalSuiteSemantics(suite, manifests);
  assert.ok(errors.some((item) => /unknown skill id: nonexistent-skill/u.test(item)));
});
