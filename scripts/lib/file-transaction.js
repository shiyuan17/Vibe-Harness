import { randomUUID } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertPortableRelativePath, assertSafePathInside, pathExists } from './manifest.js';
import { projectStateDir } from './project-layout.js';

async function transactionLayout(targetDir) {
  const stateDir = await projectStateDir(targetDir);
  return {
    lockPath: path.join(stateDir, 'transaction.lock'),
    transactionRoot: path.join(stateDir, 'transactions'),
  };
}

export function createTransactionId(date = new Date()) {
  return `${date.toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`;
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

function relativeProjectPath(targetDir, candidatePath, label) {
  const relative = path.relative(targetDir, candidatePath).replaceAll('\\', '/');
  assertPortableRelativePath(relative, label);
  return relative;
}

async function snapshotPath({ index, preimagesDir, targetDir, targetPath }) {
  await assertSafePathInside(targetDir, targetPath, 'transaction target');
  const relativeTarget = relativeProjectPath(targetDir, targetPath, 'transaction target');
  let info;
  try {
    info = await lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { existed: false, target: relativeTarget };
    throw error;
  }
  if (!info.isFile() && !info.isDirectory()) throw new Error(`Transaction targets must be regular files or directories: ${targetPath}`);
  const kind = info.isDirectory() ? 'directory' : 'file';
  const preimage = `${index}.${kind === 'directory' ? 'dir' : 'bin'}`;
  if (kind === 'directory') await cp(targetPath, path.join(preimagesDir, preimage), { recursive: true });
  else await copyFile(targetPath, path.join(preimagesDir, preimage));
  return { existed: true, kind, preimage, target: relativeTarget };
}

async function restoreJournal(targetDir, transactionDir, journal) {
  for (const record of [...journal.records].reverse()) {
    const targetPath = path.join(targetDir, record.target);
    await assertSafePathInside(targetDir, targetPath, 'transaction recovery target');
    if (record.existed) {
      await rm(targetPath, { force: true, recursive: true });
      await mkdir(path.dirname(targetPath), { recursive: true });
      if (record.kind === 'directory') {
        await cp(path.join(transactionDir, 'preimages', record.preimage), targetPath, { recursive: true });
      } else {
        await copyFile(path.join(transactionDir, 'preimages', record.preimage), targetPath);
      }
    } else {
      await rm(targetPath, { force: true, recursive: true });
    }
  }
  for (const cleanup of [...journal.cleanup].reverse()) {
    if (cleanup.existed) continue;
    const cleanupPath = path.join(targetDir, cleanup.target);
    await assertSafePathInside(targetDir, cleanupPath, 'transaction cleanup target');
    await rm(cleanupPath, { force: true, recursive: true });
  }
}

async function readTransactionLockId(targetDir, lockPath) {
  const resolvedLockPath = lockPath ?? (await transactionLayout(targetDir)).lockPath;
  const transactionIdPath = path.join(resolvedLockPath, 'transaction-id');
  await assertSafePathInside(targetDir, transactionIdPath, 'transaction lock');
  try {
    return (await readFile(transactionIdPath, 'utf8')).trim() || null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function releaseTransaction(targetDir, transactionDir, transactionId, lockPath) {
  await rm(transactionDir, { force: true, recursive: true });
  const lockOwner = await readTransactionLockId(targetDir, lockPath);
  if (lockOwner === null || lockOwner === transactionId) {
    await rm(lockPath, { force: true, recursive: true });
  }
}

export async function beginFileTransaction({
  cleanupPaths = [],
  id = createTransactionId(),
  operation,
  targetDir,
  trackedPaths,
}) {
  const resolvedTargetDir = path.resolve(targetDir);
  const { lockPath, transactionRoot } = await transactionLayout(resolvedTargetDir);
  const transactionDir = path.join(transactionRoot, id);
  const preimagesDir = path.join(transactionDir, 'preimages');
  for (const candidatePath of [...trackedPaths, ...cleanupPaths, transactionDir, lockPath]) {
    await assertSafePathInside(resolvedTargetDir, candidatePath, 'transaction path');
  }

  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Another Cognis write transaction is active; run recover --project ${resolvedTargetDir}.`);
    }
    throw error;
  }

  try {
    await mkdir(preimagesDir, { recursive: true });
    const uniqueTrackedPaths = [...new Set(trackedPaths.map((item) => path.resolve(item)))];
    const records = [];
    for (const [index, targetPath] of uniqueTrackedPaths.entries()) {
      records.push(await snapshotPath({ index, preimagesDir, targetDir: resolvedTargetDir, targetPath }));
    }
    const cleanup = [];
    for (const cleanupPath of [...new Set(cleanupPaths.map((item) => path.resolve(item)))]) {
      cleanup.push({
        existed: await pathExists(cleanupPath),
        target: relativeProjectPath(resolvedTargetDir, cleanupPath, 'transaction cleanup target'),
      });
    }
    const journalPath = path.join(transactionDir, 'journal.json');
    const journal = {
      cleanup,
      createdAt: new Date().toISOString(),
      id,
      operation,
      records,
      schemaVersion: 1,
      status: 'active',
    };
    await writeJsonAtomic(journalPath, journal);
    await writeFile(path.join(lockPath, 'transaction-id'), `${id}\n`, 'utf8');

    return {
      id,
      async commit() {
        await writeJsonAtomic(journalPath, { ...journal, completedAt: new Date().toISOString(), status: 'committed' });
        await releaseTransaction(resolvedTargetDir, transactionDir, id, lockPath);
      },
      async rollback() {
        try {
          await restoreJournal(resolvedTargetDir, transactionDir, journal);
          await writeJsonAtomic(journalPath, { ...journal, completedAt: new Date().toISOString(), status: 'rolled-back' });
          await releaseTransaction(resolvedTargetDir, transactionDir, id, lockPath);
        } catch (error) {
          await writeJsonAtomic(journalPath, {
            ...journal,
            failure: { code: error.code ?? 'TRANSACTION_RECOVERY_FAILED', message: 'Transaction recovery failed.' },
            status: 'recovery-failed',
          });
          throw error;
        }
      },
    };
  } catch (error) {
    await releaseTransaction(resolvedTargetDir, transactionDir, id, lockPath);
    throw error;
  }
}

export async function inspectTransactions(targetDir) {
  const resolvedTargetDir = path.resolve(targetDir);
  const { transactionRoot } = await transactionLayout(resolvedTargetDir);
  if (!(await pathExists(transactionRoot))) return [];
  await assertSafePathInside(resolvedTargetDir, transactionRoot, 'transaction root');
  const entries = await readdir(transactionRoot, { withFileTypes: true });
  const transactions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const journalPath = path.join(transactionRoot, entry.name, 'journal.json');
    await assertSafePathInside(resolvedTargetDir, journalPath, 'transaction journal');
    if (!(await pathExists(journalPath))) continue;
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    if (typeof journal.id !== 'string' || journal.id !== entry.name) {
      throw new Error(`Transaction journal id must match its transaction directory: ${entry.name}`);
    }
    transactions.push({
      createdAt: journal.createdAt,
      id: journal.id,
      operation: journal.operation,
      status: journal.status,
    });
  }
  return transactions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function recoverTransaction({ id, targetDir, write = false }) {
  const resolvedTargetDir = path.resolve(targetDir);
  const transactions = await inspectTransactions(resolvedTargetDir);
  const recoverable = transactions.filter((item) => ['active', 'recovery-failed'].includes(item.status));
  const selected = id ? recoverable.find((item) => item.id === id) : recoverable[0];
  if (!selected) return { recovered: [], transactions };
  if (!write) return { recovered: [], selected, transactions };
  const { lockPath, transactionRoot } = await transactionLayout(resolvedTargetDir);
  const lockOwner = await readTransactionLockId(resolvedTargetDir, lockPath);
  if (lockOwner !== null && lockOwner !== selected.id) {
    throw new Error(`Transaction lock is owned by transaction ${lockOwner}; refusing to recover ${selected.id}.`);
  }
  const transactionDir = path.join(transactionRoot, selected.id);
  const journalPath = path.join(transactionDir, 'journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  await restoreJournal(resolvedTargetDir, transactionDir, journal);
  await releaseTransaction(resolvedTargetDir, transactionDir, selected.id, lockPath);
  return { recovered: [selected.id], selected, transactions };
}
