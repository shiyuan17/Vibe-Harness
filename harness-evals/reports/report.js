import { redactTraceValue } from '../traces/atif.js';

function ratio(metric) {
  if (!metric || metric.value === null) return 'unavailable';
  return `${(metric.value * 100).toFixed(1)}% (${metric.numerator}/${metric.denominator})`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildReport({ title = 'Harness Eval Report', results = [], comparison = null, generatedAt = new Date().toISOString() } = {}) {
  const statuses = Object.fromEntries(['passed', 'failed', 'blocked', 'partial', 'not-reproduced'].map((status) => [
    status,
    results.filter((result) => result.status === status).length,
  ]));
  const failureModes = [...new Set(results.flatMap((result) => (result.failures ?? []).map((failure) =>
    `${failure.taxonomy ?? 'Unknown Failure'}:${failure.code ?? 'unknown'}`)))].sort();
  return redactTraceValue({
    schemaVersion: 1,
    title,
    generatedAt,
    statuses,
    results,
    comparison,
    failureModes,
    diagnostics: results.map((result) => diagnosticsFor(result)),
  });
}

// One row per scenario. A dimension the analyzer could not measure stays
// `unavailable`/`unverified`; it is never rendered as a zero count or a pass.
function diagnosticsFor(result) {
  const diagnostics = result.analysis?.diagnostics ?? null;
  const firstDeviation = diagnostics?.firstDeviation ?? { state: 'unavailable' };
  const counts = diagnostics?.evidenceSources?.counts ?? null;
  return {
    scenarioId: result.scenario?.id ?? 'unknown',
    status: result.status ?? 'unknown',
    firstDeviation: firstDeviation.state === 'observed'
      ? `step ${firstDeviation.stepId ?? 'unknown'} at event ${firstDeviation.eventIndex ?? 'unknown'} (${firstDeviation.source}${firstDeviation.checkId ? `:${firstDeviation.checkId}` : ''})`
      : 'unavailable',
    evidenceSources: counts
      ? `tool-result ${counts['tool-result']}; tool-call ${counts['tool-call']}; agent-claim ${counts['agent-claim']}; unknown ${counts.unknown}`
      : 'unavailable',
    ruleLoads: describeDimension(diagnostics?.ruleLoads, (item) => `step ${item.stepId}`),
    repeatedReads: describeDimension(diagnostics?.repeatedReads, (item) => `${item.target} x${item.stepIds.length}`),
    toolFailures: describeDimension(diagnostics?.toolFailures, (item) => `step ${item.stepId} ${item.kind}`),
    waits: describeDimension(diagnostics?.waits, (item) => `step ${item.stepId} ${item.kind}`),
    verificationGaps: describeDimension(diagnostics?.verificationGaps, (item) => item.code),
  };
}

function describeDimension(dimension, describe) {
  if (!dimension || dimension.state === 'unavailable') return 'unavailable';
  if (dimension.items.length === 0) return 'none observed';
  const rendered = dimension.items.slice(0, 5).map(describe).join(', ');
  return dimension.items.length > 5 ? `${rendered}, +${dimension.items.length - 5} more` : rendered;
}

export function renderMarkdownReport(report) {
  const lines = [
    `# ${report.title}`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Results: ${report.results.length}; passed ${report.statuses.passed}; failed ${report.statuses.failed}; blocked ${report.statuses.blocked}; partial ${report.statuses.partial}; RED not reproduced ${report.statuses['not-reproduced']}.`,
    '',
    '| Scenario | Source | Status | Task success | Workflow compliance | Tokens | Cache hit | Cost units | Wall time |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const result of report.results) {
    const tokenMetric = result.metrics?.efficiency?.tokenUsage;
    const billing = result.metrics?.efficiency?.tokenBilling;
    const wallMetric = result.metrics?.efficiency?.wallTime;
    lines.push(`| ${result.scenario.id} | ${result.source.kind}${result.source.benchmark ? `/${result.source.benchmark}` : ''} | ${result.status} | ${ratio(result.metrics?.outcome?.taskSuccessRate)} | ${ratio(result.metrics?.workflow?.workflowCompliance)} | ${tokenMetric?.value ?? 'unavailable'} | ${ratio(billing?.cacheHitRate)} | ${billing?.costUnits?.value ?? 'unavailable'} | ${wallMetric?.value ?? 'unavailable'} |`);
  }
  lines.push('', '## Regression', '');
  if (!report.comparison) lines.push('No comparable baseline was supplied.');
  else lines.push(
    `Conclusion: ${report.comparison.conclusion}.`,
    '',
    `Improved: ${(report.comparison.improvements ?? []).join(', ') || 'none'}.`,
    '',
    `Regressed: ${(report.comparison.regressions ?? []).join(', ') || 'none'}.`,
    '',
    `Equivalent: ${(report.comparison.equivalent ?? []).join(', ') || 'none'}.`,
    '',
    `Insufficient evidence: ${(report.comparison.insufficientEvidence ?? []).join(', ') || 'none'}.`,
  );
  lines.push('', '## Failure modes', '');
  if (report.failureModes.length === 0) lines.push('None observed.');
  else lines.push(...report.failureModes.map((item) => `- ${item}`));
  lines.push('', '## Diagnostics', '', '| Scenario | Status | First deviation | Evidence sources | Rule loads | Repeated reads | Tool failures | Waits | Verification gaps |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of report.diagnostics ?? []) {
    lines.push(`| ${row.scenarioId} | ${row.status} | ${row.firstDeviation} | ${row.evidenceSources} | ${row.ruleLoads} | ${row.repeatedReads} | ${row.toolFailures} | ${row.waits} | ${row.verificationGaps} |`);
  }
  if ((report.diagnostics ?? []).length === 0) lines.push('No scenario carried an analysis object; every dimension is unavailable.');
  return `${lines.join('\n')}\n`;
}

export function renderHtmlReport(report) {
  const rows = report.results.map((result) => `<tr><td>${escapeHtml(result.scenario.id)}</td><td>${escapeHtml(result.source.kind)}</td><td>${escapeHtml(result.status)}</td><td>${escapeHtml(ratio(result.metrics?.outcome?.taskSuccessRate))}</td></tr>`).join('');
  const failures = report.failureModes.map((item) => `<li>${escapeHtml(item)}</li>`).join('') || '<li>None observed.</li>';
  const conclusion = report.comparison?.conclusion ?? 'unavailable';
  const diagnostics = (report.diagnostics ?? []).map((row) => `<tr><td>${escapeHtml(row.scenarioId)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.firstDeviation)}</td><td>${escapeHtml(row.evidenceSources)}</td><td>${escapeHtml(row.ruleLoads)}</td><td>${escapeHtml(row.repeatedReads)}</td><td>${escapeHtml(row.toolFailures)}</td><td>${escapeHtml(row.waits)}</td><td>${escapeHtml(row.verificationGaps)}</td></tr>`).join('')
    || '<tr><td colspan="9">No scenario carried an analysis object; every dimension is unavailable.</td></tr>';
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(report.title)}</title></head><body><main><h1>${escapeHtml(report.title)}</h1><p>Generated: ${escapeHtml(report.generatedAt)}</p><table><thead><tr><th>Scenario</th><th>Source</th><th>Status</th><th>Task success</th></tr></thead><tbody>${rows}</tbody></table><h2>Regression</h2><p>${escapeHtml(conclusion)}</p><h2>Failure modes</h2><ul>${failures}</ul><h2>Diagnostics</h2><table><thead><tr><th>Scenario</th><th>Status</th><th>First deviation</th><th>Evidence sources</th><th>Rule loads</th><th>Repeated reads</th><th>Tool failures</th><th>Waits</th><th>Verification gaps</th></tr></thead><tbody>${diagnostics}</tbody></table></main></body></html>\n`;
}
