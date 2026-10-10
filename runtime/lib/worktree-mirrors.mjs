// Worktree governance-surface projection.
//
// docs/rules/git-rules.md §Worktree keeps every worktree outside the repository
// and shares the main checkout's tool surface with it. The dependency links
// (`linkDependencyRoot`) only cover `node_modules`; the ignored governance
// surface — `.agents` (Skills, runtime, ast-grep, rtk), `.codex` (hooks plus the
// project MCP block), `.serena`, `.codegraph` and the adapter directories — is
// also ignored and therefore absent from a fresh worktree unless it is
// projected. This module declares that projection: a directory is linked to the
// main checkout's same path, a file is copied once when missing.
//
// The projection is the only thing that makes the code-navigation toolchain
// (codegraph, serena, probe, codebase-memory-mcp) reachable inside a worktree,
// so it is a fact of the worktree's provisioning state rather than a merge-back
// fact. `worktree check` reports a missing or stale mirror without blocking the
// cleanup of an already-merged worktree.
//
// This module reads and writes the worktree side only. It never writes into the
// main checkout and never follows a directory link to remove its target: Node's
// recursive removal unlinks a reparse point instead of descending into it, so
// `removeMirrorLinks` can tear a worktree down without touching the main
// checkout's `.agents` or `.codegraph`.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';

import { pathKey } from './worktree-audit.mjs';

export const MIRROR_WILDCARD = '*';

/** Directories that never take part in a wildcard expansion. */
const EXPANSION_EXCLUDED = new Set(['.git', 'node_modules']);

function normalizeSlashes(value) {
  return String(value).replaceAll('\\', '/').replace(/\/+$/u, '');
}

function safeRealpath(target) {
  try {
    return realpathSync.native ? realpathSync.native(target) : realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Link `target` as a directory at `linkPath`.
 *
 * Windows uses a junction so the link needs no elevation; every other platform
 * uses a directory symlink. The semantics are shared with the dependency links
 * in `runtime/commands/run.mjs` so one worktree uses one link style.
 */
export function linkDirectory(target, linkPath) {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(path.resolve(target), path.resolve(linkPath), type);
}

/**
 * Make `target` a real directory.
 *
 * A whole-directory link is promoted (unlinked, then recreated) so individual
 * entries can be overridden inside it. The target of the old link is untouched
 * because Node removes a reparse point instead of descending into it.
 */
export function ensureRealDirectory(target) {
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
    return;
  }
  if (lstatSync(target).isSymbolicLink()) {
    rmSync(target, { force: true, recursive: true });
    mkdirSync(target, { recursive: true });
  }
}

/** True when the declared mirror uses a `*` wildcard segment. */
export function mirrorHasWildcard(mirror) {
  return normalizeSlashes(mirror).split('/').includes(MIRROR_WILDCARD);
}

/**
 * Expand the declared mirrors against the main checkout.
 *
 * A literal path is returned as-is (whether or not it exists) so the caller can
 * report it as `skipped` when the main checkout does not have it. A wildcard
 * path is expanded one `*` segment at a time against the main checkout's real
 * directories, so only paths that can actually be projected are returned. The
 * order is declaration order and then sorted per wildcard segment, and the
 * result is de-duplicated.
 *
 * @param {string} projectDir main checkout
 * @param {unknown} mirrors declared `worktree.mirrors`
 * @returns {string[]} project-relative, forward-slashed mirror paths
 */
export function expandMirrors(projectDir, mirrors) {
  const expanded = [];
  const seen = new Set();
  const add = (relative) => {
    const normalized = normalizeSlashes(relative).replace(/^\.\//u, '');
    if (normalized === '') return;
    const key = pathKey(path.join(projectDir, normalized));
    if (seen.has(key)) return;
    seen.add(key);
    expanded.push(normalized);
  };
  for (const raw of Array.isArray(mirrors) ? mirrors : []) {
    if (typeof raw !== 'string') continue;
    const mirror = normalizeSlashes(raw.trim()).replace(/^\.\//u, '');
    if (mirror === '') continue;
    if (!mirrorHasWildcard(mirror)) {
      add(mirror);
      continue;
    }
    let bases = [{ abs: path.resolve(projectDir), rel: '' }];
    for (const segment of mirror.split('/')) {
      const next = [];
      for (const base of bases) {
        if (segment !== MIRROR_WILDCARD) {
          next.push({ abs: path.join(base.abs, segment), rel: base.rel === '' ? segment : `${base.rel}/${segment}` });
          continue;
        }
        let entries = [];
        try {
          entries = readdirSync(base.abs, { withFileTypes: true });
        } catch {
          entries = [];
        }
        for (const entry of entries.filter((item) => item.isDirectory() && !EXPANSION_EXCLUDED.has(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
          next.push({ abs: path.join(base.abs, entry.name), rel: base.rel === '' ? entry.name : `${base.rel}/${entry.name}` });
        }
      }
      bases = next;
    }
    for (const base of bases) add(base.rel);
  }
  return expanded;
}

/**
 * Project every declared directory link and copied file into one worktree.
 *
 * A directory is linked to the main checkout's same path; a file is copied only
 * when the worktree side is missing. Anything already present is reported
 * `present` and never overwritten, so a developer's local editor state inside
 * `.serena/` survives a re-run. A mirror the main checkout does not have is
 * reported `skipped` — a missing optional surface must not fail the bootstrap.
 *
 * @returns {{mirror: string, status: 'linked'|'copied'|'present'|'skipped', reason?: string}[]}
 */
export function linkOrCopyMirrors(projectDir, worktreePath, mirrors) {
  const results = [];
  for (const mirror of expandMirrors(projectDir, mirrors)) {
    const source = path.join(projectDir, mirror);
    const target = path.join(worktreePath, mirror);
    if (!existsSync(source)) {
      results.push({ mirror, reason: 'absent in the main checkout', status: 'skipped' });
      continue;
    }
    if (existsSync(target)) {
      results.push({ mirror, status: 'present' });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    if (statSync(source).isDirectory()) {
      linkDirectory(source, target);
      results.push({ mirror, status: 'linked' });
    } else {
      copyFileSync(source, target);
      results.push({ mirror, status: 'copied' });
    }
  }
  return results;
}

/**
 * Remove the directory links a bootstrap created inside one worktree.
 *
 * Only symbolic links (junctions on Windows) are removed. A real directory or
 * file inside the worktree belongs to the checkout and is left for
 * `git worktree remove`, so the teardown never deletes project content. The
 * returned list is the `git worktree remove` precondition: a junction left in
 * place can make a recursive delete reach the main checkout's `.agents`.
 */
export function removeMirrorLinks(worktreePath, mirrors) {
  const removed = [];
  for (const mirror of expandMirrors(worktreePath, mirrors)) {
    const target = path.join(worktreePath, mirror);
    let stats = null;
    try {
      stats = lstatSync(target);
    } catch {
      stats = null;
    }
    if (stats === null || !stats.isSymbolicLink()) continue;
    rmSync(target, { force: true, recursive: true });
    removed.push(mirror);
  }
  return removed;
}

/**
 * Mirror-projection evidence for every existing worktree.
 *
 * The result is keyed by `pathKey(entry.path)` and carries one fact per
 * declared mirror that is missing or does not point at the main checkout. A
 * copied file is never reported stale — it is a one-time copy by contract, not
 * a link — so only directory mirrors can be stale.
 */
export function worktreeMirrorEvidence(projectDir, entries, mirrors) {
  const evidence = new Map();
  const expanded = expandMirrors(projectDir, mirrors);
  if (expanded.length === 0) return evidence;
  for (const entry of entries) {
    if (entry.primary || !entry.path || !existsSync(entry.path)) continue;
    const facts = [];
    for (const mirror of expanded) {
      const source = path.join(projectDir, mirror);
      let sourceStats = null;
      try {
        sourceStats = statSync(source);
      } catch {
        sourceStats = null;
      }
      if (sourceStats === null) continue;
      const target = path.join(entry.path, mirror);
      if (!existsSync(target)) {
        facts.push({ mirror, status: 'missing' });
        continue;
      }
      if (!sourceStats.isDirectory()) continue;
      const resolved = safeRealpath(target);
      if (resolved === null || pathKey(resolved) !== pathKey(safeRealpath(source))) {
        facts.push({ mirror, resolved, status: 'stale' });
      }
    }
    if (facts.length > 0) evidence.set(pathKey(entry.path), facts);
  }
  return evidence;
}
