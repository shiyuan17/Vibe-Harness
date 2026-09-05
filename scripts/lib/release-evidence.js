import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function createReleaseEvidence(input) {
  if (input.releaseSha !== input.verifiedSha) {
    throw new Error('release SHA does not match verified SHA');
  }
  if (input.verificationSnapshotComparison !== 'match') throw new Error('release verification snapshots do not match');
  const tarball = await readFile(input.tarballPath);
  return {
    schemaVersion: 2,
    releaseTag: input.releaseTag,
    version: input.version,
    releaseSha: input.releaseSha,
    verification: {
      id: input.verificationId,
      finishedAt: input.verificationFinishedAt,
      snapshotComparison: 'match',
      sha: input.verifiedSha,
    },
    checks: [...new Set(input.checks)].map((name) => ({ name, status: 'passed' })),
    tarball: {
      name: path.basename(input.tarballPath),
      sha256: createHash('sha256').update(tarball).digest('hex'),
    },
    attestationStatus: input.attestationStatus,
    rollbackStrategy: 'revert-and-new-patch-release',
  };
}
