import { createHash, randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runGit } from './cli-runtime.mjs';
import { resourceFingerprintInput } from './verification-inputs.mjs';
import { gitFingerprint } from './git-fingerprint.mjs';
import { authenticatePushRecord, readAuthenticatedPushRecord, verificationCacheContext } from './verification-receipt.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const transport = new Set(['VIBE_HARNESS_PUSH_PROOF', 'VIBE_HARNESS_MANAGED_PUSH', 'VIBE_HARNESS_VERIFICATION_ID',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_INDEX_FILE', 'GIT_EXEC_PATH', 'GIT_CONFIG_PARAMETERS',
  'GIT_OPTIONAL_LOCKS', 'PWD', 'OLDPWD', 'SHLVL', '_', 'HUSKY', 'HUSKY_GIT_PARAMS']);
const gitShellDefaults = new Set(['HOME', 'MSYSTEM', 'PLINK_PROTOCOL', 'TMPDIR']);
function environmentSnapshot() {
  return Object.fromEntries(Object.entries(process.env).map(([name, value]) =>
    [process.platform === 'win32' ? name.toUpperCase() : name, value])
    .filter(([name]) => !transport.has(name)).sort(([a], [b]) => a.localeCompare(b)));
}
function pathParts(value) {
  return String(value ?? '').split(path.delimiter).filter(Boolean).map((item) =>
    hash(process.platform === 'win32' ? item.replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase() : item));
}
async function layout(projectDir) {
  const common = await runGit(['rev-parse', '--git-common-dir'], projectDir);
  if (!common.ok) throw new Error('push proof requires a Git worktree');
  const directory = realpathSync(path.resolve(projectDir, common.stdout.trim()));
  const store = path.join(directory, 'vibe-harness-push-proofs');
  mkdirSync(store, { recursive: true });
  if (lstatSync(store).isSymbolicLink()) throw new Error('push proof store must not be a link');
  return { directory, store, identity: hash(directory) };
}

/** Freeze the actual branch creation point, using the existing authenticated store. */
export async function recordPushBaseline(projectDir, branch, sha) {
  const head = await runGit(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], projectDir);
  if (!head.ok || head.stdout.trim() !== sha) return false;
  const store = await layout(projectDir);
  const record = await authenticatePushRecord({ schemaVersion: 1, kind: 'push-baseline',
    repository: store.identity, branch, sha });
  if (!record) return false;
  const file = path.join(store.store, `baseline-${hash(branch)}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
  return true;
}

/** A missing target ref does not erase a proven development baseline. */
export async function resolvePushBaseline(projectDir, update) {
  if (!/^0+$/u.test(update.remoteSha)) {
    const known = await runGit(['cat-file', '-e', `${update.remoteSha}^{commit}`], projectDir);
    return known.ok ? update.remoteSha : null;
  }
  if (!update.localRef.startsWith('refs/heads/')) return null;
  try {
    const branch = update.localRef.slice('refs/heads/'.length);
    const store = await layout(projectDir);
    const record = await readAuthenticatedPushRecord(path.join(store.store, `baseline-${hash(branch)}.json`));
    if (record?.kind !== 'push-baseline' || record.repository !== store.identity || record.branch !== branch
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(record.sha ?? '')) return null;
    const ancestor = await runGit(['merge-base', '--is-ancestor', record.sha, update.sha], projectDir);
    return ancestor.ok ? record.sha : null;
  } catch { return null; }
}

async function inputs(candidate, checks) {
  const config = JSON.parse(readFileSync(path.join(candidate, 'vibe-harness.config.json'), 'utf8'));
  const environment = environmentSnapshot();
  const snapshot = await gitFingerprint(candidate);
  if (!snapshot.fingerprint || !snapshot.writeFingerprint || !snapshot.snapshot.head
    || snapshot.snapshot.changes.length) throw new Error('candidate is dirty or unreadable');
  // Use the already sampled HEAD/status; resolve the tree by that immutable
  // object instead of sampling a possibly advanced HEAD a second time.
  const tree = await runGit(['rev-parse', `${snapshot.snapshot.head}^{tree}`], candidate);
  if (!tree.ok) throw new Error('candidate tree unavailable');
  const context = await verificationCacheContext(candidate, { selectedChecks: checks }, snapshot);
  if (!context.inputsAvailable) throw new Error('execution inputs unavailable');
  return { verificationEnvironmentFingerprint: context.fingerprints.environmentFingerprint, values: {
    head: snapshot.snapshot.head, tree: tree.stdout.trim(),
    dependencyFingerprint: context.fingerprints.dependencyFingerprint,
    executionFingerprint: context.fingerprints.executionFingerprint,
    workspaceFingerprint: snapshot.fingerprint, writeFingerprint: snapshot.writeFingerprint,
    configurationFingerprint: hash(config), resourceFingerprint: hash(resourceFingerprintInput(candidate)),
    environmentFingerprint: hash(environment),
    runnerFingerprint: hash({ node: process.version, executable: process.execPath,
      platform: process.platform, arch: process.arch, machine: hostname(), user: userInfo().username }),
    environmentVariables: JSON.stringify(Object.fromEntries(Object.entries(environment).map(([name, value]) => [name, hash(value)]))),
    pathEntries: JSON.stringify(pathParts(environment.PATH)),
    implementationFingerprint: hash(['push-verification.mjs', 'verification-command.mjs', 'verification-risk.mjs',
      'verification-inputs.mjs', 'verification-plan.mjs', 'verification-receipt.mjs',
      'verification-plan-support.mjs', 'cli-runtime.mjs', 'check-resources.mjs', 'git-fingerprint.mjs'].map((file) =>
      readFileSync(new URL(file, import.meta.url), 'utf8'))) } };
}

/** Created only from actual successful checks and a stable final candidate. */
export async function createPushVerification(projectDir, state, verification) {
  if (!['passed', 'ready', 'reused'].includes(verification.status)
    || verification.verification?.snapshotComparison !== 'match'
    || !verification.selectedChecks?.length) return null;
  const checks = verification.selectedChecks.map((id) => ({ id, ...verification.checks[id] }));
  if (checks.some((check) => !['passed', 'reused'].includes(check.status))) return null;
  try {
    const store = await layout(projectDir);
    const { values: currentInputs, verificationEnvironmentFingerprint } = await inputs(state.candidate, checks);
    if (currentInputs.workspaceFingerprint !== verification.verification.fingerprint
      || currentInputs.writeFingerprint !== verification.verification.writeFingerprint
      || currentInputs.executionFingerprint !== verification.verification.executionFingerprint
      || verificationEnvironmentFingerprint !== verification.verification.environmentFingerprint) return null;
    const config = JSON.parse(readFileSync(path.join(state.candidate, 'vibe-harness.config.json'), 'utf8'));
    const declarations = config.validationCommands?.checks ?? [];
    const record = { schemaVersion: 1, id: randomUUID(), kind: 'push-verification',
      repository: store.identity, candidate: realpathSync(state.candidate), batchId: state.id,
      checks: checks.map(({ id, command, cwd }) => ({ id, command, cwd: cwd ?? '.' })),
      reusable: config.verification?.reuse?.enabled !== false
        && checks.every((check) => declarations.some((item) => item.id === check.id && item.deterministic === true)),
      verificationId: verification.verification.id, ...currentInputs,
      createdAt: new Date().toISOString() };
    const signed = await authenticatePushRecord(record);
    if (!signed) return null;
    const file = path.join(store.store, `${record.id}.json`);
    writeFileSync(file, JSON.stringify(signed), { flag: 'wx', mode: 0o600 });
    return record.id;
  } catch { return null; }
}

/** Bind a fresh attempt to an exact endpoint/ref, without rerunning tests. */
export async function preparePushAttempt(projectDir, proofId, endpoint, { fresh = false } = {}) {
  try {
    const proof = await inspectPushVerification(projectDir, proofId);
    if (!proof.ok) return proof;
    if (!fresh && !proof.record.reusable) return { ok: false, code: 'PUSH_PROOF_NOT_REUSABLE' };
    const store = await layout(projectDir);
    const attempt = { ...proof.record, id: randomUUID(), kind: 'push-attempt',
      endpointFingerprint: hash(endpoint.url), ref: endpoint.ref, proofId,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
    delete attempt.mac;
    const signed = await authenticatePushRecord(attempt);
    if (!signed) return { ok: false, code: 'PUSH_PROOF_UNAVAILABLE' };
    writeFileSync(path.join(store.store, `${attempt.id}.json`), JSON.stringify(signed), { flag: 'wx', mode: 0o600 });
    return { ok: true, id: attempt.id };
  } catch { return { ok: false, code: 'PUSH_PROOF_UNAVAILABLE' }; }
}
export async function inspectPushVerification(projectDir, id, update = null) {
  try {
    if (!/^[0-9a-f-]{36}$/iu.test(id ?? '')) return { ok: false, code: 'PUSH_PROOF_MISSING' };
    const store = await layout(projectDir);
    const file = path.join(store.store, `${id}.json`);
    const record = await readAuthenticatedPushRecord(file);
    if (!record || record.id !== id || record.repository !== store.identity || !existsSync(record.candidate)) {
      return { ok: false, code: 'PUSH_PROOF_INVALID' };
    }
    const { values: current } = await inputs(record.candidate, record.checks);
    const changed = Object.keys(current).filter((key) => record[key] !== current[key]);
    if (update && changed.every((key) => ['environmentFingerprint', 'environmentVariables', 'pathEntries'].includes(key))) {
      // Git for Windows starts the native hook through sh: variable names are
      // uppercased and Git's executable directories are prepended to PATH.
      // Accept only those known transport changes. All original input values
      // remain bound; preparePushAttempt already checks the original runner env.
      const before = JSON.parse(record.environmentVariables);
      const after = JSON.parse(current.environmentVariables);
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
      const execPath = await runGit(['--exec-path'], projectDir);
      const gitRoot = execPath.ok ? path.resolve(execPath.stdout.trim(), '../../..') : null;
      const allowedPath = new Set(gitRoot ? [execPath.stdout.trim(), path.join(gitRoot, 'mingw64/bin'),
        path.join(gitRoot, 'mingw32/bin'), path.join(gitRoot, 'usr/bin'), path.join(gitRoot, 'bin'),
        ...(process.platform === 'win32' ? [path.join(userInfo().homedir, 'bin')] : [])]
        .flatMap(pathParts) : []);
      const originalPath = JSON.parse(record.pathEntries);
      const currentPath = JSON.parse(current.pathEntries);
      while (currentPath.length > originalPath.length && allowedPath.has(currentPath[0])) currentPath.shift();
      const compatible = keys.every((key) => before[key] === after[key]
        || (before[key] === undefined && gitShellDefaults.has(key))
        || (key === 'PATH' && JSON.stringify(originalPath) === JSON.stringify(currentPath)));
      if (compatible) changed.length = 0;
    }
    if (changed.length) {
      const before = JSON.parse(record.environmentVariables ?? '{}');
      const after = JSON.parse(current.environmentVariables);
      return { ok: false, code: 'PUSH_PROOF_STALE', changed,
        environmentKeys: [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]) };
    }
    if (update) {
      if (record.kind !== 'push-attempt' || Date.parse(record.expiresAt) < Date.now()
        || record.head !== update.sha || record.ref !== update.ref
        || record.endpointFingerprint !== hash(update.url)) return { ok: false, code: 'PUSH_PROOF_TARGET_MISMATCH' };
      // Exclusive rename makes each attempt consumable at most once.
      renameSync(file, `${file}.consumed`);
    }
    return { ok: true, record };
  } catch { return { ok: false, code: 'PUSH_PROOF_INVALID' }; }
}
