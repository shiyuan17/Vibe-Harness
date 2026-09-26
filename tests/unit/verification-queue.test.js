import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { consumeVerificationQueue, enqueueVerification, markStaleIfChanged, transitionQueue } from '../../scripts/verification-queue.js';

test('verification queue enforces state transitions and fingerprints', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-queue-'));
  try {
    const queued = await enqueueVerification({ projectDir, commitSha: 'abc', worktreeFingerprint: 'tree', planFingerprint: 'plan', commandSetFingerprint: 'commands' });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.commitSha, 'abc');
    const running = await transitionQueue(projectDir, queued.id, 'running');
    assert.equal(running.status, 'running');
    const passed = await transitionQueue(projectDir, queued.id, 'passed');
    assert.equal(passed.status, 'passed');
    await assert.rejects(() => transitionQueue(projectDir, queued.id, 'failed'), /Invalid queue transition/u);
    const stale = await markStaleIfChanged(projectDir, queued.id, { commitSha: 'changed', worktreeFingerprint: 'tree' });
    assert.equal(stale.status, 'stale');
    const stored = JSON.parse(await readFile(path.join(projectDir, '.vibe-harness/verification/queue', `${queued.id}.json`), 'utf8'));
    assert.equal(stored.status, 'stale');
    assert.equal((await markStaleIfChanged(projectDir, queued.id, {})).status, 'stale');
    for (const field of ['commitSha', 'worktreeFingerprint', 'planFingerprint', 'commandSetFingerprint']) {
      const identity = { commitSha: 'abc', worktreeFingerprint: 'tree', planFingerprint: 'plan', commandSetFingerprint: 'commands' };
      const receipt = await enqueueVerification({ projectDir, ...identity });
      await transitionQueue(projectDir, receipt.id, 'running');
      await transitionQueue(projectDir, receipt.id, 'passed');
      assert.equal((await markStaleIfChanged(projectDir, receipt.id, identity)).status, 'passed');
      assert.equal((await markStaleIfChanged(projectDir, receipt.id, { ...identity, [field]: 'changed' })).status, 'stale', field);
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('expired queued verification becomes stale without starting a runner', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-queue-expired-'));
  try {
    const queued = await enqueueVerification({ projectDir, ttlMs: -1 });
    const [stale] = await consumeVerificationQueue(projectDir);
    assert.equal(stale.id, queued.id);
    assert.equal(stale.status, 'stale');
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
