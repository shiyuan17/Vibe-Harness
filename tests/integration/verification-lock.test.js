import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { acquireVerificationLock, verificationLockStatus } from '../../runtime/lib/verification-lock.mjs';
import { DELIVERY_QUEUE_DIR } from '../../runtime/lib/worktree-delivery-queue.mjs';

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

test('heavy verification waits in the repository FIFO and releases atomically', async () => {
  await repository(async (project) => {
    const first = await acquireVerificationLock(project);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal((await verificationLockStatus(project)).held, true);
    const second = await acquireVerificationLock(project, { timeoutMs: 150 });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'WORKTREE_QUEUE_TIMEOUT');
    await first.release();
    assert.equal((await verificationLockStatus(project)).held, false);
    const third = await acquireVerificationLock(project, { timeoutMs: 1000 });
    assert.equal(third.ok, true);
    await third.release();
  });
});

test('dead holder or expired lease is reclaimed, live holder is not', async () => {
  await repository(async (project) => {
    const common = (await execute('git', ['rev-parse', '--git-common-dir'], { cwd: project })).stdout.trim();
    const queueRoot = path.join(project, common, DELIVERY_QUEUE_DIR);
    await mkdir(queueRoot, { recursive: true });
    const staleId = '00000000-0000-4000-8000-000000000001';
    await writeFile(path.join(queueRoot, `000000000001-${staleId}.json`), JSON.stringify({
      schemaVersion: 1,
      id: staleId,
      sequence: 1,
      operation: 'verify',
      batchId: null,
      state: 'queued',
      requestedAt: new Date(Date.now() - 60_000).toISOString(),
      startedAt: null,
      pid: 99999999,
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      leaseMs: 5_000,
      hostname: 'fixture',
      metadata: {},
    }));
    let status = await verificationLockStatus(project);
    assert.equal(status.held, false);
    assert.equal(status.stale, true);
    const acquired = await acquireVerificationLock(project, { timeoutMs: 1000 });
    assert.equal(acquired.ok, true, JSON.stringify(acquired));
    await acquired.release();

    const live = await acquireVerificationLock(project, { timeoutMs: 1000 });
    assert.equal(live.ok, true, JSON.stringify(live));
    status = await verificationLockStatus(project);
    assert.equal(status.held, true);
    assert.equal((await acquireVerificationLock(project, { timeoutMs: 100 })).reason, 'WORKTREE_QUEUE_TIMEOUT');
    await live.release();
  });
});
