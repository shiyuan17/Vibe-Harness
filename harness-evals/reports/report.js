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
  const statuses = Object.fromEntries(['passed', 'failed', 'blocked', 'partial'].map((status) => [
    status,
    results.filter((result) => result.status === status).length,
  ]));
  const failureModes = [...new Set(results.flatMap((result) => (result.failures ?? []).map((failure) =>
    `${failure.taxonomy ?? 'Unknown Failure'}:${failure.code ?? 'unknown'}`)))].sort();
  return redactTraceValue({ schemaVersion: 1, title, generatedAt, statuses, results, comparison, failureModes });
}

export function renderMarkdownReport(report) {
  const lines = [
    `# ${report.title}`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Results: ${report.results.length}; passed ${report.statuses.passed}; failed ${report.statuses.failed}; blocked ${report.statuses.blocked}; partial ${report.statuses.partial}.`,
    '',
    '| Scenario | Source | Status | Task success | Workflow compliance | Tokens | Wall time |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const result of report.results) {
    const tokenMetric = result.metrics?.efficiency?.tokenUsage;
    const wallMetric = result.metrics?.efficiency?.wallTime;
    lines.push(`| ${result.scenario.id} | ${result.source.kind}${result.source.benchmark ? `/${result.source.benchmark}` : ''} | ${result.status} | ${ratio(result.metrics?.outcome?.taskSuccessRate)} | ${ratio(result.metrics?.workflow?.workflowCompliance)} | ${tokenMetric?.value ?? 'unavailable'} | ${wallMetric?.value ?? 'unavailable'} |`);
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
  return `${lines.join('\n')}\n`;
}

export function renderHtmlReport(report) {
  const rows = report.results.map((result) => `<tr><td>${escapeHtml(result.scenario.id)}</td><td>${escapeHtml(result.source.kind)}</td><td>${escapeHtml(result.status)}</td><td>${escapeHtml(ratio(result.metrics?.outcome?.taskSuccessRate))}</td></tr>`).join('');
  const failures = report.failureModes.map((item) => `<li>${escapeHtml(item)}</li>`).join('') || '<li>None observed.</li>';
  const conclusion = report.comparison?.conclusion ?? 'unavailable';
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(report.title)}</title></head><body><main><h1>${escapeHtml(report.title)}</h1><p>Generated: ${escapeHtml(report.generatedAt)}</p><table><thead><tr><th>Scenario</th><th>Source</th><th>Status</th><th>Task success</th></tr></thead><tbody>${rows}</tbody></table><h2>Regression</h2><p>${escapeHtml(conclusion)}</p><h2>Failure modes</h2><ul>${failures}</ul></main></body></html>\n`;
}
