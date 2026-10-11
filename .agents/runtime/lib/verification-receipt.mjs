import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { gitFingerprint } from './git-fingerprint.mjs';
import { verificationCwd } from './verification-plan.mjs';

const execute = promisify(execFile);
const RECEIPTS = '.vibe-harness/verification/receipts';
export const VERIFICATION_RECEIPT_SCHEMA_VERSION = 4;
const INPUTS = [
  'vibe-harness.config.json', 'package.json', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
  'pom.xml', 'mvnw', 'mvnw.cmd', '.mvn/wrapper/maven-wrapper.properties',
];

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedReview(review, selectedIds = [], changedPaths = []) {
  const value = review && typeof review === 'object' ? review : {};
  const strings = (list) => (Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.trim()) : []);
  // A cached or hand-supplied review is only evidence while it stays inside the
  // verification it claims to describe: naming checks the plan never selected,
  // or reviewing a check outside the selected set, is an inconsistent claim and
  // is dropped rather than normalized into a plausible-looking `relevant`.
  const claimedSelected = strings(value.selectedCheckIds);
  const consistentSelected = claimedSelected.every((id) => selectedIds.includes(id));
  const selectedCheckIds = claimedSelected.length > 0 && consistentSelected ? claimedSelected : [...selectedIds];
  const reviewedCheckIds = strings(value.reviewedCheckIds).filter((id) => selectedCheckIds.includes(id));
  const claimedStatus = ['relevant', 'unreviewed', 'blocked'].includes(value.status) ? value.status : 'unreviewed';
  const status = claimedStatus === 'relevant' && (reviewedCheckIds.length === 0 || !consistentSelected) ? 'unreviewed' : claimedStatus;
  return {
    status,
    changedPaths: Array.isArray(value.changedPaths) ? value.changedPaths.filter((item) => typeof item === 'string') : [...changedPaths],
    selectedCheckIds,
    ...(reviewedCheckIds.length ? { reviewedCheckIds } : {}),
    reasonCode: typeof value.reasonCode === 'string' && value.reasonCode.trim()
      ? value.reasonCode
      : status === 'relevant' ? 'RELEVANT_CHECK_REVIEWED' : 'REVIEW_NOT_RECORDED',
  };
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
    writeFingerprint: state.writeFingerprint ?? null,
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
  // The write evidence is part of the schema-v4 contract: a run that cannot
  // produce it must not be stored or reused, or a receipt would be replayed
  // against a workspace whose writes were never fingerprinted.
  const writeEvidenceAvailable = typeof state.writeFingerprint === 'string' && state.writeFingerprint.length > 0;
  // Two different questions: whether a run may be *cached* (all inputs fixed
  // and deterministic) and whether it may be *recorded* as provenance for a
  // completion receipt. Recording only needs the workspace evidence the receipt
  // is later checked against, so a non-deterministic or warm run still leaves
  // the durable record a receipt has to match.
  const recordable = state.fingerprint !== null && writeEvidenceAvailable;
  const available = recordable && deterministic && !warm
    && toolsAvailable && !inputs.some(([, value]) => value === 'unreadable');
  return {
    fingerprints, key: digest(fingerprints), available, recordable, snapshot: state,
    reason: !deterministic ? 'checks-not-explicitly-deterministic' : warm ? 'warm-environment-not-attested'
      : !state.fingerprint ? 'snapshot-unavailable' : !writeEvidenceAvailable ? 'write-snapshot-unavailable'
        : !toolsAvailable ? 'toolchain-unavailable' : 'no-matching-receipt',
    selectedIds: commands.map((check) => check.id),
    changedPaths: [...(plan.changedPaths ?? [])],
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
    // Only the current schema is reused: an older receipt was written under a
    // context key that did not include the write evidence, so it can neither be
    // found under the current key nor be proven to describe this workspace.
    const valid = receipt.schemaVersion === VERIFICATION_RECEIPT_SCHEMA_VERSION
      && receipt.status === 'passed' && receipt.snapshotComparison === 'match'
      // Only a record this tool marked reusable may be replayed as a cache hit;
      // a provenance record written for a finalized workspace is not one.
      && receipt.cacheable === true
      && receipt.id && receipt.finishedAt
      && Object.entries(context.fingerprints).every(([key, value]) => receipt[key] === value)
      && JSON.stringify(receipt.selectedChecks) === JSON.stringify(context.selectedIds);
    if (!valid) return { status: 'miss', reason: 'receipt-invalid-or-stale', receipt: null };
    return {
      status: 'hit',
      reason: 'all-input-fingerprints-match',
      receipt: { ...receipt, review: normalizedReview(receipt.review, context.selectedIds, context.changedPaths) },
    };
  } catch {
    return { status: 'miss', reason: 'no-valid-matching-receipt', receipt: null };
  }
}

export async function storeVerificationReceipt(projectDir, context, receipt) {
  if (!context.recordable) return false;
  if (receipt.status !== 'passed' || receipt.snapshotComparison !== 'match') {
    const directory = await receiptDirectory(projectDir);
    if (directory) await rm(path.join(directory, `${context.key}.json`), { force: true });
    return false;
  }
  const directory = await receiptDirectory(projectDir, true);
  if (!directory) return false;
  const summary = {
    schemaVersion: VERIFICATION_RECEIPT_SCHEMA_VERSION, engine: receipt.engine, id: receipt.id, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt,
    status: 'passed', snapshotComparison: 'match', selectedChecks: context.selectedIds, cacheable: context.available === true,
    review: normalizedReview(receipt.review, context.selectedIds, context.changedPaths),
    ...context.fingerprints,
  };
  const temporary = path.join(directory, `${context.key}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(summary)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path.join(directory, `${context.key}.json`));
  return true;
}

/**
 * Match a completion receipt's cited verification against the tool's own record.
 *
 * `--receipt` is caller-supplied JSON, so internal consistency alone cannot
 * establish that the verification ran here or that the checks it names passed:
 * a handcrafted receipt can copy the current head, content and write
 * fingerprints from a real run and then assert `accepted` acceptance for
 * checks that never ran. This reads the durable record `storeVerificationReceipt`
 * wrote and requires the cited verification id to resolve to a record whose
 * fingerprints and selected checks describe the same run. The store is
 * tool-written state, so an unreadable or absent record fails closed.
 */
export async function attestCompletionProvenance(projectDir, receipt) {
  const verification = receipt?.verification;
  const id = typeof verification?.id === 'string' ? verification.id.trim() : '';
  if (!id) return { ok: false, reason: 'receipt-cites-no-verification-id' };
  const directory = await receiptDirectory(projectDir);
  if (!directory) return { ok: false, reason: 'verification-record-store-unavailable' };
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return { ok: false, reason: 'verification-record-store-unreadable' };
  }
  const cited = Array.isArray(verification.acceptance?.selectedCheckIds) ? verification.acceptance.selectedCheckIds : null;
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/u.test(name)) continue;
    const file = path.join(directory, name);
    let record;
    try {
      if ((await lstat(file)).isSymbolicLink()) continue;
      if ((await stat(file)).size > 1024 * 1024) continue;
      record = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (record?.id !== id) continue;
    const problems = [];
    if (record.schemaVersion !== VERIFICATION_RECEIPT_SCHEMA_VERSION) problems.push('record-schema');
    if (record.status !== 'passed' || record.snapshotComparison !== 'match') problems.push('record-status');
    if (record.fingerprint !== verification.fingerprint) problems.push('content-fingerprint');
    if (record.writeFingerprint !== verification.writeFingerprint) problems.push('write-fingerprint');
    if (cited !== null && JSON.stringify(record.selectedChecks) !== JSON.stringify(cited)) problems.push('selected-checks');
    return problems.length === 0
      ? { ok: true, reason: 'recorded-verification-matched', record: name }
      : { ok: false, reason: `recorded-verification-mismatch:${problems.join(',')}`, record: name };
  }
  return { ok: false, reason: 'no-recorded-verification-matches-the-cited-id' };
}

/**
 * Persist a provenance record for a verification whose own workspace is gone.
 *
 * `worktree land` verifies an isolated candidate and then removes it, while the
 * completion receipt it returns describes the primary checkout. The record is
 * therefore written for the workspace the receipt will be validated against,
 * carrying the finalized fingerprints. It is never marked reusable: the
 * evidence it holds was produced by a run in a different directory.
 */
export async function recordFinalVerification(projectDir, verification) {
  const id = typeof verification?.id === 'string' ? verification.id.trim() : '';
  if (!id) return false;
  const directory = await receiptDirectory(projectDir, true);
  if (!directory) return false;
  const record = {
    schemaVersion: VERIFICATION_RECEIPT_SCHEMA_VERSION,
    cacheable: false,
    engine: 'vibe-harness-finalized',
    id,
    status: 'passed',
    snapshotComparison: 'match',
    selectedChecks: Array.isArray(verification.acceptance?.selectedCheckIds) ? verification.acceptance.selectedCheckIds : [],
    fingerprint: verification.fingerprint ?? null,
    writeFingerprint: verification.writeFingerprint ?? null,
    finalizedAt: verification.finalizedAt ?? null,
  };
  const name = `${digest([record.id, record.fingerprint, record.writeFingerprint])}.json`;
  const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path.join(directory, name));
  } catch {
    await rm(temporary, { force: true });
    return false;
  }
  return true;
}
