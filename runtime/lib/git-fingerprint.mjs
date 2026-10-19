import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { gitTimeoutMs } from './git-timeouts.mjs';

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
      timeout: gitTimeoutMs(),
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/**
 * Run Git and keep the bytes of its output.
 *
 * Git allows any byte except NUL in a path, so a path listing is bytes rather
 * than text. Reading it as a string would replace a path that is not valid
 * UTF-8 with U+FFFD, and the replacement no longer addresses the file on disk.
 */
async function gitBytes(args, projectDir) {
  try {
    const result = await execFileAsync('git', args, {
      cwd: projectDir,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: gitTimeoutMs(),
      windowsHide: true,
    });
    return { ok: true, stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '') };
  } catch {
    return { ok: false, stdout: Buffer.alloc(0) };
  }
}

/**
 * Splits one NUL-separated path listing into paths.
 *
 * A path whose bytes are not valid UTF-8 cannot be addressed by the string this
 * process would decode it to: `lstat()` would then check a different location
 * and the entry would be recorded as missing (or, for an untracked path, as no
 * write at all). The listing therefore fails closed — `null` — instead of being
 * published as evidence for a file that was never observed.
 *
 * @param {Buffer|string} value
 * @returns {string[]|null}
 */
function splitPaths(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
  const paths = [];
  let start = 0;
  for (let index = 0; index <= buffer.length; index += 1) {
    if (index !== buffer.length && buffer[index] !== 0) continue;
    if (index > start) {
      const slice = buffer.subarray(start, index);
      const decoded = slice.toString('utf8');
      if (!Buffer.from(decoded, 'utf8').equals(slice)) return null;
      paths.push(decoded);
    }
    start = index + 1;
  }
  return paths;
}

/**
 * One Git answer that names a location, decoded only when that is lossless.
 *
 * `rev-parse --show-toplevel` and a porcelain status both carry filesystem
 * paths, so the same "U+FFFD is not the path" rule applies: a value that is not
 * valid UTF-8 cannot be used to address the file it came from, and the caller
 * has to drop the evidence rather than work from a location that does not exist.
 *
 * @param {Buffer} buffer
 * @returns {string|null}
 */
function decodePathText(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer ?? '');
  const value = buffer.toString('utf8');
  return Buffer.from(value, 'utf8').equals(buffer) ? value : null;
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

/**
 * The `--porcelain=v1 -z` status records, or null when a path is undecodable.
 *
 * @param {Buffer|string} value
 * @returns {Array<{status: string, path: string, newPath?: string}>|null}
 */
function parseStatus(value) {
  const records = splitPaths(value);
  if (records === null) return null;
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

/**
 * The paths this project does not own.
 *
 * Git's own ignore rules are the project's declaration of which paths are not
 * part of its write surface: the harness's own bookkeeping (`.vibe-harness`),
 * dependency trees, and build output all live there. The directory walk below
 * skips exactly those, so the harness writing a receipt cannot look like the
 * project writing a file, and an arbitrarily large ignored tree is never walked.
 */
async function ignoredPaths(repositoryDir) {
  const ignored = await gitBytes(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], repositoryDir);
  if (!ignored.ok) return null;
  const paths = splitPaths(ignored.stdout);
  if (paths === null) return null;
  return new Set(paths.map((value) => value.replace(/\/+$/u, '')));
}

/**
 * Metadata evidence for the repository's directory tree.
 *
 * The per-path records only cover paths that are still listed, so a write that
 * is created and removed again between two snapshots leaves nothing behind in
 * either listing — while the directory that held it did change. Every
 * directory's own timestamps are recorded for that reason: creating or removing
 * an entry updates its parent, which is what dates a transient write. It is also
 * the only evidence that reaches a directory this snapshot lists no path for.
 *
 * The walk never follows a link (a worktree's `.agents` junction is the
 * documented case, and following it would walk the checkout it points at) and
 * never enters an ignored directory. Returns `null` when the tree cannot be
 * enumerated, so the caller fails closed rather than publishing a partial
 * surface.
 */
async function directoryEvidence(repositoryDir, ignored) {
  const records = [];
  let latestWriteAt = 0;
  const queue = [{ absolute: path.resolve(repositoryDir), relative: '' }];
  while (queue.length > 0) {
    const current = queue.pop();
    let info;
    try {
      info = await lstat(current.absolute);
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      // A directory that vanished mid-walk was written to after this snapshot
      // started, and there is no metadata left to date it with.
      return null;
    }
    if (info.isSymbolicLink()) {
      if (current.relative === '') return null;
      continue;
    }
    if (!info.isDirectory()) return null;
    records.push([current.relative, info.mtimeMs, info.ctimeMs]);
    latestWriteAt = Math.max(latestWriteAt, info.mtimeMs, info.ctimeMs);
    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const relative = current.relative === '' ? entry.name : `${current.relative}/${entry.name}`;
      if (ignored.has(relative)) continue;
      queue.push({ absolute: path.join(current.absolute, entry.name), relative });
    }
  }
  // `readdir` order is not a contract, so the evidence is ordered before it is
  // hashed: two snapshots of an unchanged tree must produce one fingerprint.
  records.sort((left, right) => left[0].localeCompare(right[0]));
  return { latestWriteAt, records };
}

/**
 * The write evidence for one repository's own tree: every listed tracked or
 * untracked path, plus the directory metadata that dates a transient write.
 */
async function writeEvidence(repositoryDir, trackedBuffer, untrackedBuffer) {
  const tracked = splitPaths(trackedBuffer);
  const untracked = splitPaths(untrackedBuffer);
  if (tracked === null || untracked === null) return null;
  const files = await pathWriteEvidence(repositoryDir, [
    ...tracked.map((value) => ({ path: value, tracked: true })),
    ...untracked.map((value) => ({ path: value, tracked: false })),
  ]);
  if (files === null) return null;
  const ignored = await ignoredPaths(repositoryDir);
  if (ignored === null) return null;
  const directories = await directoryEvidence(repositoryDir, ignored);
  if (directories === null) return null;
  return {
    latestWriteAt: Math.max(files.latestWriteAt, directories.latestWriteAt),
    records: [...files.records, ...directories.records],
  };
}

/** The gitlink paths recorded in one repository's index, relative to it. */
async function gitlinkPaths(repositoryDir) {
  const staged = await gitBytes(['ls-files', '--stage', '-z'], repositoryDir);
  if (!staged.ok) return null;
  const records = splitPaths(staged.stdout);
  if (records === null) return null;
  return [...new Set(records
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
    const tracked = await gitBytes(['ls-files', '-z', '--cached'], full);
    const untracked = await gitBytes(['ls-files', '-z', '--others', '--exclude-standard'], full);
    if (!head.ok || !status.ok || !tracked.ok || !untracked.ok) return null;
    const trackedPaths = splitPaths(tracked.stdout);
    const untrackedPaths = splitPaths(untracked.stdout);
    if (trackedPaths === null || untrackedPaths === null) return null;
    const writes = await pathWriteEvidence(full, [
      ...trackedPaths.map((value) => ({ path: value, tracked: true })),
      ...untrackedPaths.map((value) => ({ path: value, tracked: false })),
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
  // The repository root and the status records both name filesystem paths, so
  // both are read as bytes: a path that does not survive the UTF-8 decode
  // cannot be addressed, and a snapshot built from one would describe files
  // this process never looked at.
  const root = await gitBytes(['rev-parse', '--show-toplevel'], projectDir);
  if (!root.ok) return { available: false, reason: 'not-a-git-worktree', changes: [] };
  const rootPath = decodePathText(root.stdout);
  if (rootPath === null) return { available: false, reason: 'git-root-undecodable', changes: [] };
  const status = await gitBytes(['status', '--porcelain=v1', '-z', '--untracked-files=all'], projectDir);
  const head = await git(['rev-parse', 'HEAD'], projectDir);
  if (!status.ok) return { available: false, reason: 'git-status-failed', changes: [] };
  const changes = parseStatus(status.stdout);
  if (changes === null) return { available: false, reason: 'git-status-undecodable', changes: [] };
  return {
    available: true,
    root: rootPath.trim().replaceAll('\\', '/'),
    head: head.ok ? head.stdout.trim() : null,
    changes,
    reason: null,
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
  const tracked = await gitBytes(['ls-files', '-z', '--cached'], repositoryRoot);
  const untracked = await gitBytes(['ls-files', '-z', '--others', '--exclude-standard'], repositoryRoot);
  let writeFingerprint = null;
  let latestWriteAt = null;
  if (tracked.ok && untracked.ok) {
    const writes = await writeEvidence(repositoryRoot, tracked.stdout, untracked.stdout);
    const submodules = await submoduleEvidence(repositoryRoot);
    if (writes !== null && submodules !== null) {
      writeFingerprint = createHash('sha256').update(JSON.stringify([...writes.records, ...submodules])).digest('hex');
      latestWriteAt = Math.max(writes.latestWriteAt, latestWriteAtOf(submodules));
    }
  }
  return { snapshot, fingerprint: hash.digest('hex'), writeFingerprint, latestWriteAt };
}

/**
 * Content identity of the worktree independent of checkout path, branch name,
 * and commit sha. The committed tree object and every uncommitted/untracked
 * content change are part of the digest; a different commit with the same tree
 * therefore addresses the same code.
 *
 * An unreadable path returns null instead of hashing a placeholder: a cache hit
 * against content this process could not observe would be fabricated evidence.
 */
export async function gitTreeFingerprint(projectDir) {
  const snapshot = await gitSnapshot(projectDir);
  if (!snapshot.available || !snapshot.head) return null;
  const tree = await git(['rev-parse', 'HEAD^{tree}'], projectDir);
  if (!tree.ok || !/^[0-9a-f]{40,64}$/u.test(tree.stdout.trim())) return null;
  const repositoryRoot = snapshot.root ?? projectDir;
  const hash = createHash('sha256').update(tree.stdout.trim()).update('\0');
  const changes = [...snapshot.changes].sort((left, right) => left.path.localeCompare(right.path));
  for (const change of changes) {
    hash.update(change.status).update('\0').update(change.path).update('\0');
    if (change.newPath) hash.update(change.newPath).update('\0');
  }
  const paths = new Set(changes.flatMap((change) => [change.path, change.newPath].filter(Boolean)));
  for (const relativePath of [...paths].sort()) {
    hash.update(relativePath).update('\0');
    try {
      hash.update(await readFile(path.join(repositoryRoot, relativePath)));
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      hash.update('<missing>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}
