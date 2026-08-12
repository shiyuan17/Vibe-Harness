import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
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
  '.codex/hooks.json',
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

export async function findProjectRoot(cwd) {
  const start = path.resolve(cwd);
  const gitRoot = await git(start, ['rev-parse', '--show-toplevel']);
  const boundary = gitRoot ? path.resolve(gitRoot) : path.parse(start).root;
  let current = start;
  while (true) {
    if (await access(path.join(current, 'vibe-harness.config.json')).then(() => true, () => false)) return current;
    if (current === boundary) return boundary;
    const parent = path.dirname(current);
    if (parent === current) return boundary;
    current = parent;
  }
}

export async function readProjectConfig(rootDir) {
  try {
    return JSON.parse(await readFile(path.join(rootDir, 'vibe-harness.config.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw Object.assign(new Error('Project configuration is invalid.'), { cause: error });
  }
}

function readAllowedWriteRoots(config) {
  const roots = config.hooks?.allowedWriteRoots;
  if (roots === undefined) return [];
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== 'string' || root.trim().length === 0 || !path.isAbsolute(root))) {
    throw new Error('hooks.allowedWriteRoots must contain non-empty absolute paths.');
  }
  return roots;
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
  return paths;
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
    // Trust config high-sensitivity fields (allowedWriteRoots, allowedEgressHosts)
    // only when the install state proves this project was provisioned by Vibe-Harness.
    // A lone vibe-harness.config.json without a matching install-state is not trusted.
    const trusted = state?.product === 'vibe-harness' && state?.storageNamespace === 'vibe-harness';
    if (!trusted) {
      return { allowedWriteRoots: [], allowedEgressHosts: [], mode: 'guarded', redZonePaths: DEFAULT_RED_ZONE_PATHS, rtkEnabled: false };
    }
    return {
      allowedWriteRoots: readAllowedWriteRoots(config),
      allowedEgressHosts: readAllowedEgressHosts(config),
      mode: ['off', 'observe', 'guarded'].includes(config.hooks?.mode) ? config.hooks.mode : 'guarded',
      redZonePaths: readRedZonePaths(config),
      rtkEnabled: Object.hasOwn(config.hooks?.rtk ?? {}, 'enabled') ? config.hooks.rtk.enabled : Boolean(state?.rtkHooksEnabled),
    };
  } catch {
    return { allowedWriteRoots: [], allowedEgressHosts: [], mode: 'guarded', redZonePaths: DEFAULT_RED_ZONE_PATHS, rtkEnabled: false };
  }
}
