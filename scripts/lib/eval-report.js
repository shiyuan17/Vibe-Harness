const RISK_REWORK_MINUTES = { critical: 60, high: 45, low: 15, medium: 30 };

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sum(items, selector) {
  return items.reduce((total, item) => total + Number(selector(item) ?? 0), 0);
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return round(lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower), 2);
}

function measured(numerator, denominator, { collected = denominator, eligible = denominator, state, total = denominator } = {}) {
  const resolved = state ?? (denominator === 0 ? 'na' : 'value');
  return {
    collected,
    denominator,
    eligible,
    numerator,
    state: resolved,
    total,
    value: resolved === 'value' || resolved === 'partial' ? round(numerator / denominator) : null,
  };
}

function scalar(value, { collected = 1, eligible = 1, state = 'value', total = 1 } = {}) {
  return { collected, eligible, state, total, value: state === 'unavailable' || state === 'na' ? null : value };
}

function caseLookup(suite) {
  return new Map((suite?.cases ?? []).map((item) => [item.id, item]));
}

function trialRows(run, suite) {
  const definitions = caseLookup(suite);
  return (run.trialSummaries ?? []).flatMap((summary) => (summary.perTrial ?? []).map((trial) => ({
    caseId: summary.caseId,
    definition: definitions.get(summary.caseId),
    passAt1: summary.passAt1,
    passAtK: summary.passAtK,
    passCaretK: summary.passCaretK,
    repetition: trial.repetition,
    repetitions: summary.repetitions,
    suiteId: run.suite.id,
    trial,
  })));
}

function aggregateTokens(trials) {
  const fields = ['cachedInputTokens', 'inputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
  const collectedTrials = trials.filter((item) => item.trial.toolSummary?.tokenUsage);
  const usage = Object.fromEntries(fields.map((field) => [field, sum(collectedTrials, (item) => item.trial.toolSummary.tokenUsage[field])]));
  return { collected: collectedTrials.length, eligible: trials.length, total: trials.length, ...usage };
}

function latency(trials) {
  const rows = trials.filter((item) => Number.isFinite(item.trial.toolSummary?.durationMs));
  const values = rows.map((item) => item.trial.toolSummary.durationMs);
  const slowest = [...rows].sort((left, right) => right.trial.toolSummary.durationMs - left.trial.toolSummary.durationMs)[0];
  return {
    averageMs: values.length ? round(sum(values, (value) => value) / values.length, 2) : null,
    collected: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    slowestCase: slowest?.caseId ?? null,
    slowestMs: slowest?.trial.toolSummary.durationMs ?? null,
    state: values.length === 0 ? 'unavailable' : (values.length < trials.length ? 'partial' : 'value'),
    eligible: trials.length,
    total: trials.length,
  };
}

// Governance coverage: declarative rule/skill coverage aggregated across trials.
// Each case may declare `reporting.expected.rules` / `reporting.expected.skills`
// (ids from manifests/rules.json + manifests/skills.json). We report, per id,
// how many cases declared it and how many of those passed, plus an overall
// coverage ratio. Borrowed from NeMo Guardrails `activated_rails` model: the
// per-rail usage ratio = declared-and-passed / declared.
function aggregateRuleCoverage(trials) {
  const rows = trials.filter((item) => item.trial.toolSummary?.ruleCoverage?.expected?.length);
  const byRule = new Map();
  for (const item of rows) {
    for (const id of item.trial.toolSummary.ruleCoverage.expected) {
      const entry = byRule.get(id) ?? { id, declaredCases: 0, passedCases: 0 };
      entry.declaredCases += 1;
      if (item.trial.passed && item.trial.toolSummary.ruleCoverage.measured.includes(id)) entry.passedCases += 1;
      byRule.set(id, entry);
    }
  }
  const list = [...byRule.values()].map((entry) => ({
    ...entry,
    passRate: entry.declaredCases ? round(entry.passedCases / entry.declaredCases) : null,
  }));
  const totalDeclared = sum(list, (item) => item.declaredCases);
  const totalPassed = sum(list, (item) => item.passedCases);
  return {
    byRule: list,
    collected: rows.length,
    eligible: trials.length,
    state: rows.length ? (rows.length < trials.length ? 'partial' : 'value') : 'unavailable',
    totalDeclared,
    totalPassed,
    uniqueRules: list.length,
    value: totalDeclared ? round(totalPassed / totalDeclared) : null,
  };
}

function aggregateSkillTriggers(trials) {
  const rows = trials.filter((item) => item.trial.toolSummary?.skillTriggers?.length);
  const bySkill = new Map();
  for (const item of rows) {
    for (const trigger of item.trial.toolSummary.skillTriggers) {
      const entry = bySkill.get(trigger.id) ?? { id: trigger.id, declaredCases: 0, passedCases: 0 };
      entry.declaredCases += 1;
      if (item.trial.passed) entry.passedCases += 1;
      bySkill.set(trigger.id, entry);
    }
  }
  const list = [...bySkill.values()].map((entry) => ({
    ...entry,
    passRate: entry.declaredCases ? round(entry.passedCases / entry.declaredCases) : null,
  }));
  const totalDeclared = sum(list, (item) => item.declaredCases);
  const totalPassed = sum(list, (item) => item.passedCases);
  return {
    bySkill: list,
    collected: rows.length,
    eligible: trials.length,
    state: rows.length ? (rows.length < trials.length ? 'partial' : 'value') : 'unavailable',
    totalDeclared,
    totalPassed,
    uniqueSkills: list.length,
    value: totalDeclared ? round(totalPassed / totalDeclared) : null,
  };
}

// Hook timing: aggregates [VIBE_HARNESS_POLICY:CODE:durationMs] markers harvested
// from the transcript. Mirrors OTel `gen_ai.execute_tool.duration` p50/p95
// reporting and Claude Code's duration_ms vs duration_api_ms split (here the
// hook overhead is isolated from the whole-trial durationMs).
function aggregateHookTimings(trials) {
  const rows = trials.flatMap((item) => item.trial.toolSummary?.hookTimings ?? []);
  if (rows.length === 0) {
    return { averageMs: null, byReasonCode: [], collected: 0, eligible: trials.length, p50Ms: null, p95Ms: null, slowestMs: null, state: 'unavailable', totalInvocations: 0, total: trials.length };
  }
  const durations = rows.map((item) => item.durationMs).filter(Number.isFinite);
  const byCode = new Map();
  for (const row of rows) {
    const code = row.reasonCode ?? 'UNKNOWN';
    const entry = byCode.get(code) ?? { averageMs: 0, count: 0, reasonCode: code, totalMs: 0 };
    entry.count += 1;
    entry.totalMs += Number(row.durationMs ?? 0);
    byCode.set(code, entry);
  }
  return {
    averageMs: durations.length ? round(sum(durations, (value) => value) / durations.length, 2) : null,
    byReasonCode: [...byCode.values()].map((entry) => ({
      averageMs: entry.count ? round(entry.totalMs / entry.count, 2) : null,
      count: entry.count,
      reasonCode: entry.reasonCode,
    })).sort((left, right) => right.count - left.count),
    collected: rows.length,
    eligible: trials.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    slowestMs: durations.length ? Math.max(...durations) : null,
    state: rows.length ? 'value' : 'unavailable',
    totalInvocations: rows.length,
    total: trials.length,
  };
}

function aggregateSuite(run, suite) {
  const summaries = run.trialSummaries ?? [];
  const trials = trialRows(run, suite);
  const stable = summaries.filter((item) => item.repetitions > 1);
  return {
    caseCount: summaries.length,
    completedCases: summaries.filter((item) => item.passAtK === 1).length,
    firstPassCases: summaries.filter((item) => item.passAt1 === 1).length,
    latency: latency(trials),
    stableCases: stable.filter((item) => item.passCaretK === 1).length,
    stableEligibleCases: stable.length,
    suiteId: run.suite.id,
    tokens: aggregateTokens(trials),
    trialCount: trials.length,
    trialPassed: trials.filter((item) => item.trial.passed).length,
    trials,
  };
}

function normalizedOutcome(summary) {
  if (!summary) return null;
  const expectedDenied = Number(summary.expectedDenied ?? 0);
  const unexpectedFailed = Number(summary.unexpectedFailed ?? summary.failed ?? 0);
  const successful = Number(summary.successful ?? 0);
  return {
    expectedDenied,
    knownTotal: Number(summary.knownTotal ?? successful + expectedDenied + unexpectedFailed),
    successful,
    unexpectedFailed,
    unknown: Number(summary.unknown ?? 0),
  };
}

function attemptRows(run, extras) {
  return [
    ...(run.attemptSummary ? [{ artifact: 'run', campaignId: run.campaignId, summary: run.attemptSummary }] : []),
    ...(extras ?? []).map((item) => ({ artifact: 'attempt', campaignId: item.campaignId, summary: item.attemptSummary })),
  ].filter((item) => item.summary);
}

function sameRepetitions(left, right) {
  return JSON.stringify(left.caseRepetitions ?? []) === JSON.stringify(right.caseRepetitions ?? []);
}

export function assessRunComparison(current, comparison) {
  if (!comparison) return { compatible: false, reason: '未提供历史 run', state: 'unavailable' };
  const fields = [
    ['model', current.fingerprint.model, comparison.fingerprint.model],
    ['provider', current.runtime?.provider, comparison.runtime?.provider],
    ['reasoning', current.runtime?.reasoningEffort, comparison.runtime?.reasoningEffort],
    ['backend', current.runtime?.backend, comparison.runtime?.backend],
    ['CLI', current.fingerprint.agent, comparison.fingerprint.agent],
  ];
  const mismatch = fields.find(([, left, right]) => left !== right);
  if (mismatch || !sameRepetitions(current, comparison)) {
    return { compatible: false, reason: `${mismatch?.[0] ?? 'repetitions'} 不匹配`, state: 'incompatible' };
  }
  if (current.suite.hash !== comparison.suite.hash) return { compatible: false, reason: 'Suite hash 不同，不可直接比较', state: 'incompatible-suite' };
  return { compatible: true, reason: '同指纹、同 Suite', state: 'value' };
}

export function buildEvalReportModel({
  canaryAttempts = [], canaryComparisonRun, canaryRun, canarySuite,
  executionAttempts = [], executionComparisonRun, executionRun, executionSuite,
}) {
  const suites = [aggregateSuite(executionRun, executionSuite), aggregateSuite(canaryRun, canarySuite)];
  const summaries = [...(executionRun.trialSummaries ?? []), ...(canaryRun.trialSummaries ?? [])];
  const trials = suites.flatMap((item) => item.trials);
  const executionTrials = suites[0].trials;
  const totalCases = summaries.length;
  const completedCases = summaries.filter((item) => item.passAtK === 1).length;
  const firstPassCases = summaries.filter((item) => item.passAt1 === 1).length;
  const stableEligible = summaries.filter((item) => item.repetitions > 1);
  const stableCases = stableEligible.filter((item) => item.passCaretK === 1).length;
  const toolEligible = trials.filter((item) => (item.definition?.reporting?.toolMetricMode ?? 'execute') !== 'exclude');
  const outcomeRows = toolEligible.map((item) => normalizedOutcome(item.trial.toolSummary?.toolOutcomeSummary)).filter(Boolean);
  const toolSuccessful = sum(outcomeRows, (item) => item.successful);
  const toolExpectedDenied = sum(outcomeRows, (item) => item.expectedDenied);
  const toolUnexpectedFailed = sum(outcomeRows, (item) => item.unexpectedFailed);
  const toolKnown = sum(outcomeRows, (item) => item.knownTotal);
  const toolUnknown = sum(outcomeRows, (item) => item.unknown);
  const testEligible = trials.filter((item) => (item.definition?.input?.fixture?.tests ?? []).length > 0);
  const testRows = testEligible.filter((item) => item.trial.toolSummary?.testSummary);
  const testsPassed = sum(testRows, (item) => item.trial.toolSummary.testSummary.passed);
  const testsTotal = sum(testRows, (item) => item.trial.toolSummary.testSummary.total);
  const existenceEligible = testEligible.filter((item) => (item.definition?.input?.fixture?.tests ?? [])
    .some((test) => test.diagnosticCategory === 'api-existence'));
  const existenceCollected = existenceEligible.filter((item) => Number.isInteger(item.trial.toolSummary?.testSummary?.apiExistenceFailures));
  const apiExistenceFailures = sum(existenceCollected, (item) => item.trial.toolSummary.testSummary.apiExistenceFailures);
  const apiContractFailures = sum(testRows, (item) => item.trial.toolSummary.testSummary.apiContractFailures);
  const workspaceRows = trials.filter((item) => item.trial.toolSummary?.workspaceSummary);
  const architectureViolations = sum(workspaceRows, (item) => item.trial.toolSummary.workspaceSummary.architectureViolationCount);
  const unintendedFiles = sum(workspaceRows, (item) => item.trial.toolSummary.workspaceSummary.undeclaredWriteCount);
  const dangerousTrials = trials.filter((item) => typeof item.trial.toolSummary?.dangerousOperationBlocked === 'boolean');
  const dangerousBlocked = dangerousTrials.filter((item) => item.trial.toolSummary.dangerousOperationBlocked).length;
  const allAttempts = [
    ...attemptRows(executionRun, executionAttempts),
    ...attemptRows(canaryRun, canaryAttempts),
  ];
  const attemptsHaveHistory = executionAttempts.length > 0 && canaryAttempts.length > 0;
  const startedTrials = sum(allAttempts, (item) => item.summary.startedTrials);
  const readyTrials = sum(allAttempts, (item) => item.summary.readyTrials);
  const safetyFalsePositives = sum(allAttempts, (item) => item.summary.safetyFalsePositiveTrials);
  const legalWriteEligible = sum(allAttempts, (item) => item.summary.eligibleLegalWriteTrials);
  const legalWriteCollected = sum(allAttempts.filter((item) => Number.isInteger(item.summary.eligibleLegalWriteTrials)), (item) => item.summary.eligibleLegalWriteTrials);
  const recoverableTrials = trials.filter((item) => (item.trial.toolSummary?.recoverableToolErrorCount ?? 0) > 0);
  const recoveredTrials = recoverableTrials.filter((item) => item.trial.passed).length;
  const writeEligible = trials.filter((item) => (item.definition?.input?.fixture?.allowedWritePaths ?? []).length > 0);
  const writeCollected = writeEligible.filter((item) => item.trial.toolSummary?.workspaceSummary);
  const changedAllowed = sum(writeCollected, (item) => item.trial.toolSummary.workspaceSummary.allowedChangedCount);
  const changedTotal = sum(writeCollected, (item) => item.trial.toolSummary.workspaceSummary.totalChangedCount);
  const tokenUsage = aggregateTokens(trials);
  const durations = latency(trials);
  const ruleCoverage = aggregateRuleCoverage(trials);
  const skillTriggers = aggregateSkillTriggers(trials);
  const hookTimings = aggregateHookTimings(trials);
  const reworkMinutes = summaries.reduce((total, summary) => {
    if (summary.passAt1 === 1) return total;
    const definition = [executionSuite, canarySuite].flatMap((suite) => suite.cases ?? []).find((item) => item.id === summary.caseId);
    return total + (RISK_REWORK_MINUTES[definition?.risk] ?? 30);
  }, 0);
  const verificationRows = executionTrials.filter((item) => Number.isInteger(item.trial.toolSummary?.verificationCommandCount));
  const verificationTrials = verificationRows.filter((item) => item.trial.toolSummary.verificationCommandCount > 0).length;
  const unavailableBySuite = suites.map((suite) => {
    const rows = suite.trials.filter((item) => (item.definition?.reporting?.toolMetricMode ?? 'execute') !== 'exclude');
    const unavailable = rows.filter((item) => item.trial.toolSummary?.errorCategories?.includes('tool-unavailable')).length;
    return { eligible: rows.length, suiteId: suite.suiteId, unavailable };
  }).filter((item) => item.eligible > 0 && item.unavailable === item.eligible);
  const cases = suites.flatMap((suiteResult) => {
    const run = suiteResult.suiteId === executionRun.suite.id ? executionRun : canaryRun;
    return (run.trialSummaries ?? []).map((summary) => ({
      caseId: summary.caseId,
      meanScore: summary.meanScore,
      passAt1: summary.passAt1,
      passAtK: summary.passAtK,
      passCaretK: summary.passCaretK,
      passedTrials: summary.passedTrials,
      repetitions: summary.repetitions,
      suiteId: suiteResult.suiteId,
      tokens: sum(summary.perTrial ?? [], (trial) => trial.toolSummary?.tokenUsage?.totalTokens ?? trial.toolSummary?.totalTokens),
      trials: (summary.perTrial ?? []).map((trial) => ({
        errorCategories: trial.toolSummary?.errorCategories ?? [],
        failedAssertions: trial.failedAssertions ?? [],
        hookTimings: trial.toolSummary?.hookTimings ?? [],
        linearIssueReadCount: trial.toolSummary?.linearIssueReadCount ?? null,
        passed: trial.passed,
        repetition: trial.repetition,
        ruleCoverage: trial.toolSummary?.ruleCoverage ?? null,
        score: trial.score,
        skillTriggers: trial.toolSummary?.skillTriggers ?? [],
        testSummary: trial.toolSummary?.testSummary ?? null,
        timingMs: trial.toolSummary?.durationMs ?? null,
        tokenUsage: trial.toolSummary?.tokenUsage ?? null,
        toolOutcomeSummary: trial.toolSummary?.toolOutcomeSummary ?? null,
        verificationCount: trial.toolSummary?.verificationCommandCount ?? null,
        workspaceSummary: trial.toolSummary?.workspaceSummary ?? null,
      })),
    }));
  });
  const dataQuality = {
    attemptCoverage: attemptsHaveHistory ? 'value' : 'partial',
    missingAttemptHistory: !attemptsHaveHistory,
    missingNewFields: trials.filter((item) => !item.trial.toolSummary?.toolOutcomeSummary || !item.trial.toolSummary?.tokenUsage).length,
    referenceState: [executionRun, canaryRun].every((run) => run.reference?.status === 'matched') ? 'matched' : 'missing-or-mismatched',
    stabilityCoverage: measured(stableEligible.length, totalCases),
    unknownToolOutcomes: toolUnknown,
    toolClassificationAnomalies: unavailableBySuite,
  };
  return {
    cases,
    comparisons: {
      canary: assessRunComparison(canaryRun, canaryComparisonRun),
      execution: assessRunComparison(executionRun, executionComparisonRun),
    },
    dataQuality,
    generatedAt: new Date().toISOString(),
    metrics: {
      apiContractFailures: scalar(apiContractFailures, { collected: testRows.length, eligible: testEligible.length, state: testRows.length ? (testRows.length < testEligible.length ? 'partial' : 'value') : 'unavailable', total: trials.length }),
      architectureViolations: scalar(architectureViolations, { collected: workspaceRows.length, eligible: workspaceRows.length, state: workspaceRows.length ? 'value' : 'unavailable', total: trials.length }),
      changePrecision: measured(changedAllowed, changedTotal, { collected: writeCollected.length, eligible: writeEligible.length, state: writeCollected.length ? (writeCollected.length < writeEligible.length ? 'partial' : (changedTotal ? 'value' : 'na')) : 'unavailable', total: trials.length }),
      cachedInputRatio: measured(tokenUsage.cachedInputTokens, tokenUsage.inputTokens, { collected: tokenUsage.collected, eligible: trials.length, state: tokenUsage.collected ? (tokenUsage.inputTokens ? 'value' : 'na') : 'unavailable', total: trials.length }),
      dangerousBlockRate: measured(dangerousBlocked, dangerousTrials.length, { collected: dangerousTrials.length, eligible: dangerousTrials.length, state: dangerousTrials.length ? 'value' : 'unavailable', total: trials.length }),
      estimatedReworkMinutes: scalar(reworkMinutes, { collected: summaries.length, eligible: summaries.length, state: 'estimated', total: summaries.length }),
      firstPassRate: measured(firstPassCases, totalCases),
      hallucinatedApis: scalar(apiExistenceFailures, { collected: existenceCollected.length, eligible: existenceEligible.length, state: existenceCollected.length ? (existenceCollected.length < existenceEligible.length ? 'partial' : 'value') : 'unavailable', total: trials.length }),
      hookTimings,
      infrastructureHealthRate: measured(readyTrials, startedTrials, { collected: startedTrials, eligible: startedTrials, state: startedTrials ? (attemptsHaveHistory ? 'value' : 'partial') : 'unavailable', total: attemptsHaveHistory ? startedTrials : null }),
      latency: durations,
      recoveryRate: measured(recoveredTrials, recoverableTrials.length, { collected: trials.length, eligible: recoverableTrials.length, total: trials.length }),
      ruleCoverage,
      safetyFalsePositiveRate: measured(safetyFalsePositives, legalWriteEligible, { collected: legalWriteCollected, eligible: legalWriteEligible, state: legalWriteCollected ? (legalWriteEligible ? (attemptsHaveHistory ? 'value' : 'partial') : 'na') : 'unavailable', total: attemptsHaveHistory ? startedTrials : null }),
      skillTriggers,
      stablePassRate: measured(stableCases, stableEligible.length, { collected: stableEligible.length, eligible: stableEligible.length, state: stableEligible.length ? 'value' : 'na', total: totalCases }),
      taskCompletionRate: measured(completedCases, totalCases),
      testPassRate: measured(testsPassed, testsTotal, { collected: testRows.length, eligible: testEligible.length, state: testRows.length ? (testRows.length < testEligible.length ? 'partial' : (testsTotal ? 'value' : 'na')) : 'unavailable', total: trials.length }),
      tokenEfficiency: {
        bySuite: Object.fromEntries(suites.map((suite) => [suite.suiteId, {
          perCase: suite.completedCases ? round(suite.tokens.totalTokens / suite.completedCases, 2) : null,
          perTrial: suite.trialCount ? round(suite.tokens.totalTokens / suite.trialCount, 2) : null,
          total: suite.tokens.totalTokens,
        }])),
        perCompletedCase: completedCases ? round(tokenUsage.totalTokens / completedCases, 2) : null,
        perReadyTrial: trials.length ? round(tokenUsage.totalTokens / trials.length, 2) : null,
        state: tokenUsage.collected ? (tokenUsage.collected < trials.length ? 'partial' : 'value') : 'unavailable',
      },
      tokenUsage,
      toolEffectiveResultRate: measured(toolSuccessful + toolExpectedDenied, toolKnown, { collected: outcomeRows.length, eligible: toolEligible.length, state: outcomeRows.length ? (toolKnown ? (unavailableBySuite.length ? 'partial' : 'value') : 'na') : 'unavailable', total: trials.length }),
      toolExpectedDenied,
      toolUnexpectedFailed,
      toolUnknown,
      trialCompletionRate: measured(trials.filter((item) => item.trial.passed).length, trials.length),
      unintendedFiles: scalar(unintendedFiles, { collected: workspaceRows.length, eligible: workspaceRows.length, state: workspaceRows.length ? 'value' : 'unavailable', total: trials.length }),
      verificationRate: measured(verificationTrials, verificationRows.length, { collected: verificationRows.length, eligible: executionTrials.length, state: verificationRows.length ? 'value' : 'unavailable', total: executionTrials.length }),
    },
    runs: [executionRun, canaryRun].map((run) => ({
      agent: run.fingerprint.agent,
      campaignId: run.campaignId ?? null,
      generatedAt: run.generatedAt,
      model: run.fingerprint.model,
      proof: run.proof ?? 'legacy-unspecified',
      reference: run.reference?.status ?? 'missing',
      runtime: run.runtime ?? null,
      status: run.status,
      suiteId: run.suite.id,
      suiteVersion: run.suite.version,
    })),
    suites: suites.map(({ trials: ignored, ...suite }) => suite),
  };
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function displayState(metric) {
  return ({ estimated: '估算', na: '不适用', partial: '部分覆盖', unavailable: '未采集' })[metric?.state] ?? null;
}

function percent(metric) {
  const state = displayState(metric);
  if (metric?.value === null || metric?.value === undefined) return state ?? '未采集';
  return `${round(metric.value * 100, 1)}%${state ? ` · ${state}` : ''}`;
}

function number(metric, suffix = '') {
  const state = displayState(metric);
  if (metric?.value === null || metric?.value === undefined) return state ?? '未采集';
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(metric.value)}${suffix}${state ? ` · ${state}` : ''}`;
}

function coverage(metric) {
  if (!metric || metric.collected === undefined) return '';
  return `采集 ${metric.collected ?? '未知'} · 适用 ${metric.eligible ?? '未知'} · 总计 ${metric.total ?? '未知'}`;
}

function tone(metric, good) {
  if (!metric || ['estimated', 'na', 'partial', 'unavailable'].includes(metric.state)) return metric?.state ?? 'neutral';
  return good(metric.value) ? 'good' : 'bad';
}

function card(label, value, note, metric, cardTone = 'neutral') {
  return `<article class="metric ${cardTone}"><p>${escapeHtml(label)}</p><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small><span>${escapeHtml(coverage(metric))}</span></article>`;
}

function bar(value, max, label) {
  const width = max > 0 ? Math.max(2, round((value / max) * 100, 1)) : 0;
  return `<div class="bar" aria-label="${escapeHtml(label)}"><i style="width:${width}%"></i></div>`;
}

function trialDetails(item, maxDuration, maxTokens) {
  let trialIndex = 0;
  return item.trials.map((trial) => {
    const outcomes = trial.toolOutcomeSummary;
    const tests = trial.testSummary;
    const workspace = trial.workspaceSummary;
    const tokens = trial.tokenUsage?.totalTokens ?? 0;
    const duration = trial.timingMs ?? 0;
    const hookTimings = trial.hookTimings ?? [];
    const hookMs = hookTimings.length ? hookTimings.reduce((total, item) => total + (item.durationMs ?? 0), 0) : null;
    const rules = trial.ruleCoverage?.expected ?? [];
    const skills = (trial.skillTriggers ?? []).map((trigger) => trigger.id);
    return `<details class="trial"><summary><span>Trial ${trial.repetition}</span><b class="${trial.passed ? 'ok-text' : 'bad-text'}">${trial.passed ? '通过' : '失败'}</b><span>${duration ? `${round(duration / 1000, 1)}s` : '耗时未采集'}</span><span>${tokens ? `${new Intl.NumberFormat('zh-CN').format(tokens)} Token` : 'Token 未采集'}</span></summary>
      <div class="trial-grid">
        <div><h4>耗时</h4>${bar(duration, maxDuration, `${duration} ms`)}<p>${duration || '未采集'} ms</p></div>
        <div><h4>Token</h4>${bar(tokens, maxTokens, `${tokens} token`)}<p>${tokens || '未采集'}</p></div>
        <dl><dt>验证次数</dt><dd>${trial.verificationCount ?? '未采集'}</dd><dt>工具终态</dt><dd>${outcomes ? `成功 ${outcomes.successful ?? 0} / 预期拒绝 ${outcomes.expectedDenied ?? 0} / 意外失败 ${outcomes.unexpectedFailed ?? outcomes.failed ?? 0} / 未知 ${outcomes.unknown ?? 0}` : '未采集'}</dd><dt>隐藏测试</dt><dd>${tests ? `${tests.passed}/${tests.total}；API 存在性失败 ${tests.apiExistenceFailures ?? '未采集'}` : '不适用'}</dd><dt>Workspace</dt><dd>${workspace ? `允许变化 ${workspace.allowedChangedCount} / 未声明变化 ${workspace.undeclaredWriteCount}` : '未采集'}</dd><dt>错误类别</dt><dd>${trial.errorCategories.length ? trial.errorCategories.map(escapeHtml).join('、') : '无'}</dd><dt>Hook 耗时</dt><dd>${hookMs === null ? '未采集' : `${round(hookMs, 1)} ms · ${hookTimings.length} 次`}</dd><dt>声明规则</dt><dd>${rules.length ? rules.map(escapeHtml).join('、') : '未声明'}</dd><dt>声明技能</dt><dd>${skills.length ? skills.map(escapeHtml).join('、') : '未声明'}</dd></dl>
      </div></details>`;
  }).join('').replaceAll('<dt>验证次数</dt>', () => {
    const trial = item.trials[trialIndex++];
    const reads = trial.linearIssueReadCount ?? '未采集';
    return '<dt>Linear Issue 读取</dt><dd>' + reads + '</dd><dt>验证次数</dt>';
  });
}

function suitePanel(model, suiteId) {
  const items = model.cases.filter((item) => item.suiteId === suiteId);
  const maxDuration = Math.max(0, ...items.flatMap((item) => item.trials.map((trial) => trial.timingMs ?? 0)));
  const maxTokens = Math.max(0, ...items.flatMap((item) => item.trials.map((trial) => trial.tokenUsage?.totalTokens ?? 0)));
  return items.map((item) => `<section class="case"><header><div><h3>${escapeHtml(item.caseId)}</h3><p>首轮 ${item.passAt1 ? '通过' : '失败'} · 至少一次 ${item.passAtK ? '通过' : '失败'} · ${item.repetitions > 1 ? `稳定 ${item.passCaretK ? '通过' : '有波动'}` : '稳定性不适用'}</p></div><strong>${item.passedTrials}/${item.repetitions}</strong></header>${trialDetails(item, maxDuration, maxTokens)}</section>`).join('');
}

export function renderEvalReport(model) {
  const m = model.metrics;
  const allPassed = model.runs.every((run) => run.status === 'passed');
  const referenceReady = model.dataQuality.referenceState === 'matched';
  const qualityPartial = model.dataQuality.attemptCoverage === 'partial'
    || model.dataQuality.missingNewFields > 0
    || model.dataQuality.toolClassificationAnomalies.length > 0;
  const decisionCards = [
    card('任务完成率', percent(m.taskCompletionRate), 'case 级 pass@k：至少一次完成', m.taskCompletionRate, tone(m.taskCompletionRate, (v) => v === 1)),
    card('Trial 完成率', percent(m.trialCompletionRate), 'ready trial 中实际通过', m.trialCompletionRate, tone(m.trialCompletionRate, (v) => v === 1)),
    card('首次通过率', percent(m.firstPassRate), 'case 级 pass@1', m.firstPassRate, tone(m.firstPassRate, (v) => v === 1)),
    card('稳定通过率', percent(m.stablePassRate), `仅多轮 case；覆盖 ${m.stablePassRate.eligible}/${m.stablePassRate.total}`, m.stablePassRate, tone(m.stablePassRate, (v) => v === 1)),
    card('测试通过率', percent(m.testPassRate), '隐藏行为与 API 测试', m.testPassRate, tone(m.testPassRate, (v) => v === 1)),
    card('基础设施健康率', percent(m.infrastructureHealthRate), '同 campaign ready / started', m.infrastructureHealthRate, tone(m.infrastructureHealthRate, (v) => v === 1)),
  ].join('');
  const groups = [
    ['交付质量', [
      card('架构/边界违规事件', number(m.architectureViolations), '事件数，不等同文件数', m.architectureViolations, tone(m.architectureViolations, (v) => v === 0)),
      card('误修改文件数', number(m.unintendedFiles), '允许路径之外的变化文件', m.unintendedFiles, tone(m.unintendedFiles, (v) => v === 0)),
      card('虚构 API 数', number(m.hallucinatedApis), '仅 api-existence 失败', m.hallucinatedApis, tone(m.hallucinatedApis, (v) => v === 0)),
      card('API 契约失败', number(m.apiContractFailures), '包含契约与存在性诊断', m.apiContractFailures, tone(m.apiContractFailures, (v) => v === 0)),
      card('模型首轮失败返工估算', `${m.estimatedReworkMinutes.value} 分钟`, '不含基础设施故障；风险权重估算', m.estimatedReworkMinutes, 'estimated'),
    ]],
    ['安全与变更', [
      card('危险操作拦截率', percent(m.dangerousBlockRate), '受保护目标状态保持不变', m.dangerousBlockRate, tone(m.dangerousBlockRate, (v) => v === 1)),
      card('安全误拦截率', percent(m.safetyFalsePositiveRate), '合法写入 eligible trial 为分母', m.safetyFalsePositiveRate, tone(m.safetyFalsePositiveRate, (v) => v === 0)),
      card('变更精确率', percent(m.changePrecision), '允许变化文件 / 全部变化文件', m.changePrecision, tone(m.changePrecision, (v) => v === 1)),
    ]],
    ['效率', [
      card('Trial 平均耗时', m.latency.state === 'unavailable' ? '未采集' : `${round(m.latency.averageMs / 1000, 1)} 秒`, m.latency.state === 'unavailable' ? 'runner timing' : `P50 ${round(m.latency.p50Ms / 1000, 1)}s · P95 ${round(m.latency.p95Ms / 1000, 1)}s · 最慢 ${m.latency.slowestCase}`, m.latency, m.latency.state),
      card('Token / ready trial', m.tokenEfficiency.state === 'unavailable' ? '未采集' : new Intl.NumberFormat('zh-CN').format(m.tokenEfficiency.perReadyTrial), '按试次归一化', m.tokenUsage, m.tokenEfficiency.state),
      card('Token / 完成 case', m.tokenEfficiency.state === 'unavailable' ? '未采集' : new Intl.NumberFormat('zh-CN').format(m.tokenEfficiency.perCompletedCase), '按完成 case 归一化', m.tokenUsage, m.tokenEfficiency.state),
      card('缓存输入比例', percent(m.cachedInputRatio), 'cached input / input', m.cachedInputRatio, m.cachedInputRatio.state),
      card('验证执行率', percent(m.verificationRate), 'Execution trial 主动验证', m.verificationRate, m.verificationRate.state),
    ]],
    ['治理覆盖', [
      card('规则覆盖通过率', percent(m.ruleCoverage), `声明规则 ${m.ruleCoverage.uniqueRules} 种 · 覆盖 ${m.ruleCoverage.totalDeclared} case 次`, m.ruleCoverage, m.ruleCoverage.state === 'unavailable' ? 'unavailable' : 'neutral'),
      card('技能覆盖通过率', percent(m.skillTriggers), `声明技能 ${m.skillTriggers.uniqueSkills} 种 · 覆盖 ${m.skillTriggers.totalDeclared} case 次`, m.skillTriggers, m.skillTriggers.state === 'unavailable' ? 'unavailable' : 'neutral'),
      card('Hook 平均耗时', m.hookTimings.state === 'unavailable' ? '未采集' : `${round(m.hookTimings.averageMs, 1)} ms`, m.hookTimings.state === 'unavailable' ? '策略标记未采集' : `P50 ${m.hookTimings.p50Ms ?? '—'} ms · P95 ${m.hookTimings.p95Ms ?? '—'} ms · ${m.hookTimings.totalInvocations} 次 · 最慢 reasonCode ${m.hookTimings.byReasonCode[0]?.reasonCode ?? '—'}`, m.hookTimings, m.hookTimings.state === 'unavailable' ? 'unavailable' : 'neutral'),
    ]],
    ['工具与基础设施', [
      card('工具有效结果率', percent(m.toolEffectiveResultRate), `预期拒绝 ${m.toolExpectedDenied} · 意外失败 ${m.toolUnexpectedFailed} · 未知 ${m.toolUnknown}`, m.toolEffectiveResultRate, tone(m.toolEffectiveResultRate, (v) => v === 1)),
      card('错误恢复率', percent(m.recoveryRate), '可恢复工具错误后最终通过', m.recoveryRate, m.recoveryRate.state),
      card('Token 总消耗', new Intl.NumberFormat('zh-CN').format(m.tokenUsage.totalTokens), `input ${new Intl.NumberFormat('zh-CN').format(m.tokenUsage.inputTokens)} · cached ${new Intl.NumberFormat('zh-CN').format(m.tokenUsage.cachedInputTokens)} · output ${new Intl.NumberFormat('zh-CN').format(m.tokenUsage.outputTokens)}`, m.tokenUsage, m.tokenUsage.collected < m.tokenUsage.total ? 'partial' : 'neutral'),
    ]],
  ].map(([title, cards]) => `<section class="metric-group"><h3>${title}</h3><div class="metrics">${cards.join('')}</div></section>`).join('');
  const qualityCards = [
    card('稳定性覆盖', `${m.stablePassRate.eligible}/${m.stablePassRate.total} cases`, '只对 repetitions > 1 评价稳定性', m.stablePassRate, m.stablePassRate.eligible === m.stablePassRate.total ? 'good' : 'partial'),
    card('未知工具终态', String(m.toolUnknown), '不进入有效结果率分母', m.toolEffectiveResultRate, m.toolUnknown === 0 ? 'good' : 'warn'),
    card('Attempt 历史', model.dataQuality.missingAttemptHistory ? '部分覆盖' : '已纳入', model.dataQuality.missingAttemptHistory ? '未为两套 suite 提供完整 attempt 历史，不能排除选择偏差' : '已汇总命令行提供的同 campaign attempt', m.infrastructureHealthRate, model.dataQuality.missingAttemptHistory ? 'partial' : 'good'),
    card('工具分类异常', model.dataQuality.toolClassificationAnomalies.length ? `${model.dataQuality.toolClassificationAnomalies.reduce((total, item) => total + item.unavailable, 0)} trial` : '未发现', model.dataQuality.toolClassificationAnomalies.length ? model.dataQuality.toolClassificationAnomalies.map((item) => `${item.suiteId} ${item.unavailable}/${item.eligible}`).join('；') : '未出现 suite 内全 trial tool-unavailable', m.toolEffectiveResultRate, model.dataQuality.toolClassificationAnomalies.length ? 'partial' : 'good'),
    card('Reference', referenceReady ? '已匹配' : '未建立 / 不匹配', 'Reference 只读，本报告未更新', null, referenceReady ? 'good' : 'partial'),
    card('新字段缺失 trial', String(model.dataQuality.missingNewFields), '旧 run 仍可读，缺失项显示未采集', null, model.dataQuality.missingNewFields === 0 ? 'good' : 'partial'),
    card('历史对比', model.comparisons.execution.compatible && model.comparisons.canary.compatible ? '可比较' : '未计算趋势', `${model.comparisons.execution.reason}；${model.comparisons.canary.reason}`, null, model.comparisons.execution.compatible && model.comparisons.canary.compatible ? 'good' : 'neutral'),
  ].join('');
  const methods = [
    ['任务完成率', 'passAtK=1 case / 全部 case；表示至少一次完成'], ['Trial 完成率', '通过的 ready trial / 全部 ready trial'], ['首次通过率', 'passAt1=1 case / 全部 case'], ['稳定通过率', '仅 repetitions>1 case 中 passCaretK=1 / eligible case'], ['工具有效结果率', '(成功 + 符合预期的拒绝) / 已知有效终态'], ['Token 效率', '分别按 ready trial、完成 case 和 suite 归一化'], ['基础设施健康率', '同 campaign 的 ready trial / started trial；缺 attempt 历史时为部分覆盖'], ['虚构 API 数', '仅 diagnosticCategory=api-existence 的失败'], ['安全误拦截率', '合法写入被基础设施阻止 / eligibleLegalWriteTrials'], ['人工返工时间', '模型首轮失败按 low/medium/high/critical = 15/30/45/60 分钟估算，不含基础设施故障'], ['规则覆盖通过率', 'case 声明 reporting.expected.rules 的通过 case 次 / 声明 case 次；借鉴 NeMo Guardrails activated_rails 模型'], ['技能覆盖通过率', 'case 声明 reporting.expected.skills 的通过 case 次 / 声明 case 次'], ['Hook 耗时', '[VIBE_HARNESS_POLICY:CODE:ms] 标记解析的 hook 执行耗时；借鉴 OTel gen_ai.execute_tool.duration 的 p50/p95 报告'],
  ].map(([name, definition]) => `<tr><th scope="row">${name}</th><td>${definition}</td></tr>`).join('');
  const provenance = model.runs.map((run) => `<li><strong>${escapeHtml(run.suiteId)} ${escapeHtml(run.suiteVersion)}</strong><span>${escapeHtml(run.model)} · ${escapeHtml(run.agent)} · ${escapeHtml(run.runtime?.backend ?? 'backend 未采集')} · campaign ${escapeHtml(run.campaignId ?? '未采集')}</span></li>`).join('');
  const data = JSON.stringify({ generatedAt: model.generatedAt, metrics: model.metrics }).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Vibe-Harness Online Eval 决策报告</title><style>
:root{color-scheme:light;--ink:#18211d;--muted:#65716b;--line:#d7dfdb;--paper:#fff;--band:#f5f7f6;--good:#147a4b;--warn:#8a5a00;--bad:#b42318;--accent:#1769aa;--partial:#7357a0}*{box-sizing:border-box}body{margin:0;color:var(--ink);font:14px/1.45 Inter,"Segoe UI","Microsoft YaHei",sans-serif;letter-spacing:0;background:#fff}button{font:inherit}.top{padding:28px max(20px,calc((100vw - 1240px)/2));background:#202925;color:#fff}.top h1{margin:0 0 8px;font-size:28px}.top p{margin:0;color:#cbd4d0}.evidence{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.badge{padding:5px 8px;border:1px solid #64736c;border-radius:4px}.badge.good{background:#195e3f}.badge.partial{background:#594476}.toolbar{position:sticky;top:0;z-index:3;display:flex;gap:8px;padding:10px max(20px,calc((100vw - 1240px)/2));border-bottom:1px solid var(--line);background:#fff}.tabs{display:flex;gap:4px;overflow:auto}.tabs button,.print{min-height:36px;padding:7px 12px;white-space:nowrap;border:1px solid var(--line);border-radius:4px;background:#fff;color:var(--ink);cursor:pointer}.tabs button[aria-selected=true]{border-color:#80afd1;background:#e8f1f8;color:#0c568d}.tabs button:focus-visible,.print:focus-visible,summary:focus-visible{outline:3px solid #84bcea;outline-offset:2px}.print{margin-left:auto}.panel{display:none}.panel.active{display:block}.band{padding:26px max(20px,calc((100vw - 1240px)/2))}.band.alt{border-block:1px solid var(--line);background:var(--band)}h2{margin:0 0 16px;font-size:19px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.metric-group{margin-top:24px}.metric-group h3{margin:0 0 10px;font-size:15px}.metric{min-height:132px;padding:14px;border:1px solid var(--line);border-left:4px solid #93a099;border-radius:6px;background:#fff}.metric.good{border-left-color:var(--good)}.metric.bad{border-left-color:var(--bad)}.metric.warn,.metric.estimated{border-left-color:var(--warn)}.metric.partial{border-left-color:var(--partial);background:#fbf9ff}.metric.unavailable,.metric.na{border-left-color:#9aa29e;background:#f7f8f7}.metric p{margin:0 0 12px;color:var(--muted)}.metric strong{display:block;font-size:24px;overflow-wrap:anywhere}.metric small,.metric span{display:block;margin-top:8px;color:var(--muted)}.metric span{font-size:11px}.case{margin:0 0 16px;border-top:3px solid var(--accent)}.case>header{display:flex;align-items:start;justify-content:space-between;padding:14px 0}.case h3,.case p{margin:0}.case p{margin-top:4px;color:var(--muted)}.case>header>strong{font-size:20px}.trial{border-top:1px solid var(--line)}.trial summary{display:grid;grid-template-columns:100px 80px 1fr 1fr;gap:12px;padding:12px 4px;cursor:pointer}.trial-grid{display:grid;grid-template-columns:1fr 1fr 2fr;gap:16px;padding:6px 4px 18px}.trial-grid h4,.trial-grid p{margin:0 0 8px}.trial-grid dl{display:grid;grid-template-columns:100px 1fr;margin:0}.trial-grid dt,.trial-grid dd{margin:0;padding:5px;border-bottom:1px solid var(--line)}.trial-grid dt{color:var(--muted)}.bar{height:9px;overflow:hidden;border-radius:3px;background:#e5ebe8}.bar i{display:block;height:100%;background:var(--accent)}.ok-text{color:var(--good)}.bad-text{color:var(--bad)}.table-wrap{overflow:auto}.methods{width:100%;border-collapse:collapse}.methods th,.methods td{padding:10px;border-bottom:1px solid var(--line);text-align:left}.methods th{width:220px}.provenance{list-style:none;margin:0;padding:0}.provenance li{display:flex;justify-content:space-between;gap:20px;padding:10px 0;border-bottom:1px solid var(--line)}.provenance span{color:var(--muted);text-align:right}footer{padding:24px max(20px,calc((100vw - 1240px)/2));color:var(--muted)}@media(max-width:850px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.trial-grid{grid-template-columns:1fr}.trial summary{grid-template-columns:80px 70px 1fr}}@media(max-width:560px){.top,.toolbar,.band,footer{padding-left:16px;padding-right:16px}.top h1{font-size:23px}.metrics{grid-template-columns:1fr}.metric{min-height:112px}.print{display:none}.trial summary{grid-template-columns:1fr 1fr}.trial summary span:nth-child(3),.trial summary span:nth-child(4){text-align:right}.provenance li{display:block}.provenance span{display:block;text-align:left}}@media print{.toolbar{display:none}.panel{display:block!important}.metric,.case,.trial{break-inside:avoid}.top{background:#fff;color:#000;border-bottom:2px solid #000}.top p{color:#333}}
</style></head><body><header class="top"><h1>Vibe-Harness Online Eval 决策报告</h1><p>发布结论、证据状态与工程诊断分层展示。效率和趋势指标仅用于诊断，不形成隐式门禁。</p><div class="evidence"><span class="badge ${allPassed ? 'good' : 'bad'}">本次运行：${allPassed ? '通过' : '未通过'}</span><span class="badge ${referenceReady ? 'good' : 'partial'}">Reference：${referenceReady ? '已匹配' : '未建立 / 不匹配'}</span><span class="badge ${qualityPartial ? 'partial' : 'good'}">数据质量：${qualityPartial ? '部分可信' : '完整'}</span></div></header>
<nav class="toolbar" aria-label="报告视图"><div class="tabs" role="tablist"><button role="tab" aria-selected="true" data-panel="summary">决策摘要</button><button role="tab" aria-selected="false" data-panel="execution">Execution</button><button role="tab" aria-selected="false" data-panel="canary">Canary</button><button role="tab" aria-selected="false" data-panel="quality">数据质量</button><button role="tab" aria-selected="false" data-panel="methods">指标方法</button></div><button class="print" type="button">打印</button></nav>
<main><section id="summary" class="panel active"><div class="band"><h2>6 个决策 KPI</h2><div class="metrics">${decisionCards}</div></div><div class="band alt"><h2>工程诊断</h2>${groups}</div></section><section id="execution" class="panel"><div class="band"><h2>Execution trial 明细</h2>${suitePanel(model, 'vibe-harness-online-execution')}</div></section><section id="canary" class="panel"><div class="band"><h2>Canary trial 明细</h2>${suitePanel(model, 'vibe-harness-online-canary')}</div></section><section id="quality" class="panel"><div class="band"><h2>数据质量与证据覆盖</h2><div class="metrics">${qualityCards}</div></div><div class="band alt"><h2>运行来源</h2><ul class="provenance">${provenance}</ul></div></section><section id="methods" class="panel"><div class="band"><h2>指标口径</h2><div class="table-wrap"><table class="methods"><tbody>${methods}</tbody></table></div></div></section></main><footer>生成时间 ${escapeHtml(model.generatedAt)} · 自包含离线报告 · 仅含脱敏聚合诊断</footer><script type="application/json" id="report-data">${data}</script><script>
const tabs=[...document.querySelectorAll('[role=tab]')];const panels=[...document.querySelectorAll('.panel')];function activate(tab){for(const item of tabs){const on=item===tab;item.setAttribute('aria-selected',String(on));item.tabIndex=on?0:-1}for(const panel of panels)panel.classList.toggle('active',panel.id===tab.dataset.panel)}for(const tab of tabs){tab.addEventListener('click',()=>activate(tab));tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const offset=event.key==='ArrowRight'?1:-1;const next=tabs[(tabs.indexOf(tab)+offset+tabs.length)%tabs.length];activate(next);next.focus()})}document.querySelector('.print').addEventListener('click',()=>window.print());
</script></body></html>`;
}
