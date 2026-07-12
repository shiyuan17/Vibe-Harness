import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function inspectGitHooks(targetDir) {
  let configuredPath = null;
  try {
    configuredPath = (await execFileAsync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd: targetDir,
      windowsHide: true,
    })).stdout.trim() || null;
  } catch {
    configuredPath = null;
  }
  const expectedPath = '.githooks';
  const normalized = configuredPath?.replaceAll('\\', '/').replace(/\/$/u, '');
  const absoluteExpected = path.resolve(targetDir, expectedPath).replaceAll('\\', '/');
  const active = normalized === expectedPath || normalized === absoluteExpected;
  return {
    active,
    configuredPath,
    expectedPath,
    status: active ? 'active' : (configuredPath ? 'conflict' : 'inactive'),
  };
}
