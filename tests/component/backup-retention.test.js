import '../helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_BACKUP_RETENTION,
  backupFile,
  pruneBackups,
} from '../../scripts/lib/install-state.js';

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), 'vibe-harness-backup-retention-'));
}

async function readFileUtf8(filePath) {
  return readFile(filePath, 'utf8');
}

async function createBackupDir(targetDir, backupId, relativeFile = 'docs/rules/git-rules.md') {
  const backupDir = path.join(targetDir, '.vibe-harness', 'backups', backupId);
  await mkdir(path.dirname(path.join(backupDir, relativeFile)), { recursive: true });
  await writeFile(path.join(backupDir, relativeFile), `content of ${backupId}\n`, 'utf8');
  return backupDir;
}

async function assertDirectoryPresent(dir) {
  const info = await stat(dir);
  assert.equal(info.isDirectory(), true, `${dir} should remain after pruning`);
}

async function assertDirectoryMissing(dir) {
  await assert.rejects(() => access(dir), (error) => error.code === 'ENOENT', `${dir} should be pruned`);
}

test('pruneBackups keeps the newest directories and deletes the oldest beyond the retention limit', async () => {
  const targetDir = await makeTempDir();
  try {
    for (const backupId of ['2026-09-01T00-00-00-000Z', '2026-09-02T00-00-00-000Z', '2026-09-03T00-00-00-000Z']) {
      await createBackupDir(targetDir, backupId);
    }
    const pruned = await pruneBackups(targetDir, { keep: 2 });
    assert.deepEqual(pruned, ['2026-09-01T00-00-00-000Z']);
    await assertDirectoryMissing(path.join(targetDir, '.vibe-harness', 'backups', '2026-09-01T00-00-00-000Z'));
    for (const backupId of ['2026-09-02T00-00-00-000Z', '2026-09-03T00-00-00-000Z']) {
      await assertDirectoryPresent(path.join(targetDir, '.vibe-harness', 'backups', backupId));
    }
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('pruneBackups orders transaction ids and baseline timestamps together by creation time', async () => {
  const targetDir = await makeTempDir();
  try {
    await createBackupDir(targetDir, '2026-09-01T00-00-00-000Z');
    await createBackupDir(targetDir, '2026-09-01T00-00-00-000Z-6f1b0b1e-0000-4000-8000-000000000001');
    await createBackupDir(targetDir, '2026-09-02T00-00-00-000Z');
    const pruned = await pruneBackups(targetDir, { keep: 1 });
    assert.deepEqual(pruned, [
      '2026-09-01T00-00-00-000Z',
      '2026-09-01T00-00-00-000Z-6f1b0b1e-0000-4000-8000-000000000001',
    ]);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('pruneBackups returns an empty list when no backups directory exists', async () => {
  const targetDir = await makeTempDir();
  try {
    const pruned = await pruneBackups(targetDir);
    assert.deepEqual(pruned, []);
    assert.equal(DEFAULT_BACKUP_RETENTION, 10);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('pruneBackups leaves non-directory entries in the backups root untouched', async () => {
  const targetDir = await makeTempDir();
  const backupsRoot = path.join(targetDir, '.vibe-harness', 'backups');
  try {
    await createBackupDir(targetDir, '2026-09-01T00-00-00-000Z');
    await createBackupDir(targetDir, '2026-09-02T00-00-00-000Z');
    await writeFile(path.join(backupsRoot, 'README.md'), 'operator notes\n', 'utf8');
    const pruned = await pruneBackups(targetDir, { keep: 1 });
    assert.deepEqual(pruned, ['2026-09-01T00-00-00-000Z']);
    assert.equal(await readFileUtf8(path.join(backupsRoot, 'README.md')), 'operator notes\n');
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('pruneBackups keeps everything when the directory count is within the retention limit', async () => {
  const targetDir = await makeTempDir();
  try {
    await createBackupDir(targetDir, '2026-09-01T00-00-00-000Z');
    await createBackupDir(targetDir, '2026-09-02T00-00-00-000Z');
    const pruned = await pruneBackups(targetDir, { keep: 5 });
    assert.deepEqual(pruned, []);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('pruneBackups prunes directories created by backupFile in the shared backups layout', async () => {
  const targetDir = await makeTempDir();
  try {
    const docsDir = path.join(targetDir, 'docs', 'rules');
    await mkdir(docsDir, { recursive: true });
    const target = path.join(docsDir, 'git-rules.md');
    await writeFile(target, 'current content\n', 'utf8');
    const backup = await backupFile({ backupId: '2026-09-01T00-00-00-000Z', target, targetDir });
    assert.equal(backup, '.vibe-harness/backups/2026-09-01T00-00-00-000Z/docs/rules/git-rules.md');
    await createBackupDir(targetDir, '2026-09-02T00-00-00-000Z');
    const pruned = await pruneBackups(targetDir, { keep: 1 });
    assert.deepEqual(pruned, ['2026-09-01T00-00-00-000Z']);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('pruneBackups rejects a non-integer or negative retention limit', async () => {
  const targetDir = await makeTempDir();
  try {
    await assert.rejects(() => pruneBackups(targetDir, { keep: 1.5 }), /non-negative integer/);
    await assert.rejects(() => pruneBackups(targetDir, { keep: -1 }), /non-negative integer/);
    await assert.rejects(() => pruneBackups(targetDir, { keep: '10' }), /non-negative integer/);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});
