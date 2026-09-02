import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { pathExists, readJson, validateJsonAgainstSchema } from './manifest.js';

export const IMPROVEMENTS_TARGET = 'docs/memory/IMPROVEMENTS.json';
const TERMINAL_STATUSES = new Set(['accepted', 'implemented', 'rejected']);

function threshold(type, severity) {
  if (severity === 'critical' || type === 'bug') return 1;
  if (['hook', 'linter', 'rule'].includes(type)) return 2;
  if (type === 'skill') return 3;
  return Number.POSITIVE_INFINITY;
}

function candidateId(type, code, targetAsset) {
  const digest = createHash('sha256')
    .update([type, code, targetAsset].join(':'))
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return 'IMP-' + digest;
}

export function mergeImprovementCandidates(queue, observations, now = new Date()) {
  const byId = new Map((queue?.candidates ?? []).map((item) => [item.id, structuredClone(item)]));
  for (const observation of observations) {
    const id = candidateId(observation.type, observation.code, observation.targetAsset);
    const existing = byId.get(id);
    if (existing && TERMINAL_STATUSES.has(existing.status)) continue;
    const episodes = new Set([...(existing?.distinctEpisodes ?? []), observation.episode]);
    const evidenceRefs = new Set([...(existing?.evidenceRefs ?? []), ...observation.evidenceRefs]);
    const status = episodes.size >= threshold(observation.type, observation.severity)
      ? 'eligible-for-owner-review'
      : 'proposed';
    byId.set(id, {
      id,
      type: observation.type,
      title: observation.title,
      status,
      targetAsset: observation.targetAsset,
      evidenceRefs: [...evidenceRefs].sort(),
      distinctEpisodes: [...episodes].sort(),
      firstSeenAt: existing?.firstSeenAt ?? observation.firstSeenAt,
      lastSeenAt: observation.lastSeenAt,
      owner: existing?.owner ?? observation.owner,
      reviewBy: existing?.reviewBy ?? observation.reviewBy,
      expectedBenefit: existing?.expectedBenefit ?? observation.expectedBenefit,
    });
  }
  return {
    schemaVersion: 1,
    ...(queue?.project ? { project: queue.project } : {}),
    updatedAt: now.toISOString(),
    candidates: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function findingsFromReceipt(receipt, now) {
  return (receipt?.findings ?? []).filter((item) => item.status !== 'false-positive').map((item) => ({
    code: item.code,
    episode: item.episode ?? receipt.id,
    evidenceRefs: item.evidenceRefs ?? ['review:' + receipt.id + ':' + item.code],
    expectedBenefit: item.severity === 'critical' ? 'Reduce critical security risk.' : 'Prevent repeated review findings.',
    firstSeenAt: receipt.createdAt ?? now.toISOString(),
    lastSeenAt: receipt.createdAt ?? now.toISOString(),
    owner: '',
    reviewBy: '',
    severity: item.severity,
    targetAsset: item.targetAsset,
    title: item.title,
    type: item.type ?? (item.severity === 'critical' ? 'security' : 'rule'),
  }));
}

async function walkFiles(root, relative = '') {
  const absolute = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, next));
    else if (entry.isFile()) files.push(next.replaceAll('\\', '/'));
  }
  return files;
}

async function garbageCollectionObservations(targetDir, now) {
  const roots = ['rules', 'templates', 'skills', 'runtime', 'adapters', 'manifests', 'schemas'];
  const candidates = (await Promise.all(roots.map((root) => walkFiles(targetDir, root)))).flat();
  const referenceFiles = (await Promise.all(['manifests', 'docs', 'tests'].map((root) => walkFiles(targetDir, root)))).flat();
  const references = [];
  for (const relative of referenceFiles) {
    if (relative === IMPROVEMENTS_TARGET) continue;
    try {
      references.push(await readFile(path.join(targetDir, relative), 'utf8'));
    } catch {
      continue;
    }
  }
  const corpus = references.join('\n').replaceAll('\\', '/');
  const observations = [];
  for (const relative of candidates) {
    const metadata = await lstat(path.join(targetDir, relative));
    if ((now.getTime() - metadata.mtime.getTime()) / 86400000 < 90) continue;
    if (corpus.includes(relative)) continue;
    observations.push({
      code: 'GC-UNREFERENCED-ASSET',
      episode: 'gc-' + now.toISOString().slice(0, 10),
      evidenceRefs: ['file:' + relative],
      expectedBenefit: 'Reduce unowned governance surface after owner review.',
      firstSeenAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      owner: '',
      reviewBy: '',
      severity: 'low',
      targetAsset: relative,
      title: 'Review unreferenced governance asset',
      type: 'garbage-collection',
    });
  }
  return observations;
}

export async function auditImprovements({ now = new Date(), receiptPath, rootDir, targetDir, write = false }) {
  const target = path.join(targetDir, IMPROVEMENTS_TARGET);
  const queue = await pathExists(target)
    ? await readJson(target)
    : { schemaVersion: 1, updatedAt: now.toISOString(), candidates: [] };
  const receiptTarget = receiptPath ? path.resolve(targetDir, receiptPath) : null;
  const receiptRelative = receiptTarget ? path.relative(targetDir, receiptTarget) : null;
  if (receiptRelative && (receiptRelative.startsWith('..') || path.isAbsolute(receiptRelative))) {
    throw new Error('Improvement receipt must be inside the project.');
  }
  const receipt = receiptTarget ? await readJson(receiptTarget) : null;
  if (receipt) {
    const receiptSchema = await readJson(path.join(rootDir, 'schemas/review-receipt.schema.json'));
    const receiptErrors = validateJsonAgainstSchema(receipt, receiptSchema, 'review receipt');
    if (receiptErrors.length > 0) throw new Error(receiptErrors.join('\n'));
  }
  const observations = [
    ...findingsFromReceipt(receipt, now),
    ...await garbageCollectionObservations(targetDir, now),
  ];
  const next = mergeImprovementCandidates(queue, observations, now);
  const schema = await readJson(path.join(rootDir, 'schemas/improvements-queue.schema.json'));
  const errors = validateJsonAgainstSchema(next, schema, IMPROVEMENTS_TARGET);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  if (write) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(next, null, 2) + '\n', 'utf8');
  }
  return {
    status: 'healthy',
    evidence: [{
      code: next.candidates.length ? 'IMPROVEMENTS_CANDIDATES' : 'IMPROVEMENTS_EMPTY',
      severity: 'info',
      message: next.candidates.length ? String(next.candidates.length) + ' improvement candidates are available.' : 'No improvement candidates were found.',
      ...(next.candidates.length ? { path: IMPROVEMENTS_TARGET } : {}),
    }],
    details: { queue: next },
    written: write ? [IMPROVEMENTS_TARGET] : [],
  };
}
