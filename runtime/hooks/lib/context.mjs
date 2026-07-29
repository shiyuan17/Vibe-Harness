import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
    if (await access(path.join(current, 'cognis.config.json')).then(() => true, () => false)) return current;
    if (current === boundary) return boundary;
    const parent = path.dirname(current);
    if (parent === current) return boundary;
    current = parent;
  }
}

export async function readProjectConfig(rootDir) {
  try {
    return JSON.parse(await readFile(path.join(rootDir, 'cognis.config.json'), 'utf8'));
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

export async function readHookSettings(rootDir) {
  try {
    const config = await readProjectConfig(rootDir);
    let state = null;
    try {
      state = JSON.parse(await readFile(path.join(rootDir, '.cognis/install-state.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return {
      allowedWriteRoots: readAllowedWriteRoots(config),
      allowedEgressHosts: readAllowedEgressHosts(config),
      mode: ['off', 'observe', 'guarded'].includes(config.hooks?.mode) ? config.hooks.mode : 'guarded',
      rtkEnabled: Object.hasOwn(config.hooks?.rtk ?? {}, 'enabled') ? config.hooks.rtk.enabled : Boolean(state?.rtkHooksEnabled),
    };
  } catch {
    return { allowedWriteRoots: [], allowedEgressHosts: [], mode: 'guarded', rtkEnabled: false };
  }
}
