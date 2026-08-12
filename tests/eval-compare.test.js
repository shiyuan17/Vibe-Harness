import assert from 'node:assert/strict';
import test from 'node:test';

import { compareEvalWindows } from '../scripts/lib/eval-compare.js';

function run(day, { observed = false, verified = false, degraded = false, model = 'gpt-5' } = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-' + String(day).padStart(2, '0') + 'T02:00:00.000Z',
    status: degraded ? 'degraded' : 'passed',
    suite: { id: 'online', version: '1.0.0', hash: 'suite-hash', path: 'evals/online.json' },
    runtime: { backend: 'native', provider: 'openai', reasoningEffort: 'medium', wireApi: 'responses' },
    fingerprint: { suiteHash: 'suite-hash', runner: 'codex-reference@2-native', model, agent: 'codex-cli@1', configHash: 'config' },
    caseRepetitions: [{ id: 'CASE-1', count: 1 }],
    criticalPassRate: 1,
    trialSummaries: [{
      caseId: 'CASE-1', repetitions: 1, passAt1: 1, passAtK: 1, passCaretK: 1,
      passedTrials: 1, meanScore: 1,
      perTrial: [{
        repetition: 1, passed: true, score: 1,
        toolSummary: {
          durationMs: 100,
          tokenUsage: { totalTokens: 10 },
          toolOutcomeSummary: { unexpectedFailed: 0 },
          workspaceSummary: { architectureViolationCount: 0, undeclaredWriteCount: 0 },
          taskEpisode: {
            taskFamily: 'delivery',
            owner: { kind: 'skill', id: 'eval-driven-development', evidenceState: observed ? 'observed' : 'resolved-active' },
            validationStatus: verified ? 'verified' : 'missing',
            stopBoundary: verified ? 'verified-handoff' : 'failed',
            outcome: verified ? 'passed' : 'failed',
          },
        },
      }],
    }],
  };
}

test('EVAL-WINDOW-COMPARE-001 compares comparable seven-day windows without hard-gating cost', () => {
  const baselineRuns = Array.from({ length: 7 }, (_, index) => run(index + 1));
  const candidateRuns = Array.from({ length: 7 }, (_, index) => run(index + 8, { observed: true, verified: true }));
  const comparison = compareEvalWindows({ baselineRuns, candidateRuns });
  assert.equal(comparison.status, 'comparable');
  assert.equal(comparison.conclusion, 'improved');
  assert.equal(comparison.primary.ownerObservedRate.baseline, 0);
  assert.equal(comparison.primary.ownerObservedRate.candidate, 1);
  assert.equal(comparison.primary.verifiedHandoffRate.candidate, 1);
  assert.equal(comparison.advisory.meanTokens.candidate, 10);
});

test('EVAL-WINDOW-COMPARE-002 reports insufficient evidence for missing days, mismatches, degraded runs, or unavailable episodes', () => {
  const complete = Array.from({ length: 7 }, (_, index) => run(index + 1, { observed: true, verified: true }));
  assert.equal(compareEvalWindows({ baselineRuns: complete.slice(0, 6), candidateRuns: complete }).status, 'insufficient-evidence');
  assert.equal(compareEvalWindows({ baselineRuns: complete, candidateRuns: complete.map((item, index) => index === 0 ? run(8, { model: 'other' }) : item) }).status, 'insufficient-evidence');
  assert.equal(compareEvalWindows({ baselineRuns: complete, candidateRuns: complete.map((item, index) => index === 0 ? run(8, { degraded: true }) : item) }).status, 'insufficient-evidence');
  const unavailable = structuredClone(complete);
  for (const item of unavailable) delete item.trialSummaries[0].perTrial[0].toolSummary.taskEpisode;
  const result = compareEvalWindows({ baselineRuns: unavailable, candidateRuns: complete });
  assert.equal(result.status, 'insufficient-evidence');
  assert.equal(result.primary.ownerObservedRate.baseline, null);
  const guardrailUnavailable = structuredClone(complete);
  for (const item of guardrailUnavailable) delete item.trialSummaries[0].perTrial[0].toolSummary.workspaceSummary;
  const guardrailResult = compareEvalWindows({ baselineRuns: guardrailUnavailable, candidateRuns: complete });
  assert.equal(guardrailResult.status, 'insufficient-evidence');
  assert.equal(guardrailResult.guardrails.dangerousWrites.baseline, null);
});
