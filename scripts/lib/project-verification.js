import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { assertSafeCommand } from './shell-command.js';
import { terminateProcessTree } from './process-tree.js';
import { maxDiagnosticOutput, redactDiagnosticText } from './tool-provisioning/subprocess.js';

const execFileAsync = promisify(execFile);
export const DEFAULT_PROJECT_VERIFICATION_TIMEOUT_MS = 120_000;
export const MIN_PROJECT_VERIFICATION_TIMEOUT_MS = 1_000;
export const MAX_PROJECT_VERIFICATION_TIMEOUT_MS = 3_600_000;
const FOCUSED_LONG_RUNNING_TIMEOUT_MS = 300_000;
const MAX_VERIFICATION_OUTPUT_BYTES = 1024 * 1024 * 8;
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

function focusedCommandTimeoutMs(command, timeoutMs) {
  const configured = normalizedTimeoutMs(timeoutMs);
  if (configured !== DEFAULT_PROJECT_VERIFICATION_TIMEOUT_MS) return configured;
  return /^(?:pnpm|npm|yarn)\s+(?:test:integration|smoke:lifecycle)(?:\s|$)/u.test(command)
    ? FOCUSED_LONG_RUNNING_TIMEOUT_MS
    : configured;
}

function terminateVerificationProcess(child) {
  return terminateProcessTree(child);
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
    let outputLimitExceeded = false;
    let terminationRequested = false;
    let settled = false;
    let outputBytes = 0;
    let stdout = '';
    let stderr = '';
    let child;
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    };
    const settle = (cause = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!cause) {
        resolve({ stderr, stdout });
        return;
      }
      cause.stderr = stderr;
      cause.stdout = stdout;
      cause.verificationTimedOut = timedOut;
      cause.verificationCancelled = cancelled;
      cause.verificationOutputLimitExceeded = outputLimitExceeded;
      reject(cause);
    };
    const appendOutput = (stream, chunk) => {
      if (settled || terminationRequested) return;
      outputBytes += chunk.length;
      const text = chunk.toString();
      if (stream === 'stdout') stdout = (stdout + text).slice(-maxDiagnosticOutput);
      else stderr = (stderr + text).slice(-maxDiagnosticOutput);
      if (outputBytes > MAX_VERIFICATION_OUTPUT_BYTES) requestTermination('output');
    };
    const requestTermination = (kind) => {
      if (terminationRequested || settled) return;
      terminationRequested = true;
      timedOut = kind === 'timeout';
      cancelled = kind === 'cancel';
      outputLimitExceeded = kind === 'output';
      void terminateVerificationProcess(child).then(() => {
        if (!settled) {
          const cause = new Error('Verification process did not close after termination.');
          cause.code = 'PROJECT_VERIFICATION_TERMINATION_TIMEOUT';
          settle(cause);
        }
      });
    };
    const cancel = () => requestTermination('cancel');

    child = spawn(file, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: verificationEnvironment(verificationId),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => appendOutput('stdout', chunk));
    child.stderr.on('data', (chunk) => appendOutput('stderr', chunk));
    child.once('error', (cause) => settle(cause));
    child.once('close', (code, signalName) => {
      if (settled) return;
      if (terminationRequested) {
        const cause = new Error('Verification process terminated.');
        cause.code = typeof code === 'number' ? code : 1;
        settle(cause);
        return;
      }
      if (code === 0) {
        settle();
        return;
      }
      const cause = new Error(`Verification process exited with ${signalName ?? code}.`);
      cause.code = typeof code === 'number' ? code : 1;
      settle(cause);
    });
    timer = setTimeout(() => requestTermination('timeout'), normalizedTimeoutMs(timeoutMs));
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
      : cancelled
        ? 'PROJECT_VERIFICATION_CANCELLED'
        : cause.verificationOutputLimitExceeded
          ? 'PROJECT_VERIFICATION_OUTPUT_LIMIT'
          : 'PROJECT_VERIFICATION_COMMAND_FAILED',
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

function ignoredPathsFromStatus(value) {
  return String(value ?? '').split('\0')
    .filter((entry) => entry.startsWith('!! '))
    .map((entry) => entry.slice(3).replaceAll('\\', '/'))
    .filter(Boolean)
    .sort();
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
  if (!rootOutput) return { available: false, vcs: 'none' };
  const [rootDir, resolvedTargetDir] = await Promise.all([
    realpath(rootOutput.trim()),
    realpath(targetDir),
  ]);
  const relativeTarget = path.relative(rootDir, resolvedTargetDir) || '.';
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    return { available: false, vcs: 'none' };
  }
  const scopeArgs = relativeTarget === '.'
    ? []
    : ['--', ':(literal)' + relativeTarget.replaceAll('\\', '/')];
  const [headOutput, statusOutput, ignoredStatusOutput, changedOutput, untrackedOutput] = await Promise.all([
    gitOutput(['rev-parse', '--verify', 'HEAD'], rootDir),
    gitOutput(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...scopeArgs], rootDir),
    gitOutput(['status', '--porcelain=v1', '-z', '--ignored=matching', ...scopeArgs], rootDir),
    gitOutput(['diff', '--name-only', '-z', 'HEAD', ...scopeArgs], rootDir),
    gitOutput(['ls-files', '--others', '--exclude-standard', '-z', ...scopeArgs], rootDir),
  ]);
  if ([headOutput, statusOutput, ignoredStatusOutput, changedOutput, untrackedOutput].some((value) => value === null)) {
    return { available: false, vcs: 'none' };
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
    ignoredPaths: ignoredPathsFromStatus(ignoredStatusOutput),
    ignoredContentHashed: false,
    vcs: 'git',
  };
}

function verificationFailed(results) {
  return Object.values(results).some((result) => ['blocked', 'failed'].includes(result.status));
}

function hasConfiguredChecks(commandStatus) {
  return Object.values(commandStatus ?? {}).some((item) => item && item.status !== 'not_configured');
}

function verificationEvidence({ commandsPassed, requireStable, snapshotComparison }) {
  const workspaceReason = snapshotComparison === 'match'
    ? 'Git snapshots match before and after verification.'
    : snapshotComparison === 'changed'
      ? 'Git snapshot evidence changed while verification was running.'
      : 'Git snapshot evidence is unavailable; command success does not prove workspace stability.';
  return {
    commandExecution: {
      status: commandsPassed ? 'passed' : 'failed',
    },
    snapshotComparison: {
      value: snapshotComparison,
      reason: workspaceReason,
      required: requireStable,
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
  const snapshotComparison = before.available && after.available
    ? before.fingerprint === after.fingerprint
      ? 'match' : 'changed'
    : before.available === after.available ? 'unavailable' : 'changed';
  const checksConfigured = hasConfiguredChecks(commandStatus);
  const commandsPassed = checksConfigured && !verificationFailed(results);
  const evidence = verificationEvidence({ commandsPassed, requireStable, snapshotComparison });
  const finishedAt = new Date();
  const hasFinalChange = (before.changedFiles ?? 0) > 0 || (after.changedFiles ?? 0) > 0;
  let error;
  if (snapshotComparison === 'changed') {
    error = {
      code: 'PROJECT_VERIFICATION_STALE',
      message: 'The project changed while verification was running; run verify again on the final state.',
    };
  } else if (!checksConfigured) {
    error = {
      code: 'PROJECT_VERIFICATION_NO_CHECKS',
      message: 'No project validation commands are configured; configure at least one check before claiming verification.',
    };
  } else if (!commandsPassed) {
    error = {
      code: 'PROJECT_VERIFICATION_FAILED',
      message: verificationOutput(verificationFailure(results, commandStatus), targetDir),
    };
  } else if (requireStable && snapshotComparison !== 'match') {
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
      schemaVersion: 2,
      after,
      before,
      changeBoundary: {
        resultsAfterFinalChange: hasFinalChange,
        status: hasFinalChange && snapshotComparison === 'match' && commandsPassed ? 'verified' : 'unverified',
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
      snapshotComparison,
      startedAt: startedAt.toISOString(),
    },
  };
}

export async function runFocusedProjectVerification({
  allowManual = false,
  focused,
  requireStable = false,
  signal = undefined,
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
    if (item.status === 'missing' || (item.status === 'manual' && !allowManual)) {
      results.push({
        ...item,
        status: 'blocked',
        verificationId: id,
        next: { command: 'pnpm verify --project .' },
      });
      stopped = true;
      continue;
    }
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
        timeoutMs: focusedCommandTimeoutMs(item.command, timeoutMs),
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
          timeoutMs: focusedCommandTimeoutMs(item.command, timeoutMs),
          verificationId: id,
        }),
      });
      stopped = true;
    }
  }
  const after = await createProjectSnapshot(targetDir);
  const snapshotComparison = before.available && after.available
    ? before.fingerprint === after.fingerprint
      ? 'match' : 'changed'
    : before.available === after.available ? 'unavailable' : 'changed';
  const finishedAt = new Date();
  const hasFinalChange = (before.changedFiles ?? 0) > 0 || (after.changedFiles ?? 0) > 0;
  const failedResult = results.find((result) => ['blocked', 'failed'].includes(result.status));
  const evidence = verificationEvidence({ commandsPassed: !failedResult, requireStable, snapshotComparison });
  let error;
  if (snapshotComparison === 'changed') {
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
  } else if (focused.commands.length === 0) {
    error = {
      code: 'PROJECT_VERIFICATION_NO_CHECKS',
      message: 'No applicable verification checks were selected; configure a matching check or run with --full.',
    };
    evidence.commandExecution.status = 'blocked';
  } else if (requireStable && snapshotComparison !== 'match') {
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
      schemaVersion: 2,
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
        status: hasFinalChange && snapshotComparison === 'match' && !failedResult ? 'verified' : 'unverified',
      },
      deliveryBoundaries: {
        ci: 'unverified',
        rollback: 'unverified',
      },
      recovery: failedResult
        ? { status: 'available', hint: failedResult.next?.command ?? 'pnpm verify:focused --run' }
        : { status: 'not-needed', hint: 'pnpm verify:focused --run' },
      id,
      snapshotComparison,
      startedAt: startedAt.toISOString(),
    },
  };
}

export async function runVerificationPlan({
  allowManual = false,
  commandStatus = {},
  plan,
  signal = undefined,
  targetDir,
  timeoutMs = DEFAULT_PROJECT_VERIFICATION_TIMEOUT_MS,
}) {
  const focused = await runFocusedProjectVerification({
    allowManual,
    focused: {
      changedPaths: plan.changedPaths ?? [],
      commands: plan.selectedChecks ?? [],
      notes: plan.selectionReasons ?? [],
      impactMapping: plan.impactMapping,
    },
    requireStable: false,
    signal,
    targetDir,
    timeoutMs,
  });
  focused.results = (focused.results ?? []).map((item) => ({
    ...item,
    ...(item.category === 'focused-check' ? { category: item.id ?? item.command } : {}),
    ...(item.next?.command === 'pnpm verify:focused --run'
      ? { next: { ...item.next, command: 'vibe-harness verify --project .' } }
      : {}),
  }));
  const results = Object.fromEntries((focused.results ?? []).map((item) => [item.id ?? item.command, item]));
  const selectedIds = new Set((plan.selectedChecks ?? []).map((item) => item.id ?? item.command));
  for (const [name, item] of Object.entries(commandStatus ?? {})) {
    if (selectedIds.has(name) || Object.hasOwn(results, name)) continue;
    results[name] = {
      ...item,
      status: item.status === 'not_configured' ? 'not_configured' : 'not_selected',
      verificationId: focused.verification.id,
    };
  }
  if ((plan.selectedChecks ?? []).length === 0) {
    focused.ok = false;
    focused.error = {
      code: 'PROJECT_VERIFICATION_NO_CHECKS',
      message: 'No applicable verification checks were selected; configure a matching check or run with --full.',
    };
    focused.verification.evidence.commandExecution = { status: 'blocked' };
    focused.verification.recovery = { status: 'available', hint: 'pnpm verify --project <path> --full' };
  } else if (!focused.ok) {
    const failed = focused.results.find((item) => ['blocked', 'failed'].includes(item.status));
    if (failed) {
      const name = failed.id ?? failed.command;
      const retryCommand = failed.next?.command === 'pnpm verify:focused --run'
        ? 'vibe-harness verify --project .'
        : (failed.next?.command ?? 'pnpm verify --project .');
      let message = `Focused verification ${failed.status}: ${failed.command}`;
      if (failed.status === 'failed') {
        if (failed.code === 'PROJECT_VERIFICATION_TIMEOUT') {
          message = `${name} timed out after ${failed.timeoutMs}ms; retry with: ${retryCommand}`;
        } else if (failed.code === 'PROJECT_VERIFICATION_CANCELLED') {
          message = `${name} was cancelled; retry with: ${retryCommand}`;
        } else {
          message = `${name} failed with exit ${failed.exitCode}: ${failed.stderr || failed.stdout || 'Verification command failed.'}`;
        }
      } else if (commandStatus[name]?.status === 'missing') {
        message = `${name} is missing: ${failed.command}`;
      } else if (commandStatus[name]?.status === 'manual') {
        message = `${name} is manual; pass --allow-manual to execute it explicitly: ${failed.command}`;
      }
      focused.error = { code: 'PROJECT_VERIFICATION_FAILED', message: verificationOutput(message, targetDir) };
    }
  }
  return {
    ...focused,
    results,
    verification: {
      ...focused.verification,
      riskLevel: plan.riskLevel,
      planMode: plan.planMode,
      impactGroups: [...(plan.impactGroups ?? [])],
      selectedChecks: (plan.selectedChecks ?? []).map((item) => ({ ...item })),
      skippedChecks: (plan.skippedChecks ?? []).map((item) => ({ ...item })),
      fallbackUsed: plan.fallbackUsed === true,
      selectionReasons: [...(plan.selectionReasons ?? [])],
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
