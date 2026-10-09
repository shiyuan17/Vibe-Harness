import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function configuredHookScript(targetDir, configuredPath, event) {
  const configuredRoot = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(targetDir, configuredPath);
  if (path.basename(configuredRoot) === '_' && path.basename(path.dirname(configuredRoot)) === '.husky') {
    return path.join(path.dirname(configuredRoot), event);
  }
  return path.join(configuredRoot, event);
}

async function inspectEntry(targetDir, configuredPath, event) {
  if (!configuredPath) return { activated: false, event, path: null, status: 'inactive' };
  const scriptPath = configuredHookScript(targetDir, configuredPath, event);
  let content;
  try {
    content = await readFile(scriptPath, 'utf8');
  } catch {
    return { activated: false, event, path: path.relative(targetDir, scriptPath).replaceAll('\\', '/'), status: 'missing' };
  }
  const invokesRuntime = /\.agents[\\/]runtime[\\/]hooks[\\/]git-hook\.mjs/iu.test(content)
    && new RegExp('(?:^|[\\s"\'])' + event + '(?:[\\s"\']|$)', 'u').test(content);
  return {
    activated: invokesRuntime,
    event,
    path: path.relative(targetDir, scriptPath).replaceAll('\\', '/'),
    status: invokesRuntime ? 'active' : 'runtime-not-invoked',
  };
}

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
  const entries = {
    preCommit: await inspectEntry(targetDir, configuredPath, 'pre-commit'),
    prePush: await inspectEntry(targetDir, configuredPath, 'pre-push'),
  };
  const active = entries.preCommit.activated && entries.prePush.activated;
  return {
    active,
    configuredPath,
    entries,
    expectedPath,
    status: active ? 'active' : (configuredPath ? 'conflict' : 'inactive'),
  };
}
