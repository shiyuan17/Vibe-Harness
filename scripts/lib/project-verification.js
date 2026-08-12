import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { assertSafeCommand } from './shell-command.js';
import { maxDiagnosticOutput, redactDiagnosticText } from './tool-provisioning/subprocess.js';

const execFileAsync = promisify(execFile);

function executableFor(program) {
  if (program === 'node') return process.execPath;
  if (process.platform === 'win32' && ['pnpm', 'npm', 'yarn'].includes(program)) return `${program}.cmd`;
  return program;
}

function verificationError(message) {
  const error = new Error(message);
  error.code = 'PROJECT_VERIFICATION_FAILED';
  return error;
}

function verificationOutput(value, targetDir) {
  const sanitized = redactDiagnosticText(value, targetDir);
  return sanitized.length > maxDiagnosticOutput ? sanitized.slice(-maxDiagnosticOutput) : sanitized;
}

async function gitOutput(args, cwd) {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: 1024 * 1024 * 16,
      windowsHide: true,
    });
    return result.stdout;
  } catch {
    return null;
  }
}

function nullSeparatedPaths(value) {
  return String(value ?? '').split('\0').filter(Boolean);
}

async function updatePathHash(hash, rootDir, relativePath) {
  const absolutePath = path.resolve(rootDir, relativePath);
  const relativeCheck = path.relative(rootDir, absolutePath);
  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) return;
  hash.update(relativePath);
  try {
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) hash.update(await readlink(absolutePath));
    else if (metadata.isFile()) hash.update(await readFile(absolutePath));
    else hash.update('non-file');
  } catch {
    hash.update('missing');
  }
}

export async function createProjectSnapshot(targetDir) {
  const rootOutput = await gitOutput(['rev-parse', '--show-toplevel'], targetDir);
  if (!rootOutput) return { available: false, stable: null, vcs: 'none' };
  const [rootDir, resolvedTargetDir] = await Promise.all([
    realpath(rootOutput.trim()),
    realpath(targetDir),
  ]);
  const relativeTarget = path.relative(rootDir, resolvedTargetDir) || '.';
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    return { available: false, stable: null, vcs: 'none' };
  }
  const scopeArgs = relativeTarget === '.'
    ? []
    : ['--', ':(literal)' + relativeTarget.replaceAll('\\', '/')];
  const [headOutput, statusOutput, changedOutput, untrackedOutput] = await Promise.all([
    gitOutput(['rev-parse', '--verify', 'HEAD'], rootDir),
    gitOutput(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...scopeArgs], rootDir),
    gitOutput(['diff', '--name-only', '-z', 'HEAD', ...scopeArgs], rootDir),
    gitOutput(['ls-files', '--others', '--exclude-standard', '-z', ...scopeArgs], rootDir),
  ]);
  if ([headOutput, statusOutput, changedOutput, untrackedOutput].some((value) => value === null)) {
    return { available: false, stable: null, vcs: 'none' };
  }
  const changedPaths = [...new Set([
    ...nullSeparatedPaths(changedOutput),
    ...nullSeparatedPaths(untrackedOutput),
  ])].sort();
  const hash = createHash('sha256');
  const head = headOutput.trim();
  hash.update(head);
  hash.update(statusOutput);
  for (const relativePath of changedPaths) await updatePathHash(hash, rootDir, relativePath);
  return {
    available: true,
    changedFiles: changedPaths.length,
    fingerprint: hash.digest('hex'),
    head,
    vcs: 'git',
  };
}

function verificationFailed(results) {
  return Object.values(results).some((result) => ['blocked', 'failed'].includes(result.status));
}

function verificationFailure(results, commandStatus) {
  const [name, result] = Object.entries(results).find(([, item]) => ['blocked', 'failed'].includes(item.status)) ?? [];
  if (!result) return null;
  if (result.status === 'failed') {
    const detail = result.stderr || result.stdout || 'Verification command failed.';
    return name + ' failed with exit ' + result.exitCode + ': ' + detail;
  }
  if (commandStatus[name]?.status === 'missing') return name + ' is missing: ' + result.command;
  if (commandStatus[name]?.status === 'manual') {
    return name + ' is manual; pass --allow-manual to execute it explicitly: ' + result.command;
  }
  return name + ' is blocked: ' + result.command;
}

export async function runProjectVerification({ allowManual = false, commandStatus, targetDir }) {
  const id = randomUUID();
  const startedAt = new Date();
  const before = await createProjectSnapshot(targetDir);
  const results = await executeProjectVerification({
    allowManual,
    commandStatus,
    failureMode: 'report',
    targetDir,
  });
  const after = await createProjectSnapshot(targetDir);
  const stable = before.available && after.available
    ? before.fingerprint === after.fingerprint
    : before.available === after.available ? null : false;
  const finishedAt = new Date();
  let error;
  if (stable === false) {
    error = {
      code: 'PROJECT_VERIFICATION_STALE',
      message: 'The project changed while verification was running; run verify again on the final state.',
    };
  } else if (verificationFailed(results)) {
    error = {
      code: 'PROJECT_VERIFICATION_FAILED',
      message: verificationOutput(verificationFailure(results, commandStatus), targetDir),
    };
  }
  return {
    ...(error ? { error } : {}),
    ok: !error,
    results,
    verification: {
      after,
      before,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      finishedAt: finishedAt.toISOString(),
      id,
      stable,
      startedAt: startedAt.toISOString(),
    },
  };
}

export async function executeProjectVerification({ allowManual = false, commandStatus, failureMode = 'throw', targetDir }) {
  const order = ['lint', 'typecheck', 'test', 'eval'];
  if (failureMode === 'throw') {
    for (const name of order) {
      const item = commandStatus[name];
      if (!item || item.status === 'not_configured') continue;
      if (item.status === 'missing') throw verificationError(`${name} is missing: ${item.command}`);
      if (item.status === 'manual' && !allowManual) {
        throw verificationError(`${name} is manual; pass --allow-manual to execute it explicitly: ${item.command}`);
      }
    }
  }

  const results = {};
  for (const name of order) {
    const item = commandStatus[name] ?? { command: null, status: 'not_configured' };
    if (item.status === 'not_configured') {
      results[name] = item;
      continue;
    }
    if (item.status === 'missing' || (item.status === 'manual' && !allowManual)) {
      results[name] = { command: item.command, status: 'blocked' };
      continue;
    }
    let program, args;
    try {
      [program, ...args] = assertSafeCommand(item.command);
    } catch (error) {
      if (failureMode === 'report') {
        results[name] = { command: item.command, status: 'blocked' };
        continue;
      }
      throw verificationError(`${name} command is unsafe: ${error.message}`);
    }
    try {
      const result = await execFileAsync(executableFor(program), args, {
        cwd: targetDir,
        maxBuffer: 1024 * 1024 * 8,
        windowsHide: true,
      });
      results[name] = {
        command: item.command,
        exitCode: 0,
        status: 'passed',
        stderr: verificationOutput(result.stderr, targetDir),
        stdout: verificationOutput(result.stdout, targetDir),
      };
    } catch (cause) {
      const exitCode = typeof cause.code === 'number' ? cause.code : 1;
      cause.stderr = verificationOutput(cause.stderr ?? '', targetDir);
      cause.stdout = verificationOutput(cause.stdout ?? '', targetDir);
      cause.message = verificationOutput(cause.message, targetDir);
      if (failureMode === 'report') {
        results[name] = {
          command: item.command,
          exitCode,
          status: 'failed',
          stderr: verificationOutput(cause.stderr ?? '', targetDir),
          stdout: verificationOutput(cause.stdout ?? '', targetDir),
        };
        continue;
      }
      throw verificationError(`${name} failed with exit ${exitCode}: ${cause.stderr || cause.message}`);
    }
  }
  return results;
}

