import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { readJson, validateJsonAgainstSchema } from './manifest.js';
import { createProjectSnapshot } from './project-verification.js';
import { classifyChangedPaths } from './risk-evidence.js';

const git = promisify(execFile);

export function extractIndependentReviewReceiptBlocks(body) {
  const marker = 'Independent Review Receipt';
  const fence = String.fromCharCode(96).repeat(3);
  const blocks = [];
  let cursor = 0;
  while (true) {
    const heading = body.indexOf(marker, cursor);
    if (heading < 0) break;
    const startFence = body.indexOf(fence, heading + marker.length);
    if (startFence < 0) break;
    const jsonStart = body.indexOf('\n', startFence) + 1;
    const endFence = body.indexOf(fence, jsonStart);
    if (jsonStart > 0 && endFence >= 0) blocks.push(body.slice(jsonStart, endFence).trim());
    cursor = endFence >= 0 ? endFence + fence.length : heading + marker.length;
  }
  return blocks;
}

function auditItem(code, severity, message) {
  return { code, severity, message };
}

function reportStatus(items) {
  if (items.some((item) => item.severity === 'error')) return 'degraded';
  if (items.some((item) => item.severity === 'warning')) return 'warning';
  return 'healthy';
}

async function gitText(args, targetDir) {
  try {
    return (await git('git', args, { cwd: targetDir, windowsHide: true })).stdout.trim();
  } catch {
    return null;
  }
}

async function optionalFile(target) {
  try {
    return await readFile(target);
  } catch (error) {
    if (error.code === 'ENOENT') return Buffer.from('missing');
    throw error;
  }
}

export async function createChangeEvidence(targetDir, baseSha, { excludedPaths = [] } = {}) {
  const snapshot = await createProjectSnapshot(targetDir);
  if (!snapshot.available) return { available: false, changedPaths: [], fingerprint: null, headSha: null };
  const fallbackBase = await gitText(['rev-parse', 'HEAD^'], targetDir);
  const base = baseSha ?? await gitText(['merge-base', 'HEAD', 'origin/main'], targetDir) ?? fallbackBase;
  const [changed, working, untracked] = await Promise.all([
    base ? gitText(['diff', '--name-only', base + '...HEAD'], targetDir) : null,
    gitText(['diff', '--name-only', 'HEAD'], targetDir),
    gitText(['ls-files', '--others', '--exclude-standard'], targetDir),
  ]);
  const excluded = new Set(excludedPaths.map((item) => item.replaceAll('\\', '/')));
  const changedPaths = [...new Set([changed, working, untracked]
    .flatMap((value) => String(value ?? '').split(/\r?\n/u))
    .filter(Boolean)
    .map((item) => item.replaceAll('\\', '/')))]
    .filter((item) => !excluded.has(item))
    .sort();
  const hash = createHash('sha256');
  hash.update(base ?? 'missing-base');
  hash.update(snapshot.head);
  for (const relative of changedPaths) {
    hash.update(relative);
    hash.update(await optionalFile(path.join(targetDir, relative)));
  }
  return { available: true, baseSha: base, changedPaths, fingerprint: hash.digest('hex'), headSha: snapshot.head };
}

export function evaluateReviewReceipt({ change, receipt, schema }) {
  const evidence = validateJsonAgainstSchema(receipt, schema, 'review receipt')
    .map((message) => auditItem('REVIEW_RECEIPT_SCHEMA', 'error', message));
  const risk = classifyChangedPaths(change.changedPaths);
  if (!change.available) evidence.push(auditItem('REVIEW_GIT_UNAVAILABLE', 'error', 'Git change evidence is unavailable.'));
  if (receipt?.baseSha !== change.baseSha) evidence.push(auditItem('REVIEW_BASE_STALE', 'error', 'Receipt base SHA does not match the current comparison base.'));
  if (receipt?.headSha !== change.headSha) evidence.push(auditItem('REVIEW_HEAD_STALE', 'error', 'Receipt head SHA does not match the current head.'));
  if (receipt?.changeFingerprint !== change.fingerprint) evidence.push(auditItem('REVIEW_FINGERPRINT_STALE', 'error', 'Receipt change fingerprint does not match the current diff.'));
  if (JSON.stringify([...(receipt?.highRiskPaths ?? [])].sort()) !== JSON.stringify([...risk.highRiskPaths].sort())) {
    evidence.push(auditItem('REVIEW_RISK_SCOPE_STALE', 'error', 'Receipt high-risk paths do not match the current diff.'));
  }
  if (receipt?.readOnly !== true) evidence.push(auditItem('REVIEW_NOT_READ_ONLY', 'error', 'Reviewer must declare a read-only review.'));
  if (receipt?.reviewer?.identity === receipt?.implementer?.identity) evidence.push(auditItem('REVIEW_SAME_IDENTITY', 'error', 'Reviewer identity must differ from implementer identity.'));
  if (receipt?.reviewer?.contextId === receipt?.implementer?.contextId) evidence.push(auditItem('REVIEW_SAME_CONTEXT', 'error', 'Reviewer context must differ from implementer context.'));
  const verification = receipt?.verification;
  if (verification?.headSha !== change.headSha || verification?.stable !== true || verification?.status !== 'passed') {
    evidence.push(auditItem('REVIEW_VERIFICATION_INVALID', 'error', 'Final verification must be passed, stable, and bound to the current head.'));
  }
  const openHigh = (receipt?.findings ?? []).some((item) => ['high', 'critical'].includes(item.severity) && item.status === 'open');
  if (openHigh) evidence.push(auditItem('REVIEW_HIGH_FINDING_OPEN', 'error', 'High or critical findings remain open.'));
  if (receipt?.decision !== 'approved') {
    evidence.push(auditItem('REVIEW_NOT_APPROVED', risk.level === 'high' ? 'error' : 'warning', 'Receipt decision is not approved.'));
  }
  if (risk.level === 'high' && evidence.length === 0) evidence.push(auditItem('REVIEW_APPROVED', 'info', 'Independent review receipt is current and approved.'));
  return { status: reportStatus(evidence), evidence, details: { ...risk, receiptId: receipt?.id ?? null } };
}

export async function auditReview({ baseSha, receiptPath, rootDir, targetDir }) {
  const receiptTarget = receiptPath ? path.resolve(targetDir, receiptPath) : null;
  const receiptRelative = receiptTarget ? path.relative(targetDir, receiptTarget) : null;
  if (receiptRelative && (receiptRelative.startsWith('..') || path.isAbsolute(receiptRelative))) {
    throw new Error('Review receipt must be inside the project.');
  }
  const change = await createChangeEvidence(targetDir, baseSha, {
    excludedPaths: receiptRelative ? [receiptRelative] : [],
  });
  const risk = classifyChangedPaths(change.changedPaths);
  if (!receiptPath) {
    const severity = risk.level === 'high' ? 'error' : 'info';
    const message = risk.level === 'high'
      ? 'High-risk changes require an independent review receipt.'
      : 'Ordinary changes do not require an independent review receipt.';
    const evidence = [auditItem('REVIEW_RECEIPT_MISSING', severity, message)];
    return { status: reportStatus(evidence), evidence, details: risk };
  }
  const [receipt, schema] = await Promise.all([
    readJson(receiptTarget),
    readJson(path.join(rootDir, 'schemas/review-receipt.schema.json')),
  ]);
  return evaluateReviewReceipt({ change, receipt, schema });
}
