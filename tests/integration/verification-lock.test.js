import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { acquireVerificationLock, verificationLockStatus, VERIFICATION_LOCK_NAME } from '../../runtime/lib/verification-lock.mjs';

const execute = promisify(execFile);

async function repository(callback) {
  const project = await mkdtemp(path.join(tmpdir(), 'verification-lock-'));
  try {
    await execute('git', ['init', '--quiet'], { cwd: project });
    await callback(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

test('heavy verification lease is exclusive and releases atomically', async () => {
  await repository(async (project) => {
    const first = await acquireVerificationLock(project);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal((await verificationLockStatus(project)).held, true);
    const second = await acquireVerificationLock(project);
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'verification-lock-held');
    first.release();
    assert.equal((await verificationLockStatus(project)).held, false);
    const third = await acquireVerificationLock(project);
    assert.equal(third.ok, true);
    third.release();
  });
});

test('dead holder or expired lease is reclaimed, live holder is not', async () => {
  await repository(async (project) => {
    const common = (await execute('git', ['rev-parse', '--git-common-dir'], { cwd: project })).stdout.trim();
    const lockPath = path.join(project, common, VERIFICATION_LOCK_NAME);
    await writeFile(lockPath, JSON.stringify({
      schemaVersion: 1,
      nonce: 'stale',
      pid: 99999999,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      leaseMs: 5_000,
    }));
    const status = await verificationLockStatus(project);
    assert.equal(status.held, false);
    assert.equal(status.stale, true);
    const acquired = await acquireVerificationLock(project);
    assert.equal(acquired.ok, true, JSON.stringify(acquired));
    acquired.release();

    await writeFile(lockPath, JSON.stringify({
      schemaVersion: 1,
      nonce: 'live',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseMs: 600_000,
    }));
    assert.equal((await verificationLockStatus(project)).held, true);
    assert.equal((await acquireVerificationLock(project)).ok, false);
  });
});
