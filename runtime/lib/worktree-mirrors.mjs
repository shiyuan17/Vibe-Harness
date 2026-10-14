// Worktree governance-surface projection.
//
// docs/rules/git-rules.md §Worktree keeps every worktree outside the repository
// and shares the main checkout's tool surface with it. The dependency links
// (`linkDependencyRoot`) only cover `node_modules`; the ignored governance
// surface — `.agents` (Skills and runtime), `.codex` (hooks plus the
// project MCP block), the adapter directories — is
// also ignored and therefore absent from a fresh worktree unless it is
// projected. This module declares that projection: a directory is linked to the
// main checkout's same path, a file is copied once when missing.
//
// The projection is the only thing that makes the code-navigation toolchain
// (host configuration and tools) reachable inside a worktree,
// so it is a fact of the worktree's provisioning state rather than a merge-back
// fact. `worktree check` reports a missing or stale mirror without blocking the
// cleanup of an already-merged worktree.
//
// This module reads and writes the worktree side only. It never writes into the
// main checkout and never follows a directory link to remove its target: Node's
// recursive removal unlinks a reparse point instead of descending into it, so
// `removeMirrorLinks` can tear a worktree down without touching the main
// checkout's `.agents`.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
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
 * @param {{followDirectoryLinks?: boolean}} [options] `followDirectoryLinks`
 *   also treats a directory link (a bootstrap-created mirror) as an expandable
 *   directory. Teardown needs it: the leaves a wildcard produced inside a
 *   worktree are links, and `Dirent.isDirectory()` is false for them.
 * @returns {string[]} project-relative, forward-slashed mirror paths
 */
export function expandMirrors(projectDir, mirrors, { followDirectoryLinks = false } = {}) {
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
        // A followed link only counts when it points at a directory: removing a
        // link to a file as if it were an expanded mirror leaf would delete a
        // declared file mirror instead of a projected directory.
        const expandable = (item) => {
          if (EXPANSION_EXCLUDED.has(item.name)) return false;
          if (item.isDirectory()) return true;
          if (!followDirectoryLinks || !item.isSymbolicLink()) return false;
          const abs = path.join(base.abs, item.name);
          try {
            return statSync(abs).isDirectory();
          } catch (error) {
            // A dangling link still has to be discoverable: its main-checkout
            // source was deleted after bootstrap, and the link it left behind
            // is exactly what teardown has to take down.
            return error?.code === 'ENOENT';
          }
        };
        for (const entry of entries.filter(expandable).sort((a, b) => a.name.localeCompare(b.name))) {
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
 * The link segments that stand between `root` and a nested mirror's leaf.
 *
 * `mkdirSync` and `copyFileSync` follow an existing link, so creating
 * `opencode.json` under a worktree whose `.host-config` is still a link to the
 * main checkout would write outside the worktree. Catching the ancestors here is
 * the only check that sees it: a lexical containment test cannot.
 *
 * @returns {string[]} worktree-relative paths of the link ancestors, outermost first
 */
function linkedAncestors(root, relative) {
  const segments = normalizeSlashes(relative).split('/').filter(Boolean);
  const linked = [];
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) linked.push(normalizeSlashes(path.relative(root, cursor)));
    } catch {
      break; // an absent ancestor is created by the caller's mkdirSync
    }
  }
  return linked;
}

/**
 * Project every declared directory link and copied file into one worktree.
 *
 * A directory is linked to the main checkout's same path; a file is copied only
 * when the worktree side is missing. Anything already present is reported
 * `present` and never overwritten, so a developer's local editor state inside
 * `.host-config/` survives a re-run. A mirror the main checkout does not have is
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
    // The ancestor check comes before the existence check: an existing target
    // reached through a link parent resolves into the main checkout, so calling
    // it `present` would report a mirror the worktree does not actually own.
    const linked = linkedAncestors(worktreePath, mirror);
    if (linked.length > 0) {
      // Writing through the link would land outside the worktree (typically in
      // the main checkout), so the mirror is reported instead of projected.
      results.push({ mirror, status: 'skipped', reason: `a parent inside the worktree is a link: ${linked[0]}` });
      continue;
    }
    // `existsSync` is false for a dangling symlink while the link still occupies
    // the path: `copyFileSync` would then follow it and write outside the
    // worktree, so any existing entry — dangling links included — counts as
    // present and is never overwritten.
    let targetStats = null;
    try {
      targetStats = lstatSync(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (targetStats !== null) {
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
 * True when a worktree-side link's own target is this mirror's main-checkout
 * path.
 *
 * The check reads the link itself instead of resolving it, so a dangling link
 * whose main-checkout source was deleted after bootstrap still matches, while an
 * unrelated developer-created link inside the wildcard's directory — or a link
 * to a file — is left for Git to handle.
 */
function linkTargetsMainCheckout(projectDir, target, mirror) {
  let raw;
  try {
    raw = readlinkSync(target);
  } catch {
    return false;
  }
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(target), raw);
  return canonicalPathKey(resolved) === canonicalPathKey(path.join(projectDir, mirror));
}

/**
 * `pathKey` of a path with the Windows extended-length namespace removed.
 *
 * A Windows junction reports its target in extended-length form
 * (`\\?\C:\repo\.agents`, or `\\?\UNC\server\share\...`), which the ordinary
 * form of the same path never matches lexically, so a bootstrap-created
 * junction would otherwise be left in place by the teardown.
 */
function canonicalPathKey(value) {
  const unwrapped = process.platform === 'win32'
    ? String(value).replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '')
    : String(value);
  return pathKey(unwrapped);
}

/**
 * Remove the directory links a bootstrap created inside one worktree.
 *
 * Only symbolic links (junctions on Windows) are removed. A real directory or
 * file inside the worktree belongs to the checkout and is left for
 * `git worktree remove`, so the teardown never deletes project content. The
 * returned list is the `git worktree remove` precondition: a junction left in
 * place can make a recursive delete reach the main checkout's `.agents`.
 *
 * The candidates come from both sides. The declarations are expanded against
 * the main checkout — the set a bootstrap projected — and again against the
 * worktree with directory links followed, because a wildcard's leaves inside a
 * worktree are links (`Dirent.isDirectory()` is false for them) and a source
 * directory deleted after bootstrap would otherwise leave its link behind. A
 * candidate whose own ancestors inside the worktree are links is never touched:
 * it resolves into the main checkout, which this function must not modify.
 */
export function removeMirrorLinks(projectDir, worktreePath, mirrors) {
  const removed = [];
  const candidates = [...new Set([
    ...expandMirrors(projectDir, mirrors),
    ...expandMirrors(worktreePath, mirrors, { followDirectoryLinks: true }),
  ])];
  for (const mirror of candidates) {
    const target = path.join(worktreePath, mirror);
    let stats = null;
    try {
      stats = lstatSync(target);
    } catch {
      stats = null;
    }
    if (stats === null || !stats.isSymbolicLink()) continue;
    if (!linkTargetsMainCheckout(projectDir, target, mirror)) continue;
    if (linkedAncestors(worktreePath, mirror).length > 0) continue;
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
