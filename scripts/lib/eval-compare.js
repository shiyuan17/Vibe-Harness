function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function portfolio(run) {
  return JSON.stringify((run.caseRepetitions ?? []).map((item) => [item.id, item.count]).sort());
}

function fingerprint(run) {
  return JSON.stringify({
    provider: run.runtime?.provider,
    model: run.fingerprint?.model,
    cli: run.fingerprint?.agent,
    reasoning: run.runtime?.reasoningEffort,
    suiteId: run.suite?.id,
    suiteVersion: run.suite?.version,
    portfolio: portfolio(run),
  });
}

function validDays(runs) {
  return new Set(runs.map((run) => String(run.generatedAt).slice(0, 10))).size;
}

function trials(runs) {
  return runs.flatMap((run) => (run.trialSummaries ?? []).flatMap((summary) => summary.perTrial ?? []));
}

function rate(values) {
  return values.length === 0 ? null : round(values.filter(Boolean).length / values.length);
}

function average(values) {
  return values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function totalOrUnavailable(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function windowMetrics(runs) {
  const perTrial = trials(runs);
  const episodes = perTrial.map((trial) => trial.toolSummary?.taskEpisode).filter(Boolean);
  const episodesAvailable = episodes.length > 0;
  const dangerousWrites = perTrial.flatMap((trial) => {
    const summary = trial.toolSummary?.workspaceSummary;
    return summary ? [(summary.architectureViolationCount ?? 0) + (summary.undeclaredWriteCount ?? 0)] : [];
  });
  const unexpectedFailures = perTrial.flatMap((trial) => {
    const value = trial.toolSummary?.toolOutcomeSummary?.unexpectedFailed;
    return Number.isFinite(value) ? [value] : [];
  });
  return {
    primary: {
      ownerObservedRate: episodesAvailable ? rate(episodes.map((episode) => episode.owner.evidenceState === 'observed')) : null,
      verifiedHandoffRate: episodesAvailable ? rate(episodes.map((episode) => episode.stopBoundary === 'verified-handoff')) : null,
    },
    guardrails: {
      criticalPassRate: average(runs.map((run) => run.criticalPassRate).filter(Number.isFinite)),
      dangerousWrites: totalOrUnavailable(dangerousWrites),
      unexpectedFailures: totalOrUnavailable(unexpectedFailures),
      degradedRuns: runs.filter((run) => run.status === 'degraded').length,
    },
    advisory: {
      meanTokens: average(perTrial.map((trial) => trial.toolSummary?.tokenUsage?.totalTokens).filter(Number.isFinite)),
      meanDurationMs: average(perTrial.map((trial) => trial.toolSummary?.durationMs).filter(Number.isFinite)),
    },
  };
}

function pair(metric, baseline, candidate) {
  return { baseline: baseline[metric], candidate: candidate[metric] };
}

export function compareEvalWindows({ baselineRuns = [], candidateRuns = [] }) {
  const baseline = windowMetrics(baselineRuns);
  const candidate = windowMetrics(candidateRuns);
  const reasons = [];
  if (validDays(baselineRuns) < 7 || validDays(candidateRuns) < 7) reasons.push('fewer-than-seven-valid-days');
  const allRuns = [...baselineRuns, ...candidateRuns];
  if (allRuns.some((run) => run.status === 'degraded')) reasons.push('degraded-run');
  if (new Set(allRuns.map(fingerprint)).size > 1) reasons.push('fingerprint-or-portfolio-mismatch');
  if ([baseline.primary.ownerObservedRate, baseline.primary.verifiedHandoffRate,
    candidate.primary.ownerObservedRate, candidate.primary.verifiedHandoffRate].some((value) => value === null)) {
    reasons.push('task-episode-unavailable');
  }
  if ([baseline.guardrails.criticalPassRate, baseline.guardrails.dangerousWrites,
    baseline.guardrails.unexpectedFailures, candidate.guardrails.criticalPassRate,
    candidate.guardrails.dangerousWrites, candidate.guardrails.unexpectedFailures].some((value) => value === null)) {
    reasons.push('guardrail-unavailable');
  }
  const primary = {
    ownerObservedRate: pair('ownerObservedRate', baseline.primary, candidate.primary),
    verifiedHandoffRate: pair('verifiedHandoffRate', baseline.primary, candidate.primary),
  };
  const guardrails = {
    criticalPassRate: pair('criticalPassRate', baseline.guardrails, candidate.guardrails),
    dangerousWrites: pair('dangerousWrites', baseline.guardrails, candidate.guardrails),
    unexpectedFailures: pair('unexpectedFailures', baseline.guardrails, candidate.guardrails),
    degradedRuns: pair('degradedRuns', baseline.guardrails, candidate.guardrails),
  };
  const advisory = {
    meanTokens: pair('meanTokens', baseline.advisory, candidate.advisory),
    meanDurationMs: pair('meanDurationMs', baseline.advisory, candidate.advisory),
  };
  if (reasons.length > 0) return { status: 'insufficient-evidence', conclusion: 'unavailable', reasons, primary, guardrails, advisory };
  const guardrailRegression = candidate.guardrails.criticalPassRate < baseline.guardrails.criticalPassRate
    || candidate.guardrails.dangerousWrites > baseline.guardrails.dangerousWrites
    || candidate.guardrails.unexpectedFailures > baseline.guardrails.unexpectedFailures;
  const improved = candidate.primary.ownerObservedRate > baseline.primary.ownerObservedRate
    || candidate.primary.verifiedHandoffRate > baseline.primary.verifiedHandoffRate;
  return {
    status: 'comparable',
    conclusion: guardrailRegression ? 'regressed' : improved ? 'improved' : 'no-material-change',
    reasons: [], primary, guardrails, advisory,
  };
}
