/**
 * Single source of truth for the codebase-memory-mcp cache location and the
 * project state files Vibe-Harness owns.
 *
 * The managed MCP block, the provisioning phases, the runtime wrapper and the
 * project command all resolve the cache through this module, so an MCP query
 * and a management CLI call can never read two different graphs for the same
 * project. The cache lives outside the repository because codebase-memory-mcp
 * 0.11.0 refuses a cache directory whose path chain grants mutation rights to
 * an untrusted identity (`C:\` grants `Authenticated Users:(M)` on this class
 * of host, which makes every project-local cache under `C:\Project` unusable).
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

export const CODEBASE_MEMORY_TOOL_ID = 'codebase-memory-mcp';
export const CODEBASE_MEMORY_DIRECTORY_SLUG_LIMIT = 72;

/** Project-owned state directory for the tool (runtime, stamps, legacy cache). */
export function codebaseMemoryStateDir(projectRoot) {
  return path.join(path.resolve(projectRoot), '.vibe-harness', 'tool-state', CODEBASE_MEMORY_TOOL_ID);
}

/** Cache location used before the 0.11.0 upgrade; only reported, never written. */
export function codebaseMemoryLegacyCacheDir(projectRoot) {
  return path.join(codebaseMemoryStateDir(projectRoot), 'cache');
}

/** Freshness stamp written by the runtime wrapper after a successful index. */
export function codebaseMemoryIndexStatePath(projectRoot) {
  return path.join(codebaseMemoryStateDir(projectRoot), 'index-state.json');
}

/**
 * Private per-user root for codebase-memory caches.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
export function codebaseMemoryCacheRoot(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || env.APPDATA || env.USERPROFILE;
    if (!base) throw new Error('codebase-memory-mcp cache root requires LOCALAPPDATA, APPDATA or USERPROFILE.');
    return path.join(base, 'vibe-harness', CODEBASE_MEMORY_TOOL_ID);
  }
  const base = env.XDG_CACHE_HOME || (env.HOME ? path.join(env.HOME, '.cache') : null);
  if (!base) throw new Error('codebase-memory-mcp cache root requires XDG_CACHE_HOME or HOME.');
  return path.join(base, 'vibe-harness', CODEBASE_MEMORY_TOOL_ID);
}

/** Stable, filesystem-safe directory name derived from the project root. */
export function codebaseMemoryProjectSlug(projectRoot, platform = process.platform) {
  const resolved = path.resolve(projectRoot);
  const identity = platform === 'win32' ? resolved.toLowerCase() : resolved;
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 8);
  const readable = identity
    .replace(/^([a-z]):/u, '$1')
    .replace(/[\\/]+/gu, '-')
    .replace(/[^a-z0-9._-]+/giu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .slice(0, CODEBASE_MEMORY_DIRECTORY_SLUG_LIMIT);
  return `${readable || 'project'}-${digest}`;
}

/**
 * Cache directory for one project. An explicit `CBM_CACHE_DIR` always wins, so
 * operators can pin the location; otherwise the per-user private root is used.
 *
 * @param {string} projectRoot
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
export function codebaseMemoryCacheDir(projectRoot, env = process.env, platform = process.platform) {
  const configured = typeof env.CBM_CACHE_DIR === 'string' ? env.CBM_CACHE_DIR.trim() : '';
  if (configured !== '') return path.resolve(configured);
  return path.join(codebaseMemoryCacheRoot(env, platform), codebaseMemoryProjectSlug(projectRoot, platform));
}
