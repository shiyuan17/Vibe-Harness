import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
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
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  return root ? path.resolve(root) : path.resolve(cwd);
}

export async function readHookSettings(rootDir) {
  try {
    const config = JSON.parse(await readFile(path.join(rootDir, 'loopengine.config.json'), 'utf8'));
    const mode = ['off', 'observe', 'guarded', 'strict'].includes(config.hooks?.mode)
      ? config.hooks.mode
      : 'guarded';
    const completionGate = ['off', 'advisory', 'blocking'].includes(config.hooks?.completionGate)
      ? config.hooks.completionGate
      : 'advisory';
    return { completionGate, mode, validationCommands: config.validationCommands ?? {} };
  } catch {
    return { completionGate: 'advisory', mode: 'guarded', validationCommands: {} };
  }
}

async function taskSummary(rootDir) {
  const taskDir = path.join(rootDir, 'docs', 'tasks');
  try {
    const names = (await readdir(taskDir)).filter((name) => name.endsWith('.md')).sort().slice(0, 10);
    return names.length > 0 ? names.join(', ') : 'none';
  } catch {
    return 'none';
  }
}

export async function buildProjectContext(rootDir) {
  const [branch, status, tasks] = await Promise.all([
    git(rootDir, ['branch', '--show-current']),
    git(rootDir, ['status', '--short']),
    taskSummary(rootDir),
  ]);
  const statusLines = status ? status.split(/\r?\n/u).slice(0, 20) : [];
  return [
    `Project root: ${rootDir}`,
    `Git branch: ${branch || '(detached or unavailable)'}`,
    `Working tree: ${statusLines.length === 0 ? 'clean' : `${statusLines.length} changed path(s)`}`,
    `Task files: ${tasks}`,
    'Use repository rules and verify current filesystem state before acting.',
  ].join('\n');
}

export async function runGovernanceCheck(rootDir) {
  const validator = path.join(rootDir, '.agents', 'loopengine', 'governance', 'validate.mjs');
  try {
    await execFileAsync(process.execPath, [validator], {
      cwd: rootDir,
      timeout: 15000,
      windowsHide: true,
    });
    return { ok: true };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, skipped: true };
    return { ok: false };
  }
}
