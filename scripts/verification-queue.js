#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gitFingerprint } from '../runtime/lib/git-fingerprint.mjs';

const execFileAsync = promisify(execFile);

export const QUEUE_STATES = Object.freeze(['queued', 'running', 'passed', 'failed', 'blocked', 'stale']);

function queueDir(projectDir) {
  return path.join(projectDir, '.vibe-harness', 'verification', 'queue');
}

async function persist(projectDir, receipt) {
  await mkdir(queueDir(projectDir), { recursive: true });
  await writeFile(path.join(queueDir(projectDir), `${receipt.id}.json`), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  return receipt;
}

/** @param {any} options */
export async function enqueueVerification({ projectDir, tier = 'deep', scope = 'layer', planFingerprint = null, commandSetFingerprint = null, worktreeFingerprint = null, commitSha = null, ttlMs = 86_400_000 } = {}) {
  if (tier !== 'deep') throw new Error('Async verification requires deep tier');
  if (commitSha === null || worktreeFingerprint === null) {
    const current = await gitFingerprint(projectDir);
    commitSha ??= current.snapshot.head ?? null;
    worktreeFingerprint ??= current.fingerprint;
  }
  const createdAt = new Date();
  const receipt = {
    schemaVersion: 1,
    id: randomUUID(),
    status: 'queued',
    tier,
    scope,
    commitSha,
    worktreeFingerprint,
    planFingerprint,
    commandSetFingerprint,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
    stateMachine: [...QUEUE_STATES],
  };
  return persist(projectDir, receipt);
}

export async function readQueueReceipt(projectDir, id) {
  return /** @type {any} */ (JSON.parse(await readFile(path.join(queueDir(projectDir), `${id}.json`), 'utf8')));
}

/** @param {any} patch */
export async function transitionQueue(projectDir, id, status, patch = {}) {
  if (!QUEUE_STATES.includes(status)) throw new Error(`Invalid queue status: ${status}`);
  /** @type {any} */
  const current = await readQueueReceipt(projectDir, id);
  const allowed = current.status === 'queued' ? ['running', 'stale'] : current.status === 'running' ? ['passed', 'failed', 'blocked', 'stale'] : current.status === 'passed' ? ['stale'] : [];
  if (!allowed.includes(status)) throw new Error(`Invalid queue transition ${current.status} -> ${status}`);
  return persist(projectDir, { ...current, ...patch, status, updatedAt: new Date().toISOString() });
}

/** @param {any} identity */
export async function markStaleIfChanged(projectDir, id, identity = {}) {
  const { commitSha, worktreeFingerprint, planFingerprint, commandSetFingerprint } = identity;
  /** @type {any} */
  const current = await readQueueReceipt(projectDir, id);
  if (!['queued', 'running', 'passed'].includes(current.status)) return current;
  if (
    (current.commitSha && commitSha !== current.commitSha)
    || (current.worktreeFingerprint && worktreeFingerprint !== current.worktreeFingerprint)
    || (planFingerprint && current.planFingerprint && planFingerprint !== current.planFingerprint)
    || (commandSetFingerprint && current.commandSetFingerprint && commandSetFingerprint !== current.commandSetFingerprint)) {
    return transitionQueue(projectDir, id, 'stale', { staleReason: 'verification identity changed or is unavailable' });
  }
  return current;
}

export async function consumeVerificationQueue(projectDir) {
  const directory = queueDir(projectDir);
  let names;
  try { names = await readdir(directory); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const receipts = [];
  for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
    const id = name.slice(0, -5);
    const queued = await readQueueReceipt(projectDir, id);
    if (!['queued', 'passed'].includes(queued.status)) continue;
    if (queued.expiresAt && Date.parse(queued.expiresAt) <= Date.now()) {
      receipts.push(await transitionQueue(projectDir, id, 'stale', { staleReason: 'queue receipt expired' }));
      continue;
    }
    const snapshot = await gitFingerprint(projectDir);
    const current = await markStaleIfChanged(projectDir, id, {
      commitSha: snapshot.snapshot.head,
      worktreeFingerprint: snapshot.fingerprint,
    });
    if (current.status === 'stale') {
      receipts.push(current);
      continue;
    }
    if (current.status === 'passed') {
      receipts.push(current);
      continue;
    }
    await transitionQueue(projectDir, id, 'running', { claimedAt: new Date().toISOString(), consumer: 'ci' });
    try {
      const entry = path.resolve(import.meta.dirname, 'vibe-harness.js');
      const result = await execFileAsync(process.execPath, [entry, 'verify', '--project', projectDir, '--tier', 'deep', '--scope', queued.scope ?? 'layer', '--output', 'json'], {
        cwd: projectDir,
        shell: false,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      /** @type {any} */
      let report = {};
      try { report = JSON.parse(result.stdout); } catch {}
      const status = report.status === 'ready' || report.ok === true ? 'passed' : report.status === 'invalid' ? 'failed' : 'blocked';
      receipts.push(await transitionQueue(projectDir, id, status, {
        finishedAt: new Date().toISOString(),
        resultStatus: report.status ?? null,
      }));
    } catch (error) {
      receipts.push(await transitionQueue(projectDir, id, error?.code === 'ETIMEDOUT' ? 'blocked' : 'failed', {
        finishedAt: new Date().toISOString(),
        diagnostic: String(error?.stderr ?? error?.message ?? '').slice(-2000),
      }));
    }
  }
  return receipts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [action, projectDir = process.cwd(), id, status] = process.argv.slice(2);
  try {
    if (action === 'enqueue') console.log(JSON.stringify(await enqueueVerification({ projectDir }), null, 2));
    else if (action === 'consume') console.log(JSON.stringify(await consumeVerificationQueue(projectDir), null, 2));
    else if (action === 'transition') console.log(JSON.stringify(await transitionQueue(projectDir, id, status), null, 2));
    else throw new Error('Usage: node scripts/verification-queue.js enqueue|consume|transition <project> [id] [status]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
