import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(args, projectDir) {
  try {
    const result = await execFileAsync('git', args, {
      cwd: projectDir,
      encoding: 'utf8',
      // The tracked-path listing of a large repository can exceed a few
      // megabytes of NUL-separated names; a truncated read would silently turn
      // into "no write evidence", which validateCompletion() reads as a new write.
      maxBuffer: 64 * 1024 * 1024,
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

/**
 * Write evidence for tracked submodules.
 *
 * `git ls-files` reports a submodule as a single gitlink path, so the file
 * walk above records only that directory's own metadata and a write inside the
 * submodule would leave the write fingerprint unchanged. Each submodule is
 * therefore asked for its own HEAD and status.
 */
async function submoduleEvidence(projectDir) {
  const staged = await git(['ls-files', '--stage', '-z'], projectDir);
  if (!staged.ok) return [];
  const paths = [...new Set(staged.stdout.split('\0').filter(Boolean)
    .filter((record) => record.startsWith('160000 '))
    .map((record) => record.slice(record.indexOf('\t') + 1))
    .filter(Boolean))].sort();
  const evidence = [];
  for (const relative of paths) {
    const head = await git(['-C', relative, 'rev-parse', 'HEAD'], projectDir);
    if (!head.ok) {
      evidence.push([relative, 'uninitialized']);
      continue;
    }
    const status = await git(['-C', relative, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], projectDir);
    evidence.push([relative, head.stdout.trim(), status.ok ? status.stdout : 'unreadable']);
  }
  return evidence;
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
  const tracked = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], projectDir);
  let writeFingerprint = null;
  let latestWriteAt = null;
  if (tracked.ok) {
    const files = [...new Set(tracked.stdout.split('\0').filter(Boolean))].sort();
    const metadata = await Promise.all(files.map(async (file) => {
      const absolute = path.join(projectDir, file);
      try {
        const info = await lstat(absolute);
        // A tracked symbolic link is part of the write evidence twice over: the
        // link text and its own metadata change when it is retargeted, and the
        // metadata of what it resolves to changes when a write goes through it.
        // Following the link with `stat()` alone would miss the first case.
        if (info.isSymbolicLink()) {
          const target = await stat(absolute).catch((error) => (error.code === 'ENOENT' ? 'dangling' : 'unreadable'));
          const resolved = typeof target === 'string' ? target : [target.mtimeMs, target.ctimeMs, target.size];
          return [file, 'link', await readlink(absolute), resolved];
        }
        return [file, info.mtimeMs, info.ctimeMs, info.size];
      } catch (error) { return [file, error.code === 'ENOENT' ? 'missing' : 'unreadable']; }
    }));
    const submodules = await submoduleEvidence(projectDir);
    if (!metadata.some((item) => item[1] === 'unreadable' || item[3] === 'unreadable') && !submodules.some((item) => item[2] === 'unreadable')) {
      writeFingerprint = createHash('sha256').update(JSON.stringify([...metadata, ...submodules])).digest('hex');
      latestWriteAt = metadata.reduce((latest, item) => typeof item[1] === 'number' ? Math.max(latest, item[1]) : latest, 0);
    }
  }
  return { snapshot, fingerprint: hash.digest('hex'), writeFingerprint, latestWriteAt };
}
