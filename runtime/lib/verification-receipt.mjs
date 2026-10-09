import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { gitFingerprint } from './git-fingerprint.mjs';
import { verificationCwd } from './verification-plan.mjs';

const execute = promisify(execFile);
const RECEIPTS = '.vibe-harness/verification/receipts';
const INPUTS = [
  'vibe-harness.config.json', 'package.json', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
  'pom.xml', 'mvnw', 'mvnw.cmd', '.mvn/wrapper/maven-wrapper.properties',
];

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function version(program, args, cwd) {
  try {
    const windowsShim = process.platform === 'win32' && ['npm', 'pnpm', 'yarn', 'mvn', 'mvnw.cmd', './mvnw.cmd'].includes(program);
    const result = await execute(windowsShim ? 'cmd.exe' : program, windowsShim ? ['/d', '/c', program, ...args] : args, {
      cwd, timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    return digest([result.stdout, result.stderr]);
  } catch {
    return null;
  }
}

async function receiptDirectory(projectDir, create = false) {
  try {
    await execute('git', ['check-ignore', '-q', '--', `${RECEIPTS}/probe.json`], { cwd: projectDir, windowsHide: true });
  } catch {
    return null;
  }
  let current = projectDir;
  for (const segment of RECEIPTS.split('/')) {
    const next = path.join(current, segment);
    if (create) await mkdir(next).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    try {
      verificationCwd(projectDir, path.relative(projectDir, next));
    } catch {
      return null;
    }
    current = next;
  }
  return current;
}

export async function verificationCacheContext(projectDir, plan, snapshot = undefined) {
  const state = snapshot ?? await gitFingerprint(projectDir);
  const root = await realpath(projectDir);
  const commands = (plan.selectedChecks ?? []).map((check) => ({
    id: check.id, command: check.command, cwd: check.cwd ?? '.', deterministic: check.deterministic === true,
  }));
  const inputFiles = [...new Set(['.', ...commands.map((check) => check.cwd)].flatMap((cwd) => INPUTS.map((file) => path.join(cwd, file))))];
  const inputs = await Promise.all(inputFiles.map(async (file) => {
    try { return [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')]; }
    catch (error) { return [file, error.code === 'ENOENT' ? 'missing' : 'unreadable']; }
  }));
  const configBytes = await readFile(path.join(root, 'vibe-harness.config.json'), 'utf8').catch(() => '{}');
  const config = JSON.parse(configBytes);
  const tools = { node: process.version, executable: process.execPath };
  for (const program of ['bun', 'pnpm', 'npm', 'yarn', 'mvn', 'dotnet', 'python', 'java']) {
    const required = config.packageManager?.toLowerCase() === program
      || commands.some((check) => new RegExp(`(?:^|\\s)${program}(?:\\s|$)`, 'u').test(check.command))
      || (program === 'java' && inputs.some(([file, hash]) => path.basename(file) === 'pom.xml' && hash !== 'missing'));
    if (required) tools[program] = await version(program, [program === 'java' ? '-version' : '--version'], projectDir);
  }
  for (const check of commands) {
    const program = check.command.match(/^(?:\.\/)?mvnw(?:\.cmd)?(?=\s|$)/u)?.[0];
    if (program) tools[`${check.cwd}:${program}`] = await version(program, ['--version'], path.join(root, check.cwd));
  }
  const fingerprints = {
    worktreeIdentity: digest(root),
    fingerprint: state.fingerprint,
    planFingerprint: digest({
      checks: commands, tier: plan.executionTier ?? plan.tier ?? 'quick', scope: plan.scope ?? 'layer',
      changedPaths: plan.changedPaths ?? [], baseSha: plan.baseSha ?? null,
      deferredChecks: (plan.deferredChecks ?? []).map((check) => [check.id ?? check.name, check.command, check.cwd ?? '.']),
    }),
    commandSetFingerprint: digest(commands),
    environmentFingerprint: digest({
      platform: process.platform, arch: process.arch, tools, inputs,
      implementation: createHash('sha256')
        .update(await readFile(new URL(import.meta.url)))
        .update(await readFile(new URL('./verification-plan.mjs', import.meta.url)))
        .update(await readFile(new URL('./git-fingerprint.mjs', import.meta.url)))
        .digest('hex'),
      environment: Object.entries(process.env).filter(([name]) => name !== 'VIBE_HARNESS_VERIFICATION_ID').sort(([left], [right]) => left.localeCompare(right)),
      provider: config.verification?.environment ?? null,
    }),
  };
  const deterministic = commands.length > 0 && commands.every((check) => check.deterministic);
  const warm = config.verification?.environment?.mode === 'warm';
  const toolsAvailable = Object.values(tools).every((value) => value !== null);
  const available = state.fingerprint !== null && deterministic && !warm && toolsAvailable && !inputs.some(([, value]) => value === 'unreadable');
  return {
    fingerprints, key: digest(fingerprints), available, snapshot: state,
    reason: !deterministic ? 'checks-not-explicitly-deterministic' : warm ? 'warm-environment-not-attested' : !state.fingerprint ? 'snapshot-unavailable' : !toolsAvailable ? 'toolchain-unavailable' : 'no-matching-receipt',
    selectedIds: commands.map((check) => check.id),
  };
}

export async function findVerificationReceipt(projectDir, context) {
  if (!context.available) return { status: 'miss', reason: context.reason, receipt: null };
  const directory = await receiptDirectory(projectDir);
  if (!directory) return { status: 'miss', reason: 'receipt-store-unavailable-or-not-ignored', receipt: null };
  try {
    const file = path.join(directory, `${context.key}.json`);
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Receipt must not be a symbolic link.');
    if ((await stat(file)).size > 1024 * 1024) throw new Error('Receipt exceeds size limit.');
    const receipt = JSON.parse(await readFile(file, 'utf8'));
    const valid = receipt.schemaVersion === 3 && receipt.status === 'passed' && receipt.snapshotComparison === 'match'
      && receipt.id && receipt.finishedAt
      && Object.entries(context.fingerprints).every(([key, value]) => receipt[key] === value)
      && JSON.stringify(receipt.selectedChecks) === JSON.stringify(context.selectedIds);
    if (!valid) return { status: 'miss', reason: 'receipt-invalid-or-stale', receipt: null };
    return { status: 'hit', reason: 'all-input-fingerprints-match', receipt };
  } catch {
    return { status: 'miss', reason: 'no-valid-matching-receipt', receipt: null };
  }
}

export async function storeVerificationReceipt(projectDir, context, receipt) {
  if (!context.available) return false;
  if (receipt.status !== 'passed' || receipt.snapshotComparison !== 'match') {
    const directory = await receiptDirectory(projectDir);
    if (directory) await rm(path.join(directory, `${context.key}.json`), { force: true });
    return false;
  }
  const directory = await receiptDirectory(projectDir, true);
  if (!directory) return false;
  const summary = {
    schemaVersion: 3, engine: receipt.engine, id: receipt.id, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt,
    status: 'passed', snapshotComparison: 'match', selectedChecks: context.selectedIds,
    ...context.fingerprints,
  };
  const temporary = path.join(directory, `${context.key}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(summary)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path.join(directory, `${context.key}.json`));
  return true;
}
