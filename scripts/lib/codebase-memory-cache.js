/**
 * Cache location, freshness and cleanup for the codebase-memory-mcp runtime.
 *
 * The managed MCP block, the provisioning phases and the project command all
 * resolve the cache through `runtime/tools/codebase-memory-mcp/cache-path.mjs`,
 * so the repository CLI only needs to *report* that location (doctor/validate)
 * and to remove the per-project directory when the runtime leaves the project
 * (uninstall/rollback). Removal is deliberately narrow: only the directory the
 * shared resolver derives for this project under the private per-user root is a
 * candidate, so an explicit `CBM_CACHE_DIR` and the cache root itself are never
 * deleted.
 */

import { access, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  codebaseMemoryCacheDir,
  codebaseMemoryCacheRoot,
  codebaseMemoryIndexStatePath,
  codebaseMemoryLegacyCacheDir,
  codebaseMemoryProjectSlug,
} from '../../runtime/tools/codebase-memory-mcp/cache-path.mjs';
import { evaluateIndexFreshness, readIndexState } from '../../runtime/tools/codebase-memory-mcp/index-state.mjs';
import { resolveGitFacts } from '../../runtime/tools/codebase-memory-mcp/project-root.mjs';

export const CODEBASE_MEMORY_CACHE_STALE_COPY = 'CODEBASE_MEMORY_CACHE_STALE_COPY';

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function configuredCacheDir(env) {
  return typeof env?.CBM_CACHE_DIR === 'string' ? env.CBM_CACHE_DIR.trim() : '';
}

/**
 * Cache root a pre-0.11.0 runtime used on this host (`~/.cache/...`), which the
 * upgrade left behind. It is only reported; nothing here deletes it.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function legacyUserCacheDir(env = process.env) {
  const base = env.HOME || env.USERPROFILE;
  return base ? path.join(base, '.cache', 'codebase-memory-mcp') : null;
}

/**
 * Facts doctor/validate report for one project. `staleCopies` lists pre-upgrade
 * cache locations that still exist, because two caches for one project is the
 * failure mode that made the MCP server serve an outdated graph.
 *
 * @param {string} targetDir
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [options]
 */
export async function describeCodebaseMemoryCache(targetDir, { env = process.env, platform = process.platform } = {}) {
  const projectRoot = path.resolve(targetDir);
  const cacheDir = codebaseMemoryCacheDir(projectRoot, env, platform);
  const indexStatePath = codebaseMemoryIndexStatePath(projectRoot);
  const state = await readIndexState(indexStatePath);
  const facts = resolveGitFacts(projectRoot);
  const freshness = evaluateIndexFreshness(state, { headSha: facts?.headSha ?? null });
  const staleCopies = [];
  const candidates = [
    ['project-local', codebaseMemoryLegacyCacheDir(projectRoot)],
    ['user-level', legacyUserCacheDir(env)],
  ];
  for (const [kind, candidate] of candidates) {
    if (!candidate || path.resolve(candidate) === path.resolve(cacheDir)) continue;
    if (await pathExists(candidate)) staleCopies.push({ kind, path: candidate });
  }
  return {
    cacheDir,
    cacheDirExists: await pathExists(cacheDir),
    explicitCacheDir: configuredCacheDir(env) !== '',
    freshness: { reason: freshness.reason, state: freshness.state },
    indexState: state
      ? {
        edges: state.edges,
        headSha: state.headSha,
        indexedAt: state.indexedAt,
        nodes: state.nodes,
        runtimeVersion: state.runtimeVersion,
      }
      : null,
    indexStatePath,
    staleCopies,
  };
}

/** True when the plugin runtime is still projected into the project. */
export async function codebaseMemoryRuntimePresent(targetDir) {
  return pathExists(path.join(path.resolve(targetDir), '.agents', 'runtime', 'tools', 'codebase-memory-mcp', 'run.mjs'));
}

/**
 * Remove the private per-project cache directory.
 *
 * A dry run reports the intended directory without touching it. The removal is
 * refused when `CBM_CACHE_DIR` is set explicitly (the operator pinned a shared
 * location) and whenever the resolved path is not exactly the slug directory
 * for this project below the private cache root.
 *
 * @param {string} targetDir
 * @param {{ dryRun?: boolean, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [options]
 */
export async function removeCodebaseMemoryCache(targetDir, { dryRun = false, env = process.env, platform = process.platform } = {}) {
  const projectRoot = path.resolve(targetDir);
  const cacheDir = codebaseMemoryCacheDir(projectRoot, env, platform);
  if (configuredCacheDir(env) !== '') {
    return { dir: cacheDir, reason: 'explicit-cache-dir', removed: false };
  }
  const expected = path.join(codebaseMemoryCacheRoot(env, platform), codebaseMemoryProjectSlug(projectRoot, platform));
  if (path.resolve(cacheDir) !== path.resolve(expected)) {
    return { dir: cacheDir, reason: 'unexpected-cache-dir', removed: false };
  }
  if (!(await pathExists(cacheDir))) {
    return { dir: cacheDir, reason: 'absent', removed: false };
  }
  if (dryRun) {
    return { dir: cacheDir, planned: true, removed: false };
  }
  await rm(cacheDir, { force: true, recursive: true });
  return { dir: cacheDir, removed: true };
}
