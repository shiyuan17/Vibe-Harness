import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { mergeImprovementCandidates, IMPROVEMENTS_TARGET } from '../scripts/lib/improvements-audit.js';
import { auditMemory } from '../scripts/lib/memory-audit.js';
import { createChangeEvidence, evaluateReviewReceipt, extractIndependentReviewReceiptBlocks } from '../scripts/lib/review-audit.js';
import { runProjectAudit } from '../scripts/lib/project-audit.js';
import { readJson } from '../scripts/lib/manifest.js';

const rootDir = path.resolve(import.meta.dirname, '..');
const git = promisify(execFile);

async function temporaryProject() {
  return mkdtemp(path.join(os.tmpdir(), 'vibe-harness-audit-'));
}

test('review receipt approves only independent current stable review', async () => {
  const schema = await readJson(path.join(rootDir, 'schemas/review-receipt.schema.json'));
  const sha = 'a'.repeat(40);
  const receipt = {
    schemaVersion: 1,
    id: 'review-1',
    createdAt: '2026-08-12T00:00:00.000Z',
    baseSha: 'b'.repeat(40),
    headSha: sha,
    changeFingerprint: 'c'.repeat(64),
    highRiskPaths: ['schemas/example.json'],
    reviewer: { type: 'human', identity: 'reviewer', contextId: 'review-context' },
    implementer: { identity: 'implementer', contextId: 'implement-context' },
    readOnly: true,
    verification: { id: 'verify-1', finishedAt: '2026-08-12T00:00:00.000Z', headSha: sha, stable: true, status: 'passed' },
    findings: [],
    decision: 'approved',
  };
  const change = { available: true, baseSha: receipt.baseSha, headSha: sha, fingerprint: receipt.changeFingerprint, changedPaths: receipt.highRiskPaths };
  assert.equal(evaluateReviewReceipt({ change, receipt, schema }).status, 'healthy');
  const stale = structuredClone(receipt);
  stale.headSha = 'd'.repeat(40);
  assert.match(evaluateReviewReceipt({ change, receipt: stale, schema }).evidence.map((item) => item.code).join(','), /REVIEW_HEAD_STALE/u);
  const sameReviewer = structuredClone(receipt);
  sameReviewer.reviewer.identity = sameReviewer.implementer.identity;
  assert.match(evaluateReviewReceipt({ change, receipt: sameReviewer, schema }).evidence.map((item) => item.code).join(','), /REVIEW_SAME_IDENTITY/u);
  const openHigh = structuredClone(receipt);
  openHigh.findings = [{ code: 'F-1', title: 'Open risk', severity: 'high', status: 'open', targetAsset: 'schemas/example.json' }];
  assert.match(evaluateReviewReceipt({ change, receipt: openHigh, schema }).evidence.map((item) => item.code).join(','), /REVIEW_HIGH_FINDING_OPEN/u);
});

test('PR body accepts one independent review receipt block', () => {
  const fence = String.fromCharCode(96).repeat(3);
  const body = '## Independent Review Receipt\n\n' + fence + 'json\n{"id":"one"}\n' + fence;
  assert.deepEqual(extractIndependentReviewReceiptBlocks(body), ['{"id":"one"}']);
  assert.equal(extractIndependentReviewReceiptBlocks(body + '\n' + body).length, 2);
});

test('review evidence excludes its receipt file from the change fingerprint', async () => {
  const project = await temporaryProject();
  await git('git', ['init'], { cwd: project, windowsHide: true });
  await git('git', ['config', 'user.email', 'audit@example.invalid'], { cwd: project, windowsHide: true });
  await git('git', ['config', 'user.name', 'Audit Test'], { cwd: project, windowsHide: true });
  await writeFile(path.join(project, 'tracked.txt'), 'base\n', 'utf8');
  await git('git', ['add', 'tracked.txt'], { cwd: project, windowsHide: true });
  await git('git', ['commit', '-m', 'test: seed audit fixture'], { cwd: project, windowsHide: true });
  await writeFile(path.join(project, 'tracked.txt'), 'changed\n', 'utf8');
  await writeFile(path.join(project, 'review.json'), '{}\n', 'utf8');
  const before = await createChangeEvidence(project, undefined, { excludedPaths: ['review.json'] });
  await writeFile(path.join(project, 'review.json'), '{"changed":true}\n', 'utf8');
  const after = await createChangeEvidence(project, undefined, { excludedPaths: ['review.json'] });
  assert.deepEqual(before.changedPaths, ['tracked.txt']);
  assert.equal(after.fingerprint, before.fingerprint);
});

test('memory audit detects empty, stale, missing, changed, and healthy fixtures', async () => {
  const project = await temporaryProject();
  await mkdir(path.join(project, 'docs/memory'), { recursive: true });
  await writeFile(path.join(project, 'docs/memory/EMPTY.md'), '# State\n- lastVerified: YYYY-MM-DD\n', 'utf8');
  await writeFile(path.join(project, 'docs/memory/STALE.md'), '# State\n- lastVerified: 2026-01-01\n- target: rules/missing.md\n', 'utf8');
  await writeFile(path.join(project, 'docs/memory/INVALID.md'), '# State\n- lastVerified: not-a-date\n', 'utf8');
  await writeFile(path.join(project, 'docs/memory/INVALID-CALENDAR.md'), '# State\n- lastVerified: 2026-02-31\n', 'utf8');
  await mkdir(path.join(project, '.agents/memory'), { recursive: true });
  await writeFile(path.join(project, '.agents/memory/CURRENT.md'), '# Current\n- 目标: active audit\n- 最后验证: 2026-08-10\n', 'utf8');
  const stale = await auditMemory({ now: new Date('2026-08-12T00:00:00.000Z'), targetDir: project });
  const codes = stale.evidence.map((item) => item.code);
  assert.equal(codes.includes('MEMORY_EMPTY_TEMPLATE'), true);
  assert.equal(codes.includes('MEMORY_DURABLE_REVIEW_DUE'), true);
  assert.equal(codes.includes('MEMORY_REFERENCE_MISSING'), true);
  assert.equal(codes.includes('MEMORY_INVALID_DATE'), true);
  assert.equal(codes.includes('MEMORY_ACTIVE_STALE'), true);

  await mkdir(path.join(project, 'rules'), { recursive: true });
  await writeFile(path.join(project, 'rules/current.md'), 'rule', 'utf8');
  await writeFile(path.join(project, 'docs/memory/HEALTHY.md'), '# State\n- lastVerified: 2026-08-12\n- target: rules/current.md\n', 'utf8');
  const healthy = await auditMemory({ now: new Date('2026-08-12T12:00:00.000Z'), targetDir: project });
  assert.equal(healthy.details.filesChecked, 6);
});

test('empty current memory template stays a warning without becoming active', async () => {
  const project = await temporaryProject();
  await mkdir(path.join(project, '.agents/memory'), { recursive: true });
  await writeFile(path.join(project, '.agents/memory/CURRENT.md'), '# Current\n\n- 目标:\n- 最后验证: (YYYY-MM-DD，使用绝对日期)\n', 'utf8');
  const report = await auditMemory({ now: new Date('2026-08-12T00:00:00.000Z'), targetDir: project });
  const codes = report.evidence.map((item) => item.code);
  assert.equal(codes.includes('MEMORY_EMPTY_TEMPLATE'), true);
  assert.equal(codes.includes('MEMORY_INVALID_DATE'), false);
  assert.equal(codes.includes('MEMORY_ACTIVE_UNVERIFIED'), false);
});

test('improvement candidates are idempotent, thresholded, and terminal-safe', () => {
  const now = new Date('2026-08-12T00:00:00.000Z');
  const base = { schemaVersion: 1, updatedAt: now.toISOString(), candidates: [] };
  const observation = {
    code: 'RULE-1', episode: 'episode-1', evidenceRefs: ['evidence-1'], expectedBenefit: 'Avoid recurrence.',
    firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), owner: '', reviewBy: '', severity: 'medium',
    targetAsset: 'rules/example.md', title: 'Repeated rule finding', type: 'rule',
  };
  const first = mergeImprovementCandidates(base, [observation], now);
  assert.equal(first.candidates[0].status, 'proposed');
  const duplicate = mergeImprovementCandidates(first, [observation], now);
  assert.equal(duplicate.candidates[0].distinctEpisodes.length, 1);
  const second = mergeImprovementCandidates(duplicate, [{ ...observation, episode: 'episode-2' }], now);
  assert.equal(second.candidates[0].status, 'eligible-for-owner-review');
  second.candidates[0].status = 'implemented';
  const terminal = mergeImprovementCandidates(second, [{ ...observation, episode: 'episode-3' }], now);
  assert.equal(terminal.candidates[0].status, 'implemented');
});

test('only improvements kind writes and uses the governance queue target', async () => {
  const project = await temporaryProject();
  await assert.rejects(
    runProjectAudit({ kind: 'memory', rootDir, targetDir: project, write: true }),
    /only allowed/u,
  );
  const before = await stat(project);
  const preview = await runProjectAudit({ kind: 'improvements', rootDir, targetDir: project, write: false });
  assert.equal(preview.readOnly, true);
  await assert.rejects(readFile(path.join(project, IMPROVEMENTS_TARGET), 'utf8'), /ENOENT/u);
  const written = await runProjectAudit({ kind: 'improvements', rootDir, targetDir: project, write: true });
  assert.deepEqual(written.written, [IMPROVEMENTS_TARGET]);
  assert.equal(JSON.parse(await readFile(path.join(project, IMPROVEMENTS_TARGET), 'utf8')).schemaVersion, 1);
  assert.ok((await stat(project)).mtimeMs >= before.mtimeMs);
});

test('improvements accepts only project-local valid review receipts', async () => {
  const project = await temporaryProject();
  const outside = path.join(path.dirname(project), 'outside-review.json');
  await writeFile(outside, '{}\n', 'utf8');
  await assert.rejects(
    runProjectAudit({ kind: 'improvements', receiptPath: outside, rootDir, targetDir: project }),
    /inside the project/u,
  );
  await writeFile(path.join(project, 'invalid-review.json'), '{}\n', 'utf8');
  await assert.rejects(
    runProjectAudit({ kind: 'improvements', receiptPath: 'invalid-review.json', rootDir, targetDir: project }),
    /review receipt/u,
  );
});

test('garbage collection only creates old unreferenced candidates', async () => {
  const project = await temporaryProject();
  await mkdir(path.join(project, 'rules'), { recursive: true });
  const oldAsset = path.join(project, 'rules/unused.md');
  await writeFile(oldAsset, 'unused', 'utf8');
  const oldDate = new Date('2026-01-01T00:00:00.000Z');
  await utimes(oldAsset, oldDate, oldDate);
  const report = await runProjectAudit({ kind: 'improvements', now: new Date('2026-08-12T00:00:00.000Z'), rootDir, targetDir: project });
  const candidate = report.details.improvements.details.queue.candidates.find((item) => item.targetAsset === 'rules/unused.md');
  assert.equal(candidate.type, 'garbage-collection');
  assert.equal(candidate.status, 'proposed');
});
