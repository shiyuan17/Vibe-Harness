import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { assertSafeCommand } from './shell-command.js';
import { maxDiagnosticOutput, redactDiagnosticText } from './tool-provisioning/subprocess.js';

const execFileAsync = promisify(execFile);
export const DEFAULT_PROJECT_VERIFICATION_TIMEOUT_MS = 120_000;
export const MIN_PROJECT_VERIFICATION_TIMEOUT_MS = 1_000;
export const MAX_PROJECT_VERIFICATION_TIMEOUT_MS = 3_600_000;
export const PROJECT_VERIFICATION_ID_ENV = 'VIBE_HARNESS_VERIFICATION_ID';
const packFailureCategories = [
  'capabilityErrors',
  'contentQualityErrors',
  'documentationErrors',
  'instructionBudgetErrors',
  'invalidSkillDirs',
  'leaks',
  'missing',
  'missingSkillInstalls',
  'redZoneConsistencyErrors',
  'schemaErrors',
  'selfInstallErrors',
  'skillGraphErrors',
  'skillMetadataErrors',
];

function executableFor(program) {
  if (program === 'node') return { command: process.execPath, preArgs: [] };
  // Windows npm/pnpm/yarn are .cmd shims that cannot be spawned directly (EINVAL
  // on Node >= 18.20/20.12), so route them through cmd.exe like git-hook.mjs.
  if (process.platform === 'win32' && ['pnpm', 'npm', 'yarn'].includes(program)) {
    return { command: 'cmd.exe', preArgs: ['/c', `${program}.cmd`] };
  }
  return { command: program, preArgs: [] };
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

function boundedDiagnostic(value, targetDir, maxLength = 480) {
  const sanitized = verificationOutput(value, targetDir).replace(/\s+/gu, ' ').trim();
  return sanitized.length > maxLength ? sanitized.slice(0, maxLength - 3) + '...' : sanitized;
}

function normalizedTimeoutMs(timeoutMs) {
  return Number.isInteger(timeoutMs)
    && timeoutMs >= MIN_PROJECT_VERIFICATION_TIMEOUT_MS
    && timeoutMs <= MAX_PROJECT_VERIFICATION_TIMEOUT_MS
    ? timeoutMs
    : DEFAULT_PROJECT_VERIFICATION_TIMEOUT_MS;
}

function terminateVerificationProcess(child) {
  if (!child.pid) {
    child.kill('SIGKILL');
    return Promise.resolve();
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {
      if (!child.killed) child.kill('SIGKILL');
      resolve();
    });
  });
}

function verificationEnvironment(verificationId) {
  const environment = { ...process.env };
  if (verificationId) environment[PROJECT_VERIFICATION_ID_ENV] = verificationId;
  else delete environment[PROJECT_VERIFICATION_ID_ENV];
  return environment;
}

function executeVerificationCommand(file, args, { cwd, signal, timeoutMs, verificationId }) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let cancelled = false;
    let terminationRequested = false;
    const child = execFile(file, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: verificationEnvironment(verificationId),
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: true,
    }, (cause, stdout, stderr) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (!cause) {
        resolve({ stderr, stdout });
        return;
      }
      cause.stderr = stderr;
      cause.stdout = stdout;
      cause.verificationTimedOut = timedOut;
      cause.verificationCancelled = cancelled;
      reject(cause);
    });
    const requestTermination = (kind) => {
      if (terminationRequested) return;
      terminationRequested = true;
      timedOut = kind === 'timeout';
      cancelled = kind === 'cancel';
      void terminateVerificationProcess(child);
    };
    const cancel = () => requestTermination('cancel');
    const timer = setTimeout(() => requestTermination('timeout'), normalizedTimeoutMs(timeoutMs));
    timer.unref();
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
  });
}

function commandFailureResult({ category, cause, command, nextCommand, targetDir, timeoutMs, verificationId }) {
  const timedOut = cause.verificationTimedOut === true;
  const cancelled = cause.verificationCancelled === true || (!timedOut && cause.code === 'ABORT_ERR');
  return {
    command,
    category,
    code: timedOut
      ? 'PROJECT_VERIFICATION_TIMEOUT'
      : cancelled ? 'PROJECT_VERIFICATION_CANCELLED' : 'PROJECT_VERIFICATION_COMMAND_FAILED',
    exitCode: typeof cause.code === 'number' ? cause.code : 1,
    status: 'failed',
    ...(cancelled ? { cancelled: true } : {}),
    ...(timedOut ? { timedOut: true, timeoutMs: normalizedTimeoutMs(timeoutMs) } : {}),
    ...(verificationId ? { verificationId } : {}),
    next: { command: nextCommand },
    stderr: verificationOutput(cause.stderr ?? '', targetDir),
    stdout: verificationOutput(cause.stdout ?? '', targetDir),
  };
}

function installationSample(items, targetDir) {
  return (items ?? []).slice(0, 3).map((item) => boundedDiagnostic(item?.target ?? item, targetDir, 240));
}

export function createVerificationPreflightError({ kind, message, report, targetDir }) {
  const error = verificationError(message);
  if (kind === 'installation') {
    error.details = {
      stage: 'installation',
      summary: {
        changedCount: report?.summary?.changedCount ?? report?.changed?.length ?? 0,
        missingCount: report?.summary?.missingCount ?? report?.missing?.length ?? 0,
        staleProjectionCount: report?.summary?.staleProjectionCount ?? report?.staleProjections?.length ?? 0,
      },
      samples: {
        changed: installationSample(report?.changed, targetDir),
        missing: installationSample(report?.missing, targetDir),
        staleProjections: installationSample(report?.staleProjections, targetDir),
      },
      next: { command: 'vibe-harness validate --project .' },
    };
    return error;
  }

  const failedCategories = packFailureCategories
    .map((name) => [name, report?.[name]])
    .filter(([, items]) => Array.isArray(items) && items.length > 0);
  const categories = failedCategories.slice(0, 6).map(([name, items]) => ({
    count: items.length,
    name,
    samples: items.slice(0, 2).map((item) => boundedDiagnostic(item, targetDir)),
  }));
  error.details = {
    stage: 'pack',
    categories,
    summary: {
      failureCategoryCount: failedCategories.length,
      reportedCategoryCount: categories.length,
    },
    next: { command: 'pnpm check' },
  };
  return error;
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

function verificationEvidence({ commandsPassed, requireStable, stable }) {
  const workspaceStatus = stable === true ? 'verified' : stable === false ? 'changed' : 'unverified';
  const workspaceReason = stable === true
    ? 'Git snapshots match before and after verification.'
    : stable === false
      ? 'Git snapshot evidence changed while verification was running.'
      : 'Git snapshot evidence is unavailable; command success does not prove workspace stability.';
  return {
    commandExecution: {
      status: commandsPassed ? 'passed' : 'failed',
    },
    workspaceStability: {
      proven: stable === true,
      reason: workspaceReason,
      required: requireStable,
      status: workspaceStatus,
    },
  };
}

function verificationFailure(results, commandStatus) {
  const [name, result] = Object.entries(results).find(([, item]) => ['blocked', 'failed'].includes(item.status)) ?? [];
  if (!result) return null;
  if (result.status === 'failed') {
    if (result.code === 'PROJECT_VERIFICATION_TIMEOUT') {
      return name + ' timed out after ' + result.timeoutMs + 'ms; retry with: ' + result.next.command;
    }
    if (result.code === 'PROJECT_VERIFICATION_CANCELLED') {
      return name + ' was cancelled; retry with: ' + result.next.command;
    }
    const detail = result.stderr || result.stdout || 'Verification command failed.';
    return name + ' failed with exit ' + result.exitCode + ': ' + detail;
  }
  if (commandStatus[name]?.status === 'missing') return name + ' is missing: ' + result.command;
  if (commandStatus[name]?.status === 'manual') {
    return name + ' is manual; pass --allow-manual to execute it explicitly: ' + result.command;
  }
  return name + ' is blocked: ' + result.command;
}

export async function runProjectVerification({
  allowManual = false,
  commandStatus,
  requireStable = false,
  signal,
  targetDir,
  timeoutMs = DEFAULT_PROJECT_VERIFICATION_TIMEOUT_MS,
}) {
  const id = randomUUID();
  const startedAt = new Date();
  const before = await createProjectSnapshot(targetDir);
  const results = await executeProjectVerification({
    allowManual,
    commandStatus,
    failureMode: 'report',
    signal,
    verificationId: id,
    targetDir,
    timeoutMs,
  });
  const after = await createProjectSnapshot(targetDir);
  const stable = before.available && after.available
    ? before.fingerprint === after.fingerprint
    : before.available === after.available ? null : false;
  const commandsPassed = !verificationFailed(results);
  const evidence = verificationEvidence({ commandsPassed, requireStable, stable });
  const finishedAt = new Date();
  const hasFinalChange = (before.changedFiles ?? 0) > 0 || (after.changedFiles ?? 0) > 0;
  let error;
  if (stable === false) {
    error = {
      code: 'PROJECT_VERIFICATION_STALE',
      message: 'The project changed while verification was running; run verify again on the final state.',
    };
  } else if (!commandsPassed) {
    error = {
      code: 'PROJECT_VERIFICATION_FAILED',
      message: verificationOutput(verificationFailure(results, commandStatus), targetDir),
    };
  } else if (requireStable && !evidence.workspaceStability.proven) {
    error = {
      code: 'PROJECT_VERIFICATION_STABILITY_UNVERIFIED',
      message: 'Git snapshot evidence is unavailable; command checks passed, but this receipt cannot satisfy a stability-required completion.',
    };
  }
  return {
    ...(error ? { error } : {}),
    ok: !error,
    results,
    verification: {
      after,
      before,
      changeBoundary: {
        resultsAfterFinalChange: hasFinalChange,
        status: hasFinalChange && stable === true && commandsPassed ? 'verified' : 'unverified',
      },
      deliveryBoundaries: {
        ci: 'unverified',
        rollback: 'unverified',
      },
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      evidence,
      finishedAt: finishedAt.toISOString(),
      id,
      recovery: error
        ? { status: 'available', hint: 'pnpm verify --project <path>' }
        : { status: 'not-needed', hint: 'pnpm verify --project <path>' },
      stable,
      startedAt: startedAt.toISOString(),
    },
  };
}

export async function runFocusedProjectVerification({
  focused,
  requireStable = false,
  signal,
  targetDir,
  timeoutMs = DEFAULT_PROJECT_VERIFICATION_TIMEOUT_MS,
}) {
  const id = randomUUID();
  const startedAt = new Date();
  const before = await createProjectSnapshot(targetDir);
  const results = [];
  let stopped = false;
  for (const item of focused.commands) {
    if (stopped) {
      results.push({ ...item, status: 'not_run', verificationId: id });
      continue;
    }
    let program, args;
    try {
      [program, ...args] = assertSafeCommand(item.command);
    } catch {
      results.push({ ...item, status: 'blocked', verificationId: id });
      stopped = true;
      continue;
    }
    try {
      const { command: exec, preArgs } = executableFor(program);
      const result = await executeVerificationCommand(exec, [...preArgs, ...args], {
        cwd: targetDir,
        signal,
        timeoutMs,
        verificationId: id,
      });
      results.push({
        ...item,
        exitCode: 0,
        status: 'passed',
        verificationId: id,
        stderr: verificationOutput(result.stderr, targetDir),
        stdout: verificationOutput(result.stdout, targetDir),
      });
    } catch (cause) {
      results.push({
        ...item,
        ...commandFailureResult({
          category: 'focused-check',
          cause,
          command: item.command,
          nextCommand: 'pnpm verify:focused --run',
          targetDir,
          timeoutMs,
          verificationId: id,
        }),
      });
      stopped = true;
    }
  }
  const after = await createProjectSnapshot(targetDir);
  const stable = before.available && after.available
    ? before.fingerprint === after.fingerprint
    : before.available === after.available ? null : false;
  const finishedAt = new Date();
  const hasFinalChange = (before.changedFiles ?? 0) > 0 || (after.changedFiles ?? 0) > 0;
  const failedResult = results.find((result) => ['blocked', 'failed'].includes(result.status));
  const evidence = verificationEvidence({ commandsPassed: !failedResult, requireStable, stable });
  let error;
  if (stable === false) {
    error = {
      code: 'PROJECT_VERIFICATION_STALE',
      message: 'The project changed while focused verification was running; run verify:focused again on the final state.',
    };
  } else if (failedResult) {
    error = {
      code: 'PROJECT_VERIFICATION_FAILED',
      message: verificationOutput(
        'Focused verification ' + failedResult.status + ': ' + failedResult.command,
        targetDir,
      ),
    };
  } else if (requireStable && !evidence.workspaceStability.proven) {
    error = {
      code: 'PROJECT_VERIFICATION_STABILITY_UNVERIFIED',
      message: 'Git snapshot evidence is unavailable; focused checks passed, but this receipt cannot satisfy a stability-required completion.',
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
      evidence,
      finishedAt: finishedAt.toISOString(),
      focused: {
        changedPaths: [...focused.changedPaths],
        commands: focused.commands.map((item) => ({ ...item })),
        ...(focused.impactMapping ? { impactMapping: focused.impactMapping.map((item) => ({
          source: item.source,
          focused: [...item.focused],
          integration: [...item.integration],
          smoke: [...item.smoke],
        })) } : {}),
        notes: [...focused.notes],
      },
      changeBoundary: {
        resultsAfterFinalChange: hasFinalChange,
        status: hasFinalChange && stable === true && !failedResult ? 'verified' : 'unverified',
      },
      deliveryBoundaries: {
        ci: 'unverified',
        rollback: 'unverified',
      },
      recovery: failedResult
        ? { status: 'available', hint: failedResult.next?.command ?? 'pnpm verify:focused --run' }
        : { status: 'not-needed', hint: 'pnpm verify:focused --run' },
      id,
      stable,
      startedAt: startedAt.toISOString(),
    },
  };
}

export async function executeProjectVerification({
  allowManual = false,
  commandStatus,
  failureMode = 'throw',
  signal,
  targetDir,
  timeoutMs = DEFAULT_PROJECT_VERIFICATION_TIMEOUT_MS,
  verificationId = null,
}) {
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
      results[name] = verificationId ? { ...item, verificationId } : item;
      continue;
    }
    if (item.status === 'missing' || (item.status === 'manual' && !allowManual)) {
      results[name] = { command: item.command, status: 'blocked', ...(verificationId ? { verificationId } : {}) };
      continue;
    }
    let program, args;
    try {
      [program, ...args] = assertSafeCommand(item.command);
    } catch (error) {
      if (failureMode === 'report') {
        results[name] = { command: item.command, status: 'blocked', ...(verificationId ? { verificationId } : {}) };
        continue;
      }
      throw verificationError(`${name} command is unsafe: ${error.message}`);
    }
    try {
      const { command: exec, preArgs } = executableFor(program);
      const result = await executeVerificationCommand(exec, [...preArgs, ...args], {
        cwd: targetDir,
        signal,
        timeoutMs,
        verificationId,
      });
      results[name] = {
        command: item.command,
        exitCode: 0,
        status: 'passed',
        ...(verificationId ? { verificationId } : {}),
        stderr: verificationOutput(result.stderr, targetDir),
        stdout: verificationOutput(result.stdout, targetDir),
      };
    } catch (cause) {
      const exitCode = typeof cause.code === 'number' ? cause.code : 1;
      const failure = commandFailureResult({
        category: name,
        cause,
        command: item.command,
        nextCommand: 'vibe-harness verify --project .',
        targetDir,
        timeoutMs,
        verificationId,
      });
      cause.stderr = verificationOutput(cause.stderr ?? '', targetDir);
      cause.stdout = verificationOutput(cause.stdout ?? '', targetDir);
      cause.message = verificationOutput(cause.message, targetDir);
      if (failureMode === 'report') {
        results[name] = failure;
        continue;
      }
      throw verificationError(`${name} failed with exit ${exitCode}: ${cause.stderr || cause.message}`);
    }
  }
  return results;
}
