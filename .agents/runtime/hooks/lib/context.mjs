import { execFile } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Default red-zone path patterns. Kept in sync with
// scripts/lib/project-config.js defaultProjectConfig.hooks.redZonePaths and the
// previously hard-coded projectRedZonePattern in policy.mjs. Each entry matches
// the path itself or any descendant (a trailing '/' is optional).
export const DEFAULT_RED_ZONE_PATHS = [
  '.env',
  'auth/',
  'ci/cd/',
  '.github/workflows/',
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

export const CONTROL_PLANE_PATHS = [
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

async function git(rootDir, args) {
  try {
    return (await execFileAsync('git', args, { cwd: rootDir, timeout: 3000, windowsHide: true })).stdout.trim();
  } catch {
    return '';
  }
}

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

function readRedZonePaths(config) {
  const paths = config.hooks?.redZonePaths;
  if (paths === undefined) return DEFAULT_RED_ZONE_PATHS;
  if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new Error('hooks.redZonePaths must contain non-empty path strings.');
  }
  return [...new Set([...DEFAULT_RED_ZONE_PATHS, ...paths])];
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
      redZonePaths: readRedZonePaths(config),
      rtkEnabled: Object.hasOwn(config.hooks?.rtk ?? {}, 'enabled') ? config.hooks.rtk.enabled : Boolean(state?.rtkHooksEnabled),
    };
  } catch {
    return { allowedWriteRoots: [], allowedEgressHosts: [], mode: 'guarded', redZonePaths: DEFAULT_RED_ZONE_PATHS, rtkEnabled: false };
  }
}
