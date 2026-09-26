import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SECRET = /((?:api[-_]?key|authorization|token|password|secret|cookie)\s*[=:]\s*)[^\s,;]+/giu;
const RUNNER_VERSION = '1';

export function redactMicro(value, limit = 8192) {
  return String(value ?? '').replace(SECRET, '$1[REDACTED]').slice(0, limit);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function microFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

async function worker(entry, input) {
  const modulePath = path.resolve(process.cwd(), entry);
  const imported = await import(pathToFileURL(modulePath).href);
  const handler = imported.default ?? imported.run ?? imported.verify;
  if (typeof handler !== 'function') throw new Error('Micro entry must export a default, run, or verify function');
  const output = await handler(input.args ?? input, input);
  process.stdout.write(JSON.stringify({ output: output ?? null }));
}

function killTree(child) {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      killer.once('close', resolve);
      killer.once('error', resolve);
    });
  }
  try { child.kill('SIGTERM'); } catch {}
  return Promise.resolve();
}

/** @param {any} check @param {string} targetDir @param {any} options */
export async function executeStructuredMicro(check, targetDir, { snapshotBefore, snapshotAfter, captureSnapshotAfter } = {}) {
  const startedAt = Date.now();
  const runnerPath = fileURLToPath(import.meta.url);
  const input = JSON.stringify({ kind: check.kind, args: check.args ?? {}, fixture: check.args?.fixture ?? null });
  const env = { NODE_ENV: 'test', ...Object.fromEntries((check.allowedEnv ?? []).filter((name) => process.env[name]).map((name) => [name, process.env[name]])) };
  const child = spawn(process.execPath, [runnerPath, '--worker', check.entry], {
    cwd: targetDir,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let overflow = false;
  const append = (key, chunk) => {
    const next = (key === 'stdout' ? stdout : stderr) + String(chunk);
    if (Buffer.byteLength(next) > check.maxOutputBytes) overflow = true;
    const bounded = Buffer.from(next).subarray(-check.maxOutputBytes).toString();
    if (key === 'stdout') stdout = bounded; else stderr = bounded;
  };
  child.stdout.on('data', (chunk) => append('stdout', chunk));
  child.stderr.on('data', (chunk) => append('stderr', chunk));
  child.stdin.end(input);
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(async () => {
      await killTree(child);
      finish({ status: 'blocked', code: 'MICRO_TIMEOUT' });
    }, check.maxDurationMs);
    child.once('error', (error) => { clearTimeout(timer); finish({ status: 'blocked', code: 'MICRO_EXECUTION_ERROR', error: error.message }); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (overflow) return finish({ status: 'blocked', code: 'MICRO_OUTPUT_LIMIT', exitCode, signal });
      const expected = (check.expectedExitCodes ?? [0]).includes(exitCode);
      finish({ status: expected ? 'passed' : 'failed', exitCode, signal });
    });
  });
  const after = snapshotAfter ?? (captureSnapshotAfter ? await captureSnapshotAfter() : null);
  const snapshotComparison = snapshotBefore?.available && after?.available
    ? snapshotBefore.fingerprint === after.fingerprint ? 'match' : 'changed'
    : 'unavailable';
  if (result.status === 'passed' && snapshotComparison !== 'match') result.status = 'blocked';
  return {
    schemaVersion: 1,
    id: randomUUID(),
    checkId: check.id,
    status: result.status,
    inputSummary: { argsFingerprint: microFingerprint(check.args ?? {}) },
    outputSummary: { stdout: redactMicro(stdout, check.maxOutputBytes), stderr: redactMicro(stderr, check.maxOutputBytes) },
    durationMs: Date.now() - startedAt,
    exitCode: result.exitCode ?? null,
    ...(result.code ? { code: result.code } : {}),
    workspaceFingerprint: snapshotBefore?.fingerprint ?? null,
    snapshotComparison,
    runnerVersion: RUNNER_VERSION,
  };
}

if (process.argv[2] === '--worker') {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    await worker(process.argv[3], input);
  } catch (error) {
    process.stderr.write(redactMicro(error?.stack ?? error?.message ?? error));
    process.exitCode = 1;
  }
}
