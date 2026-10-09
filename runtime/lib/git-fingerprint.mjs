import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(args, projectDir) {
  try {
    const result = await execFileAsync('git', args, {
      cwd: projectDir,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

function parseStatus(value) {
  const records = String(value ?? '').split('\0').filter(Boolean);
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    const filePath = record.slice(3).replaceAll('\\', '/');
    const nextPath = status.includes('R') || status.includes('C')
      ? (records[++index] ?? '').replaceAll('\\', '/')
      : null;
    changes.push({ status, path: filePath, ...(nextPath ? { newPath: nextPath } : {}) });
  }
  return changes;
}

export async function gitSnapshot(projectDir) {
  const root = await git(['rev-parse', '--show-toplevel'], projectDir);
  if (!root.ok) return { available: false, reason: 'not-a-git-worktree', changes: [] };
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], projectDir);
  const head = await git(['rev-parse', 'HEAD'], projectDir);
  return {
    available: status.ok,
    root: status.ok ? root.stdout.trim().replaceAll('\\', '/') : null,
    head: head.ok ? head.stdout.trim() : null,
    changes: status.ok ? parseStatus(status.stdout) : [],
    reason: status.ok ? null : 'git-status-failed',
  };
}

export async function gitFingerprint(projectDir) {
  const snapshot = await gitSnapshot(projectDir);
  if (!snapshot.available) return { snapshot, fingerprint: null };
  const hash = createHash('sha256');
  hash.update(snapshot.head ?? '');
  const changes = [...snapshot.changes].sort((left, right) => left.path.localeCompare(right.path));
  for (const change of changes) {
    hash.update(change.status);
    hash.update('\0');
    hash.update(change.path);
    hash.update('\0');
    if (change.newPath) {
      hash.update(change.newPath);
      hash.update('\0');
    }
  }
  const paths = new Set(changes.flatMap((change) => [change.path, change.newPath].filter(Boolean)));
  for (const relativePath of [...paths].sort()) {
    hash.update(relativePath);
    hash.update('\0');
    try {
      hash.update(await readFile(path.join(snapshot.root ?? projectDir, relativePath)));
    } catch {
      hash.update(Buffer.from('<unreadable>', 'utf8'));
    }
    hash.update('\0');
  }
  return { snapshot, fingerprint: hash.digest('hex') };
}
