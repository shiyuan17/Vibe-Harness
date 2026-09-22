#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import { readJson } from './lib/manifest.js';
import { createChangeEvidence, evaluateReviewReceipt, extractIndependentReviewReceiptBlocks } from './lib/review-audit.js';
import { classifyChangedPaths } from './lib/risk-evidence.js';

// stdout stays machine-readable JSON (the workflow parses it verbatim); the
// human-facing receipt telemetry goes to the GitHub step summary, if one is
// attached, as an append-only markdown block.
async function appendStepSummary({ mode, status, riskLevel, evidenceCodes, receiptId }) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    '## Independent Review Receipt',
    '',
    `- mode: ${mode}`,
    `- status: ${status}`,
    `- risk level: ${riskLevel}`,
    `- evidence: ${evidenceCodes.length > 0 ? evidenceCodes.join(', ') : 'none'}`,
    `- receiptId: ${receiptId ?? 'n/a'}`,
    '',
    '',
  ];
  await appendFile(summaryPath, lines.join('\n'), 'utf8');
}

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');
const mode = process.env.VIBE_HARNESS_INDEPENDENT_REVIEW_MODE === 'required' ? 'required' : 'shadow';
const event = JSON.parse(await readFile(eventPath, 'utf8'));
if (!event.pull_request) {
  console.log(JSON.stringify({ mode, status: 'not-applicable', ok: true }, null, 2));
  await appendStepSummary({ mode, status: 'not-applicable', riskLevel: 'n/a', evidenceCodes: [], receiptId: null });
  process.exit(0);
}
const targetDir = process.cwd();
const rootDir = path.resolve(import.meta.dirname, '..');
const baseSha = event.pull_request.base.sha;
const change = await createChangeEvidence(targetDir, baseSha);
const risk = classifyChangedPaths(change.changedPaths);
const blocks = extractIndependentReviewReceiptBlocks(event.pull_request.body ?? '');
let report;
if (risk.level === 'ordinary') {
  report = { status: 'not-required', evidence: [], details: risk };
} else if (blocks.length !== 1) {
  report = {
    status: 'degraded',
    evidence: [{ code: blocks.length === 0 ? 'REVIEW_RECEIPT_MISSING' : 'REVIEW_RECEIPT_DUPLICATE', severity: 'error', message: 'High-risk PRs require exactly one Independent Review Receipt JSON block.' }],
    details: risk,
  };
} else {
  try {
    const receipt = JSON.parse(blocks[0]);
    const schema = await readJson(path.join(rootDir, 'schemas/review-receipt.schema.json'));
    report = evaluateReviewReceipt({ change, receipt, schema });
  } catch (error) {
    report = { status: 'degraded', evidence: [{ code: 'REVIEW_RECEIPT_INVALID_JSON', severity: 'error', message: error.message }], details: risk };
  }
}
await appendStepSummary({
  mode,
  status: report.status,
  riskLevel: report.details.level,
  evidenceCodes: report.evidence.map((item) => item.code),
  receiptId: report.details.receiptId,
});
const ok = report.status !== 'degraded' || mode === 'shadow';
console.log(JSON.stringify({ mode, ok, ...report }, null, 2));
if (!ok) process.exitCode = 1;
