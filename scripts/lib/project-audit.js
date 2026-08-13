import path from 'node:path';

import { auditImprovements } from './improvements-audit.js';
import { auditMemory } from './memory-audit.js';
import { auditReview } from './review-audit.js';
import { readJson, validateJsonAgainstSchema } from './manifest.js';

function reportStatus(items) {
  if (items.some((item) => item.severity === 'error')) return 'degraded';
  if (items.some((item) => item.severity === 'warning')) return 'warning';
  return 'healthy';
}

export async function runProjectAudit({ baseSha, kind, now = new Date(), receiptPath, rootDir, targetDir, write = false }) {
  if (!['memory', 'review', 'improvements', 'all'].includes(kind)) throw new Error('audit --kind must be memory, review, improvements, or all.');
  if (write && kind !== 'improvements') throw new Error('audit --write is only allowed with --kind improvements.');
  const selected = kind === 'all' ? ['memory', 'review', 'improvements'] : [kind];
  const reports = {};
  for (const item of selected) {
    if (item === 'memory') reports.memory = await auditMemory({ now, targetDir });
    if (item === 'review') reports.review = await auditReview({ baseSha, receiptPath, rootDir, targetDir });
    if (item === 'improvements') reports.improvements = await auditImprovements({ now, receiptPath, rootDir, targetDir, write });
  }
  const evidence = Object.values(reports).flatMap((report) => report.evidence);
  const written = Object.values(reports).flatMap((report) => report.written ?? []);
  const report = {
    schemaVersion: 1,
    kind,
    generatedAt: now.toISOString(),
    project: path.resolve(targetDir),
    status: reportStatus(evidence),
    readOnly: written.length === 0,
    evidence,
    details: reports,
    written,
  };
  const schema = await readJson(path.join(rootDir, 'schemas/audit-report.schema.json'));
  const errors = validateJsonAgainstSchema(report, schema, 'audit report');
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return report;
}
