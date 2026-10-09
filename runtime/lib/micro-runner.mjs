import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION = '1';
const ENTRY = /^[\w./-]+\.m?js$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/u;
const FORBIDDEN_ENV = /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|SESSION|^NODE_OPTIONS$|^NODE_PATH$|^LD_|^DYLD_)/iu;
const FORBIDDEN_SOURCE = /(?:\b(?:fetch|WebSocket|XMLHttpRequest|eval)\s*\(|\bimport\s*\(|\brequire\s*\(|\bprocess\s*\.\s*(?:binding|dlopen)|\b(?:node:)?(?:net|http|https|tls|dgram|child_process|worker_threads)\b)/u;

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function blocked(checkId, code) {
  return { schemaVersion: 1, id: randomUUID(), checkId, status: 'blocked', code };
}

async function restrictedPath(root, relative) {
  if (typeof relative !== 'string' || !ENTRY.test(relative) && !/^[\w./-]+\.json$/u.test(relative)
    || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('MICRO_INVALID_PATH');
  const resolved = await realpath(path.join(root, relative));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error('MICRO_PATH_ESCAPE');
  return resolved;
}

async function stop(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  } else {
    try { child.kill('SIGKILL'); } catch { /* already stopped */ }
  }
}

async function execute(check, root, entry, fixture) {
  const workerPath = fileURLToPath(import.meta.url);
  const permissions = ['--permission', `--allow-fs-read=${workerPath}`, `--allow-fs-read=${entry}`];
  if (fixture) permissions.push(`--allow-fs-read=${fixture}`);
  const environment = { NODE_ENV: 'test' };
  for (const name of check.allowedEnv ?? []) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  const child = spawn(process.execPath, [...permissions, workerPath, '--worker', entry], {
    cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let overflow = false;
  const limit = check.maxOutputBytes ?? 8192;
  const append = (key, chunk) => {
    if (overflow) return;
    const remaining = Math.max(0, limit - stdout.length - stderr.length);
    if (key === 'stdout') stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
    else stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
    if (chunk.length > remaining) {
      overflow = true;
      void stop(child);
    }
  };
  child.stdout.on('data', (chunk) => append('stdout', chunk));
  child.stderr.on('data', (chunk) => append('stderr', chunk));
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ args: check.args ?? {}, kind: check.kind }));
  const outcome = await new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void stop(child).then(() => finish({ status: 'blocked', code: 'MICRO_TIMEOUT' }));
    }, check.maxDurationMs ?? 5000);
    child.once('error', () => finish({ status: 'blocked', code: 'MICRO_EXECUTION_ERROR' }));
    child.once('close', (exitCode) => {
      if (timedOut) finish({ status: 'blocked', code: 'MICRO_TIMEOUT', exitCode });
      else if (overflow) finish({ status: 'blocked', code: 'MICRO_OUTPUT_LIMIT', exitCode });
      else finish({ status: (check.expectedExitCodes ?? [0]).includes(exitCode) ? 'passed' : 'failed', exitCode });
    });
  });
  return {
    ...outcome,
    outputSummary: { stdoutFingerprint: digest(stdout), stderrFingerprint: digest(stderr), bytes: stdout.length + stderr.length },
  };
}

export async function runMicroCheck(projectDir, declared, checkId, { planOnly, scope, snapshot }) {
  if (!Array.isArray(declared)) return blocked(checkId, 'MICRO_NOT_DECLARED');
  const matches = declared.filter((item) => item?.id === checkId);
  if (matches.length !== 1) return blocked(checkId, 'MICRO_NOT_DECLARED');
  const check = matches[0];
  if (check.command || !['module', 'rule', 'pure'].includes(check.kind) || !check.entry
    || check.network !== undefined && check.network !== 'deny'
    || check.workspaceWrite !== undefined && check.workspaceWrite !== 'deny'
    || !Array.isArray(check.allowedEnv ?? [])
    || (check.allowedEnv ?? []).some((name) => !ENV_NAME.test(name) || FORBIDDEN_ENV.test(name))
    || !Number.isInteger(check.maxDurationMs ?? 5000) || (check.maxDurationMs ?? 5000) < 1
    || (check.maxDurationMs ?? 5000) > 120000
    || !Number.isInteger(check.maxOutputBytes ?? 8192) || (check.maxOutputBytes ?? 8192) < 256
    || (check.maxOutputBytes ?? 8192) > 1048576
    || check.args === null || typeof (check.args ?? {}) !== 'object' || Array.isArray(check.args)
    || check.kind === 'rule' && !check.args?.fixture
    || (check.scopes && (!Array.isArray(check.scopes) || !check.scopes.includes(scope)))) {
    return blocked(checkId, 'MICRO_INVALID_DECLARATION');
  }
  if (Number(process.versions.node.split('.')[0]) < 22) return blocked(checkId, 'MICRO_UNSUPPORTED_ENVIRONMENT');
  try {
    const root = await realpath(projectDir);
    if (!ENTRY.test(check.entry)) return blocked(checkId, 'MICRO_INVALID_PATH');
    if (check.args?.fixture && !check.args.fixture.endsWith('.json')) return blocked(checkId, 'MICRO_INVALID_PATH');
    const entry = await restrictedPath(root, check.entry);
    const fixture = check.args?.fixture ? await restrictedPath(root, check.args.fixture) : null;
    const source = await readFile(entry, 'utf8');
    if (FORBIDDEN_SOURCE.test(source)) return blocked(checkId, 'MICRO_UNSAFE_ENTRY');
    const fixtureFingerprint = fixture ? digest(await readFile(fixture)) : null;
    const before = await snapshot();
    if (!before.fingerprint) return blocked(checkId, 'MICRO_SNAPSHOT_UNAVAILABLE');
    const base = {
      schemaVersion: 1, id: randomUUID(), checkId, scope,
      riskLevel: 'quick', workspaceFingerprint: before.fingerprint,
      configFingerprint: digest(check), fixtureFingerprint,
      toolchainFingerprint: digest({ node: process.version, platform: process.platform }),
      inputSummary: { argsFingerprint: digest(check.args ?? {}) },
      cache: { status: 'not_requested' },
      escalation: { required: true, nextTier: 'unit' },
    };
    if (planOnly) return { ...base, status: 'planned', snapshotComparison: 'unknown' };
    const started = Date.now();
    const result = await execute(check, root, entry, fixture);
    const after = await snapshot();
    const snapshotComparison = before.fingerprint === after.fingerprint && after.fingerprint !== null ? 'match' : 'changed';
    return {
      ...base, ...result, durationMs: Date.now() - started, snapshotComparison,
      status: snapshotComparison === 'match' ? result.status : 'blocked',
      ...(snapshotComparison === 'match' ? {} : { code: 'MICRO_WORKSPACE_CHANGED' }),
    };
  } catch {
    return blocked(checkId, 'MICRO_ENTRY_UNAVAILABLE');
  }
}

if (process.argv[2] === '--worker') {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const imported = await import(pathToFileURL(process.argv[3]).href);
    const handler = imported.default ?? imported.run ?? imported.verify;
    if (typeof handler !== 'function') throw new Error('No Micro handler');
    const output = await handler(payload.args, payload);
    process.stdout.write(JSON.stringify({ output: output ?? null }));
  } catch {
    process.stderr.write('Micro check failed');
    process.exitCode = 1;
  }
}
