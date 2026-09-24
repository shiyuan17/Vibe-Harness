import { execFile } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Default red-zone path patterns. Must equal manifests/red-zone.json
// runtimePaths (the canonical single source); this literal is the fail-safe
// floor shipped inside the installed hook and is used whenever the installed
// projection .agents/runtime/hooks/red-zone.json is missing or unreadable.
// Equivalence is enforced by validateRedZoneDerivations in
// scripts/lib/pack-validation.js. Each entry matches the path itself or any
// descendant (a trailing '/' is optional).
export const DEFAULT_RED_ZONE_PATHS = [
  '.env',
  'auth/',
  'ci/cd/',
  '.github/workflows/',
  '.githooks/',
  'vibe-harness.config.json',
  '.vibe-harness/install-state.json',
  '.agents/runtime/hooks/',
  '.agents/hooks.json',
  '.agents/mcp_config.json',
  '.codex/hooks.json',
  '.codex/config.toml',
  '.cursor/hooks.json',
  '.cursor/mcp.json',
  '.mcp.json',
  '.qoder/settings.json',
  '.zcode/config.json',
  'opencode.json',
  'opencode.jsonc',
  '.claude/settings.json',
];

const RED_ZONE_PROJECTION_PATH = '.agents/runtime/hooks/red-zone.json';

// The installed projection of manifests/red-zone.json. The projection can only
// extend the built-in floor: a missing, invalid, or truncated projection falls
// back to the literal defaults, and the union always keeps every
// DEFAULT_RED_ZONE_PATHS entry, so pack updates add coverage without ever
// silently narrowing it.
async function readProjectedRedZonePaths(rootDir) {
  try {
    const projected = JSON.parse(await readFile(path.join(rootDir, RED_ZONE_PROJECTION_PATH), 'utf8'));
    const paths = projected?.runtimePaths;
    if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
      return [];
    }
    return paths;
  } catch {
    return [];
  }
}

// Control-plane paths are managed state that only the transaction-style
// installers and the runtime CLI write. `.vibe-harness/tasks/` holds the task
// anchors that record unit status, verification receipts and frozen test
// assets, so a direct edit there could silently un-freeze an acceptance
// baseline or fabricate a passed receipt; it is denied like the rest of the
// control plane and stays writable only through `run.mjs task ... --write`.
export const CONTROL_PLANE_PATHS = [
  'vibe-harness.config.json',
  '.vibe-harness/install-state.json',
  '.vibe-harness/tasks/',
  '.agents/runtime/hooks/',
  '.agents/hooks.json',
  '.agents/mcp_config.json',
  '.codex/hooks.json',
  '.codex/config.toml',
  '.cursor/hooks.json',
  '.cursor/mcp.json',
  '.mcp.json',
  '.qoder/settings.json',
  '.zcode/config.json',
  'opencode.json',
  'opencode.jsonc',
  '.claude/settings.json',
];

async function git(rootDir, args) {
  try {
    return (await execFileAsync('git', args, { cwd: rootDir, timeout: 3000, windowsHide: true })).stdout.trim();
  } catch {
    return '';
  }
}

/** @param {string} cwd @param {{gitRoot?: string}} options */
export async function findProjectRoot(cwd, { gitRoot } = {}) {
  const start = path.resolve(cwd);
  // The bootstrap shim already resolved the git root (one git subprocess ago);
  // reuse it when provided so the common hook invocation avoids a second spawn.
  const gitRootFromEnv = typeof gitRoot === 'string' && gitRoot.trim().length > 0
    ? gitRoot
    : process.env.VIBE_HARNESS_GIT_ROOT;
  const gitRootResolved = gitRootFromEnv ? await safeRealpath(gitRootFromEnv) : '';
  const boundary = gitRootResolved ? path.resolve(gitRootResolved) : await gitRootFor(start);
  let current = start;
  while (true) {
    if (await access(path.join(current, 'vibe-harness.config.json')).then(() => true, () => false)) return current;
    if (current === boundary) return boundary;
    const parent = path.dirname(current);
    if (parent === current) return boundary;
    current = parent;
  }
}

async function safeRealpath(candidate) {
  try {
    return await realpath(candidate);
  } catch {
    return '';
  }
}

async function gitRootFor(start) {
  const output = await git(start, ['rev-parse', '--show-toplevel']);
  return output;
}

export async function readProjectConfig(rootDir) {
  try {
    return JSON.parse(await readFile(path.join(rootDir, 'vibe-harness.config.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw Object.assign(new Error('Project configuration is invalid.'), { cause: error });
  }
}

function readAllowedEgressHosts(config) {
  const hosts = config.hooks?.allowedEgressHosts;
  if (hosts === undefined) return [];
  if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== 'string' || host.trim().length === 0)) {
    throw new Error('hooks.allowedEgressHosts must contain non-empty host strings.');
  }
  return hosts;
}

function readPermissionPreset(config) {
  const preset = config.hooks?.permissionPreset;
  if (preset === undefined || preset === null) return null;
  if (typeof preset !== 'string' || preset.trim().length === 0) {
    throw new Error('hooks.permissionPreset must be a non-empty string.');
  }
  return preset.trim();
}

async function readRedZonePaths(rootDir, config) {
  const paths = config.hooks?.redZonePaths;
  if (paths !== undefined
    && (!Array.isArray(paths) || paths.some((entry) => typeof entry !== 'string' || entry.trim().length === 0))) {
    throw new Error('hooks.redZonePaths must contain non-empty path strings.');
  }
  return [...new Set([
    ...DEFAULT_RED_ZONE_PATHS,
    ...await readProjectedRedZonePaths(rootDir),
    ...(paths ?? []),
  ])];
}

export async function readHookSettings(rootDir) {
  try {
    const config = await readProjectConfig(rootDir);
    let state = null;
    try {
      state = JSON.parse(await readFile(path.join(rootDir, '.vibe-harness/install-state.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return {
      allowedWriteRoots: [],
      allowedEgressHosts: readAllowedEgressHosts(config),
      mode: 'guarded',
      permissionPreset: readPermissionPreset(config),
      redZonePaths: await readRedZonePaths(rootDir, config),
      rtkEnabled: Object.hasOwn(config.hooks?.rtk ?? {}, 'enabled') ? config.hooks.rtk.enabled : Boolean(state?.rtkHooksEnabled),
    };
  } catch {
    return { allowedWriteRoots: [], allowedEgressHosts: [], mode: 'guarded', permissionPreset: null, redZonePaths: DEFAULT_RED_ZONE_PATHS, rtkEnabled: false };
  }
}
