import { execFile } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { gitFingerprint, gitTreeFingerprint } from './git-fingerprint.mjs';
import { verificationCwd } from './verification-plan.mjs';
import { dependencyFingerprint, resourceFingerprintInput } from './verification-inputs.mjs';

const execute = promisify(execFile);
const RECEIPTS = '.vibe-harness/verification/receipts';
export const VERIFICATION_RECEIPT_SCHEMA_VERSION = 6;
const CHECK_CACHE_RELATIVE = 'vibe-harness/verification-cache/v6';
// The record store lives inside the project it describes, so the caller that
// supplies a handcrafted completion receipt can also write a matching record by
// hand. Each record is therefore authenticated with a per-user key kept outside
// the project: a record without that authentication is not provenance. The key
// is a file only this user can read, which is the strongest boundary available
// without an external secret service; it is created lazily and never leaves the
// machine.
const KEY_DIRECTORY = '.vibe-harness';
const KEY_FILE = 'verification-key.json';
const INPUTS = [
  'vibe-harness.config.json', 'package.json', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
  'pom.xml', 'mvnw', 'mvnw.cmd', '.mvn/wrapper/maven-wrapper.properties',
];

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

let cachedKey;

/**
 * The per-user key that authenticates this tool's own records, or null.
 *
 * Null means the key cannot be held outside the project (no home directory, or
 * it cannot be written), and every record then fails authentication: a store
 * that cannot be authenticated is not provenance, and reporting it as verified
 * would be worse than reporting none.
 */
async function authenticationKey() {
  if (cachedKey !== undefined) return cachedKey;
  let directory;
  try {
    // The account's home is read from the OS rather than through `os.homedir()`,
    // which follows `HOME`/`USERPROFILE`: a caller that redirected the
    // environment could point the key directory inside the project, pre-create a
    // known key file and mint valid records for a handcrafted receipt. An
    // unusable answer is not replaced by a guess — the key is then unavailable,
    // and every unauthenticated record is rejected.
    const account = userInfo();
    if (typeof account?.homedir !== 'string' || account.homedir === '' || !path.isAbsolute(account.homedir)) {
      cachedKey = null;
      return cachedKey;
    }
    directory = path.join(account.homedir, KEY_DIRECTORY);
  } catch {
    cachedKey = null;
    return cachedKey;
  }
  const file = path.join(directory, KEY_FILE);
  const read = async () => {
    try {
      const existing = JSON.parse(await readFile(file, 'utf8'));
      return typeof existing?.key === 'string' && /^[0-9a-f]{64}$/u.test(existing.key) ? existing.key : null;
    } catch {
      return null;
    }
  };
  cachedKey = await read();
  if (cachedKey !== null) return cachedKey;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify({ key: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() })}\n`,
      { flag: 'wx', mode: 0o600 });
  } catch {
    // Another process may have created it between the read and the write.
  }
  cachedKey = await read();
  return cachedKey;
}

/**
 * The bytes a record is authenticated over: everything it carries except the
 * authentication itself, in the order it was written.
 */
function authenticationPayload(record) {
  const { mac, ...rest } = record;
  return JSON.stringify(rest);
}

function authenticate(record, key) {
  return createHmac('sha256', key).update(authenticationPayload(record)).digest('hex');
}

/**
 * True only for a record this user's tool wrote.
 *
 * `readRecord` returns the parsed record for a valid one, or null with the
 * reason it was rejected: an unauthenticated or tampered file is not evidence
 * this process can build a completion claim on.
 */
async function readRecord(file) {
  const record = JSON.parse(await readFile(file, 'utf8'));
  const key = await authenticationKey();
  if (key === null) return { record: null, reason: 'unauthenticated-store' };
  if (typeof record?.mac !== 'string' || record.mac !== authenticate(record, key)) {
    return { record: null, reason: 'record-authentication-mismatch' };
  }
  return { record, reason: null };
}

export async function authenticatePushRecord(record) {
  if (!['push-verification', 'push-attempt'].includes(record?.kind) || record.schemaVersion !== 1) return null;
  const key = await authenticationKey();
  return key ? { ...record, mac: authenticate(record, key) } : null;
}
export async function readAuthenticatedPushRecord(file) {
  if ((await lstat(file)).isSymbolicLink() || (await stat(file)).size > 1024 * 1024) return null;
  return (await readRecord(file)).record;
}

/** The acceptance evidence a completion receipt has to reproduce, or null. */
function acceptanceProjection(acceptance, selectedIds = []) {
  if (acceptance === null || typeof acceptance !== 'object' || Array.isArray(acceptance)) return null;
  const selected = (Array.isArray(acceptance.selectedCheckIds) ? acceptance.selectedCheckIds : [])
    .filter((id) => typeof id === 'string' && id.trim());
  return {
    status: ['accepted', 'blocked', 'unverified'].includes(acceptance.status) ? acceptance.status : 'unverified',
    selectedCheckIds: [...new Set(selected)].sort(),
    finalFingerprint: typeof acceptance.finalFingerprint === 'string' ? acceptance.finalFingerprint : null,
    ...(selected.some((id) => !selectedIds.includes(id)) ? { outsideSelection: true } : {}),
  };
}

/**
 * The review evidence a completion receipt has to reproduce.
 *
 * Only the verdict and the check ids it covers are part of this: they are what
 * `validateCompletion` reads, while the changed paths a review carries describe
 * the plan rather than the decision.
 */
function reviewProjection(review) {
  if (review === null || typeof review !== 'object' || Array.isArray(review)) return null;
  const ids = (value) => [...new Set((Array.isArray(value) ? value : []).filter((id) => typeof id === 'string' && id.trim()))].sort();
  return {
    status: typeof review.status === 'string' ? review.status : 'unreviewed',
    reasonCode: typeof review.reasonCode === 'string' ? review.reasonCode : null,
    selectedCheckIds: ids(review.selectedCheckIds),
    reviewedCheckIds: ids(review.reviewedCheckIds),
    ...(review.status === 'not_required'
      ? { reviewPolicy: review.reviewPolicy ?? null, targetBranch: review.targetBranch ?? null }
      : {}),
  };
}

function sameProjection(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The per-check commands a run reported, keyed by check id.
 *
 * A completion receipt's acceptance entries name a command as their evidence,
 * and a receipt could otherwise cite a recorded check id while replacing that
 * command with a stronger one that never ran. `null` means the run published no
 * per-check data, which is not "any command matches" — it is simply nothing to
 * compare.
 */
function commandEvidence(checks) {
  if (!Array.isArray(checks)) return null;
  const entries = checks
    .filter((check) => check !== null && typeof check === 'object' && typeof check.id === 'string' && check.id !== '')
    .map((check) => [check.id, typeof check.command === 'string' && check.command !== '' ? check.command : null]);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
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
  const claimedStatus = ['relevant', 'unreviewed', 'blocked', 'not_required'].includes(value.status) ? value.status : 'unreviewed';
  const status = claimedStatus === 'relevant' && (reviewedCheckIds.length === 0 || !consistentSelected) ? 'unreviewed' : claimedStatus;
  return {
    status,
    changedPaths: Array.isArray(value.changedPaths) ? value.changedPaths.filter((item) => typeof item === 'string') : [...changedPaths],
    selectedCheckIds,
    ...(reviewedCheckIds.length ? { reviewedCheckIds } : {}),
    reasonCode: typeof value.reasonCode === 'string' && value.reasonCode.trim()
      ? value.reasonCode
      : status === 'relevant' ? 'RELEVANT_CHECK_REVIEWED' : 'REVIEW_NOT_RECORDED',
    ...(status === 'not_required' && value.reviewPolicy === 'none' && value.targetBranch === 'develop'
      ? { reviewPolicy: 'none', targetBranch: 'develop' }
      : {}),
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

/**
 * Create the receipt store before a run takes its first snapshot.
 *
 * The store lives inside the project it describes, so creating it is itself a
 * write to that workspace: `mkdir .vibe-harness` moves the repository root's
 * timestamps, and a store created *after* the first snapshot would leave the run
 * publishing write evidence that no longer describes the workspace it measured —
 * the receipt it stores could then never be reused, not even by an identical run.
 * Only an ignored store is created (the same gate `storeVerificationReceipt`
 * uses); a project that does not ignore it is left untouched.
 *
 * @param {string} projectDir
 * @returns {Promise<boolean>} true once the store directory exists
 */
export async function prepareVerificationReceiptStore(projectDir) {
  return (await receiptDirectory(projectDir, true)) !== null;
}

export async function verificationCacheContext(projectDir, plan, snapshot = undefined) {
  const inputStartedAt = Date.now();
  const state = snapshot ?? await gitFingerprint(projectDir);
  const root = await realpath(projectDir);
  const commands = (plan.selectedChecks ?? []).map((check) => ({
    id: check.id,
    command: check.command,
    cwd: check.cwd ?? '.',
    deterministic: check.deterministic === true,
    cacheScope: check.cacheScope === 'tree' ? 'tree' : 'selection',
  }));
  const inputFiles = [...new Set(['.', ...commands.map((check) => check.cwd)].flatMap((cwd) => INPUTS.map((file) => path.join(cwd, file))))];
  const inputs = await Promise.all(inputFiles.map(async (file) => {
    try { return [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')]; }
    catch (error) { return [file, error.code === 'ENOENT' ? 'missing' : 'unreadable']; }
  }));
  const configBytes = await readFile(path.join(root, 'vibe-harness.config.json'), 'utf8').catch(() => '{}');
  const config = JSON.parse(configBytes);
  const dependencies = dependencyFingerprint(projectDir, config, commands);
  const resourceContext = resourceFingerprintInput(projectDir);
  const reuseMode = config.verification?.reuse?.mode === 'tree-content' ? 'tree-content' : 'workspace';
  // Commands inherit the environment. A legacy allowlist is not evidence that
  // an inherited variable is irrelevant, so v6 fingerprints the complete input.
  const environment = Object.entries(process.env).filter(([name]) => name !== 'VIBE_HARNESS_VERIFICATION_ID')
      .sort(([left], [right]) => left.localeCompare(right));
  const treeContentFingerprint = reuseMode === 'tree-content'
    ? await gitTreeFingerprint(projectDir)
    : null;
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
  // Keep the execution inputs separate from the inherited environment: native
  // Git hooks transform transport variables, but must still check this same
  // dependency/configuration/toolchain identity before consuming a proof.
  const executionInputs = {
    platform: process.platform, arch: process.arch, tools, inputs,
    machine: hostname(), user: userInfo().username,
    dependencies: dependencies.fingerprint,
    resources: resourceContext,
    implementation: createHash('sha256')
      .update(await readFile(new URL(import.meta.url)))
      .update(await readFile(new URL('./verification-plan.mjs', import.meta.url)))
      .update(await readFile(new URL('./verification-command.mjs', import.meta.url)))
      .update(await readFile(new URL('./verification-plan-support.mjs', import.meta.url)))
      .update(await readFile(new URL('./verification-inputs.mjs', import.meta.url)))
      .update(await readFile(new URL('./verification-risk.mjs', import.meta.url)))
      .update(await readFile(new URL('./check-resources.mjs', import.meta.url)))
      .update(await readFile(new URL('./git-fingerprint.mjs', import.meta.url)))
      .digest('hex'),
    provider: config.verification?.environment ?? null,
  };
  const fingerprints = {
    worktreeIdentity: digest(root),
    fingerprint: state.fingerprint,
    treeContentFingerprint,
    writeFingerprint: state.writeFingerprint ?? null,
    planFingerprint: digest({
      checks: commands, tier: plan.executionTier ?? plan.tier ?? 'quick', scope: plan.scope ?? 'layer',
      changedPaths: plan.changedPaths ?? [], baseSha: plan.baseSha ?? null,
      deferredChecks: (plan.deferredChecks ?? []).map((check) => [check.id ?? check.name, check.command, check.cwd ?? '.']),
    }),
    commandSetFingerprint: digest(commands),
    dependencyFingerprint: dependencies.fingerprint,
    executionFingerprint: digest(executionInputs),
    environmentFingerprint: digest({ ...executionInputs, environment }),
  };
  const deterministic = commands.length > 0 && commands.every((check) => check.deterministic);
  const anyDeterministic = commands.some((check) => check.deterministic);
  const warm = config.verification?.environment?.mode === 'warm';
  const enabled = config.verification?.reuse?.enabled !== false;
  const sharedDependencies = resourceContext?.dependencyMode === 'shared-immutable';
  const toolsAvailable = Object.values(tools).every((value) => value !== null) && dependencies.available;
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
  // Even same-workspace reuse requires explicit determinism: matching local
  // inputs cannot establish the state of a mutable external dependency.
  const available = enabled && recordable && deterministic && !warm && (reuseMode !== 'tree-content' || !sharedDependencies)
    && toolsAvailable && !inputs.some(([, value]) => value === 'unreadable')
    && (reuseMode !== 'tree-content' || treeContentFingerprint !== null);
  // The cache key deliberately leaves the write evidence out. The checks a run
  // executes may write on every run — an ignored report such as
  // `.vibe-harness/observed-tests` or a scratch file the run removes again — and
  // a key computed over that evidence would differ from the one the recorded run
  // was stored under, so the receipt could never be reused. The evidence still
  // travels in `fingerprints`, so a hit has to match the exact workspace state the
  // recorded run ended in: a write between two runs still invalidates the reuse,
  // and `attestCompletionProvenance` keeps binding the same value.
  const key = digest({ ...fingerprints, writeFingerprint: null });
  const selectionFingerprint = digest({
    tier: plan.executionTier ?? plan.tier ?? 'quick',
    scope: plan.scope ?? 'layer',
    changedPaths: [...(plan.changedPaths ?? [])].sort(),
    baseSha: plan.baseSha ?? null,
  });
  const commonReuse = {
    mode: reuseMode,
    treeContentFingerprint,
    environmentFingerprint: fingerprints.environmentFingerprint,
    platform: process.platform,
    arch: process.arch,
  };
  const perCheck = commands.map((check) => {
    const checkAvailable = enabled && recordable && check.deterministic && !warm && toolsAvailable
      && (reuseMode !== 'tree-content' || !sharedDependencies)
      && !inputs.some(([, value]) => value === 'unreadable')
      && (reuseMode !== 'tree-content' || treeContentFingerprint !== null);
    const identity = {
      schemaVersion: VERIFICATION_RECEIPT_SCHEMA_VERSION,
      ...commonReuse,
      check: { id: check.id, command: check.command, cwd: check.cwd, cacheScope: check.cacheScope },
      ...(check.cacheScope === 'selection' ? { selectionFingerprint } : {}),
    };
    return {
      ...check,
      ...identity,
      key: digest(identity),
      available: checkAvailable,
      reason: !check.deterministic ? 'check-not-explicitly-deterministic'
        : !recordable ? 'workspace-evidence-unavailable'
          : reuseMode === 'tree-content' && treeContentFingerprint === null ? 'tree-content-unavailable'
            : !toolsAvailable ? 'toolchain-unavailable' : 'no-matching-check-receipt',
    };
  });
  return {
    fingerprints, key, available, recordable, snapshot: state, mode: reuseMode,
    inputsAvailable: toolsAvailable && !inputs.some(([, value]) => value === 'unreadable'),
    inputFingerprintMs: Date.now() - inputStartedAt,
    treeContentFingerprint, perCheck, selectionFingerprint,
    reason: reuseMode === 'tree-content' && !deterministic
      ? anyDeterministic ? 'some-checks-not-explicitly-deterministic' : 'checks-not-explicitly-deterministic'
      : warm ? 'warm-environment-not-attested'
        : !state.fingerprint ? 'snapshot-unavailable' : !writeEvidenceAvailable ? 'write-snapshot-unavailable'
          : !toolsAvailable ? 'toolchain-unavailable'
            : reuseMode === 'tree-content' && treeContentFingerprint === null ? 'tree-content-unavailable'
              : 'no-matching-receipt',
    selectedIds: commands.map((check) => check.id),
    changedPaths: [...(plan.changedPaths ?? [])],
  };
}

async function checkCacheDirectory(projectDir, create = false) {
  try {
    const common = await execute('git', ['rev-parse', '--git-common-dir'], {
      cwd: projectDir, encoding: 'utf8', windowsHide: true,
    });
    const relative = common.stdout.trim();
    if (!relative) return null;
    const base = path.resolve(projectDir, relative);
    const directory = path.join(base, ...CHECK_CACHE_RELATIVE.split('/'));
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    return directory;
  } catch {
    return null;
  }
}

export async function findVerificationCheckReceipt(projectDir, checkContext, { ttlMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  if (!checkContext?.available) {
    return { status: 'miss', reason: checkContext?.reason ?? 'check-context-unavailable', receipt: null };
  }
  const directory = await checkCacheDirectory(projectDir);
  if (!directory) return { status: 'miss', reason: 'check-cache-unavailable', receipt: null };
  try {
    const file = path.join(directory, `${checkContext.key}.json`);
    if ((await lstat(file)).isSymbolicLink()) throw new Error('check receipt is a symbolic link');
    if ((await stat(file)).size > 1024 * 1024) throw new Error('check receipt exceeds size limit');
    const { record } = await readRecord(file);
    if (record === null) return { status: 'miss', reason: 'check-receipt-authentication-failed', receipt: null };
    const finishedAt = Date.parse(record.finishedAt);
    const valid = record.schemaVersion === VERIFICATION_RECEIPT_SCHEMA_VERSION
      && record.cacheable === true
      && record.status === 'passed'
      && record.key === checkContext.key
      && record.treeContentFingerprint === checkContext.treeContentFingerprint
      && record.environmentFingerprint === checkContext.environmentFingerprint
      && record.platform === checkContext.platform
      && record.arch === checkContext.arch
      && JSON.stringify(record.check) === JSON.stringify(checkContext.check)
      && record.selectionFingerprint === (checkContext.selectionFingerprint ?? null)
      && Number.isFinite(finishedAt);
    if (!valid) return { status: 'miss', reason: 'check-receipt-invalid-or-stale', receipt: null };
    if (Date.now() - finishedAt > ttlMs) {
      await rm(file, { force: true }).catch(() => {});
      return { status: 'miss', reason: 'check-receipt-expired', receipt: null };
    }
    return { status: 'hit', reason: 'tree-content-and-inputs-match', receipt: record };
  } catch {
    return { status: 'miss', reason: 'no-matching-check-receipt', receipt: null };
  }
}

export async function storeVerificationCheckReceipt(projectDir, checkContext, { finishedAt = new Date().toISOString() } = {}) {
  if (!checkContext?.available) return false;
  const directory = await checkCacheDirectory(projectDir, true);
  if (!directory) return false;
  const key = await authenticationKey();
  if (key === null) return false;
  const record = {
    schemaVersion: VERIFICATION_RECEIPT_SCHEMA_VERSION,
    key: checkContext.key,
    cacheable: true,
    status: 'passed',
    check: checkContext.check,
    treeContentFingerprint: checkContext.treeContentFingerprint,
    environmentFingerprint: checkContext.environmentFingerprint,
    platform: checkContext.platform,
    arch: checkContext.arch,
    selectionFingerprint: checkContext.selectionFingerprint ?? null,
    finishedAt,
    checkedAt: new Date().toISOString(),
  };
  record.mac = authenticate(record, key);
  const temporary = path.join(directory, `${checkContext.key}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path.join(directory, `${checkContext.key}.json`));
  return true;
}

export async function findVerificationReceipt(projectDir, context) {
  if (!context.available) return { status: 'miss', reason: context.reason, receipt: null };
  const directory = await receiptDirectory(projectDir);
  if (!directory) return { status: 'miss', reason: 'receipt-store-unavailable-or-not-ignored', receipt: null };
  try {
    const file = path.join(directory, `${context.key}.json`);
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Receipt must not be a symbolic link.');
    if ((await stat(file)).size > 1024 * 1024) throw new Error('Receipt exceeds size limit.');
    // An unauthenticated or tampered record is not a cache hit: replaying it
    // would report checks as run that this tool has no record of running.
    const { record: receipt } = await readRecord(file);
    if (receipt === null) return { status: 'miss', reason: 'receipt-authentication-failed', receipt: null };
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

export async function storeVerificationReceipt(projectDir, context, receipt, { checks = null } = {}) {
  if (!context.recordable) return false;
  if (receipt.status !== 'passed' || receipt.snapshotComparison !== 'match') {
    const directory = await receiptDirectory(projectDir);
    if (directory) await rm(path.join(directory, `${context.key}.json`), { force: true });
    return false;
  }
  const directory = await receiptDirectory(projectDir, true);
  if (!directory) return false;
  const key = await authenticationKey();
  if (key === null) return false;
  // The fingerprints stored are the ones the *run* finalized, not the ones it
  // started from: `attestCompletionProvenance` compares them with the completion
  // receipt, which describes the workspace after the checks ran. The pre-run
  // context stays the cache key, which is why a run that wrote to the workspace
  // cannot be replayed against a workspace it did not verify.
  const fingerprint = typeof receipt.fingerprint === 'string' ? receipt.fingerprint : context.fingerprints.fingerprint;
  const writeFingerprint = typeof receipt.writeFingerprint === 'string'
    ? receipt.writeFingerprint : context.fingerprints.writeFingerprint;
  const review = normalizedReview(receipt.review, context.selectedIds, context.changedPaths);
  const summary = {
    schemaVersion: VERIFICATION_RECEIPT_SCHEMA_VERSION, engine: receipt.engine, id: receipt.id, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt,
    status: 'passed', snapshotComparison: 'match', selectedChecks: context.selectedIds, cacheable: context.available === true,
    review,
    // The acceptance is what makes a completion acceptable, so the record has to
    // carry it: without it a caller could cite a real verification and then
    // replace the acceptance that verification produced.
    acceptance: acceptanceProjection(receipt.acceptance, context.selectedIds),
    checks: commandEvidence(checks),
    ...context.fingerprints,
    fingerprint,
    writeFingerprint,
    verifiedTree: receipt.verifiedTree ?? null,
    task: receipt.task ?? null,
  };
  summary.mac = authenticate(summary, key);
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
      // A record this tool did not write is not provenance, whoever wrote it:
      // the store lives in the project, so only the authentication kept outside
      // it separates a real run from a handcrafted file.
      record = (await readRecord(file)).record;
    } catch {
      continue;
    }
    if (record === null) continue;
    if (record?.id !== id) continue;
    const problems = [];
    if (record.schemaVersion !== VERIFICATION_RECEIPT_SCHEMA_VERSION) problems.push('record-schema');
    if (record.status !== 'passed' || record.snapshotComparison !== 'match') problems.push('record-status');
    if (record.fingerprint !== verification.fingerprint) problems.push('content-fingerprint');
    if (record.writeFingerprint !== verification.writeFingerprint) problems.push('write-fingerprint');
    if ((record.verifiedTree ?? null) !== (verification.verifiedTree ?? null)) problems.push('verified-tree');
    if (record.task !== undefined && !sameProjection(record.task, verification.task ?? null)) problems.push('task-binding');
    if (cited !== null && JSON.stringify(record.selectedChecks) !== JSON.stringify(cited)) problems.push('selected-checks');
    // The review and the acceptance are what make a completion *acceptable*, so
    // they are compared with the normalization the record was written under: a
    // receipt may cite a real verification id and fingerprints, but it cannot
    // replace the relevance review or the acceptance that run produced.
    const recordedReview = record.review ?? null;
    const claimedReview = normalizedReview(verification.review, record.selectedChecks ?? [],
      recordedReview?.changedPaths ?? []);
    if (!sameProjection(reviewProjection(claimedReview), reviewProjection(recordedReview))) problems.push('review-evidence');
    if (!sameProjection(acceptanceProjection(verification.acceptance, record.selectedChecks ?? []), record.acceptance ?? null)) {
      problems.push('acceptance-evidence');
    }
    // The command each acceptance entry names is its own evidence, so it has to
    // be the command this run reported for that check: citing a recorded check id
    // with a stronger command that never ran is otherwise invisible here.
    const recordedCommands = record.checks !== null && typeof record.checks === 'object' ? record.checks : null;
    const claimed = (Array.isArray(receipt?.acceptance) ? receipt.acceptance : [])
      .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
    // A run that published no per-check commands cannot bind anything, so a
    // receipt that still claims entries is not provable; and an entry that names
    // a command has to name the recorded one, while an entry that names only a
    // criterion cannot stand in for a check whose command was recorded.
    const unbound = recordedCommands === null
      ? (claimed.length > 0 ? ['acceptance-command-evidence-missing'] : [])
      : claimed
        .filter((item) => (typeof item.command === 'string' && item.command !== ''
          ? recordedCommands[item.id] !== item.command
          : Object.hasOwn(recordedCommands, item.id)))
        .map((item) => item.id);
    if (unbound.length > 0) problems.push(`acceptance-command:${unbound.join('|')}`);
    return problems.length === 0
      ? { ok: true, reason: 'recorded-verification-matched', record: name }
      : { ok: false, reason: `recorded-verification-mismatch:${problems.join(',')}`, record: name };
  }
  return { ok: false, reason: 'no-recorded-verification-matches-the-cited-id' };
}

/**
 * Persist a provenance record for a verification whose own workspace is gone.
 *
 * The worktree delivery flow verifies an isolated candidate and then removes
 * it, while the completion receipt it returns describes the primary checkout.
 * The record is
 * therefore written for the workspace the receipt will be validated against,
 * carrying the finalized fingerprints. It is never marked reusable: the
 * evidence it holds was produced by a run in a different directory.
 */
export async function recordFinalVerification(projectDir, verification, { checks = null } = {}) {
  const id = typeof verification?.id === 'string' ? verification.id.trim() : '';
  if (!id) return false;
  const directory = await receiptDirectory(projectDir, true);
  if (!directory) return false;
  const key = await authenticationKey();
  if (key === null) return false;
  const selectedChecks = Array.isArray(verification.acceptance?.selectedCheckIds) ? verification.acceptance.selectedCheckIds : [];
  const record = {
    schemaVersion: VERIFICATION_RECEIPT_SCHEMA_VERSION,
    cacheable: false,
    engine: 'vibe-harness-finalized',
    id,
    status: 'passed',
    snapshotComparison: 'match',
    selectedChecks,
    // A finalized record is provenance for a receipt that was produced elsewhere,
    // so it has to bind the same review and acceptance evidence that receipt
    // cites — otherwise the record would attest the fingerprints alone and the
    // acceptance could be replaced afterwards.
    review: normalizedReview(verification.review, selectedChecks, []),
    acceptance: acceptanceProjection(verification.acceptance, selectedChecks),
    checks: commandEvidence(checks),
    fingerprint: verification.fingerprint ?? null,
    writeFingerprint: verification.writeFingerprint ?? null,
    verifiedTree: verification.verifiedTree ?? null,
    task: verification.task ?? null,
    finalizedAt: verification.finalizedAt ?? null,
  };
  record.mac = authenticate(record, key);
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
