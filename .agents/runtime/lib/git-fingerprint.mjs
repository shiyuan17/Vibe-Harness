import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// Nested gitlinks are followed to this depth and no further: past it the write
// surface cannot be bounded any more, so the whole write fingerprint is dropped
// instead of being reported as a complete one.
const MAX_SUBMODULE_DEPTH = 6;

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

/** Splits one NUL-separated path listing. */
function splitPaths(value) {
  return String(value ?? '').split('\0').filter(Boolean);
}

/**
 * A comparable key for one filesystem path.
 *
 * Only used to answer "is this the same location": Windows path comparisons are
 * case-insensitive and may carry the `\\?\` extended-length prefix that Node
 * adds when a path is resolved.
 */
function pathKey(value) {
  const resolved = path.resolve(value)
    .replaceAll('\\', '/')
    .replace(/^\/\?\/UNC\//iu, '//')
    .replace(/^\/\?/u, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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
 * `entries` carries the tracked flag per path, because a path that is gone means
 * different things on each side of the index: a tracked file that disappeared
 * was *deleted* — which is a write that has to be observable — while an
 * untracked entry that disappeared is only a sampling race.
 *
 * Returns `null` when any path cannot be read or bounded: an unavailable path
 * cannot be hashed as if it were unchanged, so the caller drops the whole write
 * fingerprint instead of accepting stale evidence.
 */
async function pathWriteEvidence(root, entries) {
  const records = [];
  let latestWriteAt = 0;
  const merged = new Map();
  for (const entry of entries) {
    const previous = merged.get(entry.path);
    merged.set(entry.path, { path: entry.path, tracked: entry.tracked === true || previous?.tracked === true });
  }
  for (const entry of [...merged.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    const absolute = path.join(root, entry.path);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        // A tracked symbolic link is write evidence twice over: retargeting it
        // changes the link text and the link's own metadata, while a write
        // through it changes the metadata of what it resolves to.
        let resolved;
        let targetWriteAt = 0;
        try {
          const target = await stat(absolute);
          if (target.isDirectory()) {
            // A directory target is the one case this walk cannot bound: writing
            // a child through the link changes neither the link nor the
            // directory's own metadata, so there is no surface left to observe.
            // Recording the link as checked would keep a stale fingerprint
            // looking current, so the whole write fingerprint is dropped.
            return null;
          }
          resolved = [target.mtimeMs, target.ctimeMs, target.size];
          targetWriteAt = Math.max(target.mtimeMs, target.ctimeMs);
        } catch (error) {
          if (error.code !== 'ENOENT') return null;
          resolved = 'dangling';
        }
        records.push([entry.path, 'link', info.mtimeMs, info.ctimeMs, info.size, await readlink(absolute), resolved]);
        // A write through the link is a write to the target, so the target's own
        // timestamps count towards "when was anything here last written".
        latestWriteAt = Math.max(latestWriteAt, info.mtimeMs, info.ctimeMs, targetWriteAt);
        continue;
      }
      records.push([entry.path, info.mtimeMs, info.ctimeMs, info.size]);
      latestWriteAt = Math.max(latestWriteAt, info.mtimeMs, info.ctimeMs);
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      // A vanished untracked entry carries no evidence of a write this project
      // owns; a vanished tracked entry is a deletion, and the deletion has to be
      // observable or a receipt taken before it would still look current.
      if (entry.tracked !== true) continue;
      const deletion = await deletionEvidence(root, entry.path);
      if (deletion === null) return null;
      records.push([entry.path, 'missing', ...deletion.records]);
      latestWriteAt = Math.max(latestWriteAt, deletion.latestWriteAt);
    }
  }
  return { latestWriteAt, records };
}

/**
 * The observable evidence of one deleted tracked path: the metadata of the
 * deepest ancestor that still exists.
 *
 * A missing path has no metadata of its own, so without this a deletion would
 * contribute no time at all and `latestWriteAt` would stay older than the
 * completion it invalidates. Returns `null` when no ancestor can be read, so the
 * caller fails closed rather than recording a deletion it cannot date.
 */
async function deletionEvidence(root, relativePath) {
  let current = path.dirname(path.join(root, relativePath));
  const boundary = path.resolve(root);
  for (;;) {
    try {
      const info = await lstat(current);
      return { records: [info.mtimeMs, info.ctimeMs], latestWriteAt: Math.max(info.mtimeMs, info.ctimeMs) };
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      const parent = path.dirname(current);
      if (parent === current || path.resolve(current) === boundary) return null;
      current = parent;
    }
  }
}

/** The gitlink paths recorded in one repository's index, relative to it. */
async function gitlinkPaths(repositoryDir) {
  const staged = await git(['ls-files', '--stage', '-z'], repositoryDir);
  if (!staged.ok) return null;
  return [...new Set(splitPaths(staged.stdout)
    .filter((record) => record.startsWith('160000 '))
    .map((record) => record.slice(record.indexOf('\t') + 1))
    .filter(Boolean))].sort();
}

/**
 * Write evidence for the tracked submodules of one repository.
 *
 * `git ls-files` reports a submodule as a single gitlink path, so the top-level
 * walk records only that directory's own metadata and a write inside the
 * submodule would leave the write fingerprint unchanged. Each submodule is
 * therefore entered as its own repository — recursively, because a submodule can
 * itself contain gitlinks — and asked for its own HEAD, status and per-path
 * metadata; HEAD plus a porcelain status is not enough on its own, because
 * editing a path that is already reported as modified leaves both unchanged.
 *
 * A gitlink that is not an initialized *distinct* worktree (Git would otherwise
 * answer for it with the superproject's own top level) and a repository that
 * cannot be read both drop the whole evidence, so the caller fails closed
 * instead of recording a surface it never observed.
 */
async function submoduleEvidence(repositoryDir, prefix = '', depth = 0, visited = new Set()) {
  if (depth > MAX_SUBMODULE_DEPTH) return null;
  const paths = await gitlinkPaths(repositoryDir);
  if (paths === null) return null;
  const evidence = [];
  for (const relative of paths) {
    const full = path.join(repositoryDir, relative);
    const key = pathKey(full);
    const submodulePath = prefix === '' ? relative : `${prefix}/${relative}`;
    // The same worktree reached twice would be walked twice, so a repeat is a
    // cycle (or a link back to an already visited repository) and drops the
    // evidence instead of producing a half-observed surface.
    if (visited.has(key)) return null;
    visited.add(key);
    const toplevel = await git(['rev-parse', '--show-toplevel'], full);
    if (!toplevel.ok || pathKey(toplevel.stdout.trim()) !== key) return null;
    const head = await git(['rev-parse', 'HEAD'], full);
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], full);
    const tracked = await git(['ls-files', '-z', '--cached'], full);
    const untracked = await git(['ls-files', '-z', '--others', '--exclude-standard'], full);
    if (!head.ok || !status.ok || !tracked.ok || !untracked.ok) return null;
    const writes = await pathWriteEvidence(full, [
      ...splitPaths(tracked.stdout).map((value) => ({ path: value, tracked: true })),
      ...splitPaths(untracked.stdout).map((value) => ({ path: value, tracked: false })),
    ]);
    if (writes === null) return null;
    const nested = await submoduleEvidence(full, submodulePath, depth + 1, visited);
    if (nested === null) return null;
    evidence.push({
      head: head.stdout.trim(), latestWriteAt: writes.latestWriteAt, path: submodulePath,
      status: status.stdout, writes: writes.records, ...(nested.length ? { submodules: nested } : {}),
    });
  }
  return evidence;
}

/** The newest write time anywhere in a submodule evidence tree. */
function latestWriteAtOf(evidence) {
  let latest = 0;
  for (const item of evidence) {
    latest = Math.max(latest, item.latestWriteAt ?? 0);
    if (Array.isArray(item.submodules)) latest = Math.max(latest, latestWriteAtOf(item.submodules));
  }
  return latest;
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
  // Every path below is read against the repository root, never against the
  // directory the caller pointed `--project` at: Git answers listings relative
  // to its own top level, so joining them to a subdirectory would record most
  // files as missing and leave the write fingerprint unchanged by their edits.
  const repositoryRoot = snapshot.root ?? projectDir;
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
  const tracked = await git(['ls-files', '-z', '--cached'], repositoryRoot);
  const untracked = await git(['ls-files', '-z', '--others', '--exclude-standard'], repositoryRoot);
  let writeFingerprint = null;
  let latestWriteAt = null;
  if (tracked.ok && untracked.ok) {
    const files = await pathWriteEvidence(repositoryRoot, [
      ...splitPaths(tracked.stdout).map((value) => ({ path: value, tracked: true })),
      ...splitPaths(untracked.stdout).map((value) => ({ path: value, tracked: false })),
    ]);
    const submodules = await submoduleEvidence(repositoryRoot);
    if (files !== null && submodules !== null) {
      writeFingerprint = createHash('sha256').update(JSON.stringify([...files.records, ...submodules])).digest('hex');
      latestWriteAt = Math.max(files.latestWriteAt, latestWriteAtOf(submodules));
    }
  }
  return { snapshot, fingerprint: hash.digest('hex'), writeFingerprint, latestWriteAt };
}
