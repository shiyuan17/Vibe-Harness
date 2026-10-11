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
 * Write evidence for one tracked/untracked path list.
 *
 * Returns `null` when any path cannot be read: an unavailable path cannot be
 * hashed as if it were unchanged, so the caller drops the whole write
 * fingerprint instead of accepting stale evidence.
 */
async function pathWriteEvidence(root, files) {
  const records = [];
  let latestWriteAt = 0;
  for (const file of [...new Set(files)].sort()) {
    const absolute = path.join(root, file);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        // A tracked symbolic link is write evidence twice over: retargeting it
        // changes the link text and the link's own metadata, while a write
        // through it changes the metadata of what it resolves to. A directory
        // target is the one case that cannot be followed — writing a child does
        // not change the directory's own metadata — so it is recorded as an
        // unusable target instead of a checked one.
        let resolved;
        try {
          const target = await stat(absolute);
          resolved = target.isDirectory() ? 'directory-target' : [target.mtimeMs, target.ctimeMs, target.size];
        } catch (error) {
          if (error.code !== 'ENOENT') return null;
          resolved = 'dangling';
        }
        records.push([file, 'link', info.mtimeMs, info.ctimeMs, info.size, await readlink(absolute), resolved]);
        latestWriteAt = Math.max(latestWriteAt, info.mtimeMs, info.ctimeMs);
        continue;
      }
      records.push([file, info.mtimeMs, info.ctimeMs, info.size]);
      latestWriteAt = Math.max(latestWriteAt, info.mtimeMs, info.ctimeMs);
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      records.push([file, 'missing']);
    }
  }
  return { latestWriteAt, records };
}

/**
 * Write evidence for tracked submodules.
 *
 * `git ls-files` reports a submodule as a single gitlink path, so the top-level
 * walk records only that directory's own metadata and a write inside the
 * submodule would leave the write fingerprint unchanged. Each submodule is
 * therefore asked for its own HEAD, status and per-path metadata; HEAD plus a
 * porcelain status is not enough on its own, because editing a path that is
 * already reported as modified leaves both unchanged. Returns `null` when the
 * submodule surface cannot be read, so the caller fails closed.
 */
async function submoduleEvidence(projectDir) {
  const staged = await git(['ls-files', '--stage', '-z'], projectDir);
  if (!staged.ok) return null;
  const paths = [...new Set(staged.stdout.split('\0').filter(Boolean)
    .filter((record) => record.startsWith('160000 '))
    .map((record) => record.slice(record.indexOf('\t') + 1))
    .filter(Boolean))].sort();
  const evidence = [];
  for (const relative of paths) {
    const head = await git(['-C', relative, 'rev-parse', 'HEAD'], projectDir);
    if (!head.ok) {
      evidence.push({ head: 'uninitialized', latestWriteAt: 0, path: relative, writes: [] });
      continue;
    }
    const status = await git(['-C', relative, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], projectDir);
    const nested = await git(['-C', relative, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], projectDir);
    if (!status.ok || !nested.ok) return null;
    const writes = await pathWriteEvidence(path.join(projectDir, relative), nested.stdout.split('\0').filter(Boolean));
    if (writes === null) return null;
    evidence.push({ head: head.stdout.trim(), latestWriteAt: writes.latestWriteAt, path: relative, status: status.stdout, writes: writes.records });
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
    const files = await pathWriteEvidence(projectDir, tracked.stdout.split('\0').filter(Boolean));
    const submodules = await submoduleEvidence(projectDir);
    if (files !== null && submodules !== null) {
      writeFingerprint = createHash('sha256').update(JSON.stringify([...files.records, ...submodules])).digest('hex');
      latestWriteAt = submodules.reduce((latest, item) => Math.max(latest, item.latestWriteAt), files.latestWriteAt);
    }
  }
  return { snapshot, fingerprint: hash.digest('hex'), writeFingerprint, latestWriteAt };
}
