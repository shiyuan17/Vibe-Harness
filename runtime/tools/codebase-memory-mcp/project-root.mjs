/**
 * Git facts the runtime wrapper and the project command share. A linked
 * worktree resolves to the main checkout so worktree sessions reuse the same
 * project entry and cache instead of creating a second, empty index.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return null;
  const value = String(result.stdout ?? '').trim();
  return value === '' ? null : value;
}

/**
 * @param {string} cwd
 * @returns {{ root: string, gitDir: string, commonDir: string, headSha: string | null, branch: string | null, isWorktree: boolean, mainRoot: string } | null}
 */
export function resolveGitFacts(cwd = process.cwd()) {
  const base = path.resolve(cwd);
  const root = git(base, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const resolvedRoot = path.resolve(root);
  const gitDirRaw = git(resolvedRoot, ['rev-parse', '--absolute-git-dir'])
    ?? git(resolvedRoot, ['rev-parse', '--git-dir']);
  const commonDirRaw = git(resolvedRoot, ['rev-parse', '--git-common-dir']) ?? gitDirRaw;
  const gitDir = gitDirRaw ? path.resolve(resolvedRoot, gitDirRaw) : path.join(resolvedRoot, '.git');
  const commonDir = commonDirRaw ? path.resolve(resolvedRoot, commonDirRaw) : gitDir;
  const isWorktree = gitDir !== commonDir;
  const mainRoot = isWorktree ? path.dirname(commonDir) : resolvedRoot;
  return {
    branch: git(resolvedRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    commonDir,
    gitDir,
    headSha: git(resolvedRoot, ['rev-parse', 'HEAD']),
    isWorktree,
    mainRoot,
    root: resolvedRoot,
  };
}

/**
 * Main checkout that owns the project entry for `cwd`; falls back to the
 * directory itself when git is unavailable.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function resolveIndexRoot(cwd = process.cwd()) {
  const facts = resolveGitFacts(cwd);
  return facts ? facts.mainRoot : path.resolve(cwd);
}
