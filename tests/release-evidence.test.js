import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createReleaseEvidence } from '../scripts/lib/release-evidence.js';
import { readJson, validateJsonAgainstSchema } from '../scripts/lib/manifest.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('release evidence binds verified SHA, tarball digest, checks, provenance, and rollback policy', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'vibe-release-evidence-'));
  const tarball = path.join(temporary, 'vibe-harness-1.2.3.tgz');
  await writeFile(tarball, 'package bytes');
  try {
    const evidence = await createReleaseEvidence({
      releaseTag: 'v1.2.3', version: '1.2.3',
      releaseSha: 'a'.repeat(40), verifiedSha: 'a'.repeat(40),
      verificationId: 'github-actions:123:1', verificationFinishedAt: '2026-08-12T03:00:00.000Z',
      verificationSnapshotComparison: 'match', checks: ['pnpm check', 'pnpm docs:audit'],
      tarballPath: tarball, attestationStatus: 'generated',
    });
    const schema = await readJson(path.join(rootDir, 'schemas/release-evidence.schema.json'));
    assert.deepEqual(validateJsonAgainstSchema(evidence, schema, 'release evidence'), []);
    assert.equal(evidence.tarball.sha256.length, 64);
    assert.deepEqual(evidence.checks[0], { name: 'pnpm check', status: 'passed' });
    assert.equal(evidence.rollbackStrategy, 'revert-and-new-patch-release');
    assert.equal(JSON.stringify(evidence).includes(temporary), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('release evidence rejects a release SHA that was not verified', async () => {
  await assert.rejects(() => createReleaseEvidence({
    releaseTag: 'v1.2.3', version: '1.2.3', releaseSha: 'a'.repeat(40), verifiedSha: 'b'.repeat(40),
    verificationId: 'github-actions:123:1', verificationFinishedAt: '2026-08-12T03:00:00.000Z',
    verificationSnapshotComparison: 'match', checks: ['pnpm check'], tarballPath: 'unused.tgz', attestationStatus: 'generated',
  }), /does not match verified SHA/u);
});
