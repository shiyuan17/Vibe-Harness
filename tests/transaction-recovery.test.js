import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { beginFileTransaction, recoverTransaction } from '../scripts/lib/file-transaction.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/cognis.js');

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: rootDir });
  return JSON.parse(stdout);
}

test('recover previews then restores the active transaction only with --write', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-recover-'));
  const managedPath = path.join(target, 'managed.md');
  try {
    await writeFile(managedPath, 'original\n', 'utf8');
    const transaction = await beginFileTransaction({
      operation: 'test-recovery',
      targetDir: target,
      trackedPaths: [managedPath],
    });
    await writeFile(managedPath, 'interrupted\n', 'utf8');

    const preview = await runCli(['recover', '--project', target]);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.selected.id, transaction.id);
    assert.equal(await readFile(managedPath, 'utf8'), 'interrupted\n');

    const recovered = await runCli(['recover', '--project', target, '--write']);
    assert.deepEqual(recovered.recovered, [transaction.id]);
    assert.equal(await readFile(managedPath, 'utf8'), 'original\n');
    assert.equal(await exists(path.join(target, '.cognis', 'transaction.lock')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('doctor reports active transactions without modifying them', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-doctor-transaction-'));
  let transaction;
  try {
    await runCli(['init', '--project', target]);
    await runCli(['install', '--project', target, '--profile', 'core', '--write']);
    const managedPath = path.join(target, 'docs/rules/governance-core.md');
    transaction = await beginFileTransaction({
      operation: 'test-doctor',
      targetDir: target,
      trackedPaths: [managedPath],
    });

    const report = await runCli(['doctor', '--project', target, '--allow-degraded']);
    assert.equal(report.transactionLock, true);
    assert.equal(report.transactions.some((item) => item.id === transaction.id && item.status === 'active'), true);
    assert.equal(await exists(path.join(target, '.cognis', 'transaction.lock')), true);
  } finally {
    if (transaction) await transaction.rollback();
    await rm(target, { force: true, recursive: true });
  }
});

test('recover rejects journal ids that do not match their transaction directory', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-recover-id-'));
  const transactionDir = path.join(target, '.cognis/transactions/safe-id');
  const victimDir = path.join(target, '.cognis/victim');
  try {
    const journal = {
      cleanup: [],
      createdAt: new Date().toISOString(),
      id: '../victim',
      operation: 'malicious-recovery',
      records: [],
      schemaVersion: 1,
      status: 'active',
    };
    await mkdir(transactionDir, { recursive: true });
    await mkdir(victimDir, { recursive: true });
    await writeFile(path.join(transactionDir, 'journal.json'), `${JSON.stringify(journal)}\n`, 'utf8');
    await writeFile(path.join(victimDir, 'journal.json'), `${JSON.stringify(journal)}\n`, 'utf8');
    await writeFile(path.join(victimDir, 'keep.txt'), 'keep\n', 'utf8');

    await assert.rejects(
      recoverTransaction({ targetDir: target, write: true }),
      /journal id.*transaction directory/iu,
    );
    assert.equal(await readFile(path.join(victimDir, 'keep.txt'), 'utf8'), 'keep\n');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('recover refuses to release a lock owned by another transaction', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-recover-lock-'));
  const transactionDir = path.join(target, '.cognis/transactions/older');
  const lockDir = path.join(target, '.cognis/transaction.lock');
  try {
    const journal = {
      cleanup: [],
      createdAt: new Date().toISOString(),
      id: 'older',
      operation: 'orphaned-recovery',
      records: [],
      schemaVersion: 1,
      status: 'active',
    };
    await mkdir(transactionDir, { recursive: true });
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(transactionDir, 'journal.json'), `${JSON.stringify(journal)}\n`, 'utf8');
    await writeFile(path.join(lockDir, 'transaction-id'), 'newer\n', 'utf8');

    await assert.rejects(
      recoverTransaction({ id: 'older', targetDir: target, write: true }),
      /lock is owned by transaction newer/iu,
    );
    assert.equal((await readFile(path.join(lockDir, 'transaction-id'), 'utf8')).trim(), 'newer');
    assert.equal(await exists(transactionDir), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
