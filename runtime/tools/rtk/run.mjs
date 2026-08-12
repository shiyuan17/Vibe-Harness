import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { prepareRtkRuntimeEnvironment } from '../../lib/rtk-environment.mjs';

const VERSION = '0.45.0';
const BASE_URL = `https://github.com/rtk-ai/rtk/releases/download/v${VERSION}`;
const ASSETS = {
  'darwin-arm64': { name: 'rtk-aarch64-apple-darwin.tar.gz', sha256: '064151cfc2d50b24d810b06a0af2e41b9c945e83534e4c438c3d3eae607fc3f4' },
  'darwin-x64': { name: 'rtk-x86_64-apple-darwin.tar.gz', sha256: '9ea02f889d5a2779e4fb700df4587824303c5a57cda22e903e30058079fca0ef' },
  'linux-arm64': { name: 'rtk-aarch64-unknown-linux-gnu.tar.gz', sha256: '80a746dd305ef944ff50ef011ae4ce3878dd5ba88dfe35d859d05498191637c3' },
  'linux-x64': { name: 'rtk-x86_64-unknown-linux-musl.tar.gz', sha256: 'c4c036fbf181fc55ef329786c8c17e0d427972b053b825944d968a6aafef1ba4' },
  'win32-x64': { name: 'rtk-x86_64-pc-windows-msvc.zip', sha256: '34cea9009a8099acdaf85147b971d95f65efabfa63fb3aea7d3e2b73e6f517c3' },
};
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_MAX_DELAY_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const INSTALL_LOCK_POLL_MS = 250;
const INSTALL_LOCK_STALE_MS = 15 * 60_000;
const INSTALL_LOCK_WAIT_MS = 10 * 60_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const execFile = promisify((file, args, options, callback) => {
  const child = spawn(file, args, { ...options, shell: false, windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  child.once('error', (error) => callback(error));
  child.once('close', (code) => code === 0 ? callback(null, { stdout, stderr }) : callback(Object.assign(new Error(stderr || `Command failed: ${file}`), { code: 'RTK_EXTRACT_FAILED', exitCode: code, stdout, stderr })));
});

export function resolveRtkAsset({ platform = process.platform, arch = process.arch } = {}) {
  const key = `${platform}-${arch}`;
  const asset = ASSETS[key];
  if (!asset) throw Object.assign(new Error(`unsupported RTK platform: ${key}`), { code: 'RTK_UNSUPPORTED_PLATFORM' });
  return { ...asset, url: `${BASE_URL}/${asset.name}`, version: VERSION };
}

export async function verifyRtkChecksum(content, expected) {
  const actual = createHash('sha256').update(content).digest('hex');
  return actual === String(expected).toLowerCase();
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) ?? null;
}

function networkErrorCode(error) {
  return error?.cause?.code ?? error?.code ?? (error?.name === 'TimeoutError' ? 'ETIMEDOUT' : null);
}

function downloadFailure(url, error, attempts) {
  const host = new URL(url).hostname;
  const detail = Number.isInteger(error?.status) ? 'HTTP ' + error.status : networkErrorCode(error) ?? 'network error';
  const prefix = attempts ? 'RTK download failed after ' + attempts + ' attempts' : 'RTK download failed';
  return Object.assign(new Error(prefix + ': ' + detail + ' while contacting ' + host + '.'), { code: 'RTK_DOWNLOAD_FAILED' });
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function fetchRtkAsset(url, {
  attempts = DOWNLOAD_ATTEMPTS,
  dispatcher,
  fetchImpl = fetch,
  nowImpl = Date.now,
  randomImpl = Math.random,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  waitImpl = wait,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const request = {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (dispatcher) request.dispatcher = dispatcher;
      const response = await fetchImpl(url, request);
      if (response.ok && response.body) return response;
      const retryable = RETRYABLE_HTTP_STATUSES.has(response.status);
      const retryAfter = parseRetryAfter(responseHeader(response, 'retry-after'), nowImpl());
      await response.body?.cancel();
      const error = { retryAfter, retryable, status: response.status };
      if (!retryable) throw error;
      lastError = error;
    } catch (error) {
      if (error.retryable === false) {
        throw downloadFailure(url, error);
      }
      const retryable = error.retryable === true || RETRYABLE_NETWORK_CODES.has(networkErrorCode(error));
      if (!retryable) throw downloadFailure(url, error);
      lastError = error;
    }
    if (attempt < attempts) {
      const exponentialCap = Math.min(DOWNLOAD_MAX_DELAY_MS, 250 * (2 ** (attempt - 1)));
      const jitter = Math.floor(randomImpl() * exponentialCap);
      const delay = Math.min(DOWNLOAD_MAX_DELAY_MS, lastError.retryAfter ?? jitter);
      await waitImpl(delay);
    }
  }
  throw downloadFailure(url, lastError, attempts);
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const normalized = String(value).trim();
  if (/^\d+$/u.test(normalized)) return Number(normalized) * 1000;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

export async function createRtkDispatcher(env = process.env) {
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY;
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY;
  if (!httpProxy && !httpsProxy) return null;
  try {
    const { EnvHttpProxyAgent } = await import('undici');
    return new EnvHttpProxyAgent({
      httpProxy,
      httpsProxy,
      noProxy: env.no_proxy ?? env.NO_PROXY ?? '',
    });
  } catch {
    throw Object.assign(new Error('RTK proxy setup failed.'), { code: 'RTK_PROXY_CONFIG_INVALID' });
  }
}

export async function downloadRtkResponse(response, destination, { maxBytes = DOWNLOAD_MAX_BYTES } = {}) {
  const declaredSize = Number(responseHeader(response, 'content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    await response.body?.cancel();
    throw Object.assign(new Error('RTK download exceeds the ' + maxBytes + '-byte limit.'), { code: 'RTK_DOWNLOAD_TOO_LARGE' });
  }
  let received = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        callback(Object.assign(new Error('RTK download exceeds the ' + maxBytes + '-byte limit.'), { code: 'RTK_DOWNLOAD_TOO_LARGE' }));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(response.body, limiter, createWriteStream(destination, { flags: 'wx' }));
  return received;
}

export async function acquireRtkInstallLock(toolDir, {
  nowImpl = Date.now,
  pollMs = INSTALL_LOCK_POLL_MS,
  staleMs = INSTALL_LOCK_STALE_MS,
  waitImpl = wait,
  waitMs = INSTALL_LOCK_WAIT_MS,
} = {}) {
  const lockPath = path.join(toolDir, '.install.lock');
  const startedAt = nowImpl();
  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile('locked\n');
      } catch (error) {
        await Promise.allSettled([
          handle.close(),
          rm(lockPath, { force: true }),
        ]);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        let closeError;
        try {
          await handle.close();
        } catch (error) {
          closeError = error;
        }
        await rm(lockPath, { force: true });
        if (closeError) throw closeError;
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const lockStat = await stat(lockPath);
        if (nowImpl() - lockStat.mtimeMs > staleMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (nowImpl() - startedAt >= waitMs) {
        throw Object.assign(new Error('Timed out waiting for the RTK install lock.'), { code: 'RTK_INSTALL_LOCK_TIMEOUT' });
      }
      await waitImpl(pollMs);
    }
  }
}

async function findBinary(root, binaryName) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findBinary(candidate, binaryName);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === binaryName) {
      return candidate;
    }
  }
  return null;
}

function assertArchiveEntries(entries) {
  for (const entry of entries.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
    const normalized = entry.replaceAll('\\', '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized) || normalized.split('/').includes('..')) {
      throw Object.assign(new Error('RTK archive contains an unsafe path.'), { code: 'RTK_ARCHIVE_UNSAFE_PATH' });
    }
  }
}

async function installRtk(toolDir) {
  const asset = resolveRtkAsset();
  await mkdir(toolDir, { recursive: true });
  const releaseLock = await acquireRtkInstallLock(toolDir);
  let stagingDir;
  let dispatcher;
  try {
    stagingDir = await mkdtemp(path.join(toolDir, '.install-'));
    const archive = path.join(stagingDir, asset.name);
    const extractDir = path.join(stagingDir, 'extract');
    dispatcher = await createRtkDispatcher(process.env);
    const response = await fetchRtkAsset(asset.url, { dispatcher });
    if (!response.ok || !response.body) throw Object.assign(new Error(`RTK download failed with HTTP ${response.status}.`), { code: 'RTK_DOWNLOAD_FAILED' });
    await downloadRtkResponse(response, archive);
    const content = await readFile(archive);
    if (!(await verifyRtkChecksum(content, asset.sha256))) throw Object.assign(new Error('RTK archive checksum mismatch.'), { code: 'RTK_CHECKSUM_MISMATCH' });
    await mkdir(extractDir, { recursive: true });
    const listing = await execFile('tar', ['-tf', archive], { cwd: stagingDir });
    assertArchiveEntries(listing.stdout);
    const extractArgs = asset.name.endsWith('.zip') ? ['-xf', archive, '-C', extractDir] : ['-xzf', archive, '-C', extractDir];
    await execFile('tar', extractArgs, { cwd: stagingDir });
    const binaryName = process.platform === 'win32' ? 'rtk.exe' : 'rtk';
    const binary = await findBinary(extractDir, binaryName);
    if (!binary) throw Object.assign(new Error('RTK archive did not contain the expected binary.'), { code: 'RTK_BINARY_MISSING' });
    const destination = path.join(toolDir, 'bin', binaryName);
    await mkdir(path.dirname(destination), { recursive: true });
    if (process.platform !== 'win32') await chmod(binary, 0o755);
    await rm(destination, { force: true });
    await rename(binary, destination);
    return { status: 'ready', version: VERSION };
  } finally {
    const cleanupTasks = [];
    if (dispatcher) cleanupTasks.push(Promise.resolve().then(() => dispatcher.close()));
    if (stagingDir) cleanupTasks.push(rm(stagingDir, { force: true, recursive: true }));
    await Promise.allSettled(cleanupTasks);
    await releaseLock();
  }
}

async function run(args, toolDir) {
  const binaryName = process.platform === 'win32' ? 'rtk.exe' : 'rtk';
  const binary = path.join(toolDir, 'bin', binaryName);
  const projectRoot = path.resolve(toolDir, '../../../..');
  const env = await prepareRtkRuntimeEnvironment(projectRoot, process.env);
  const child = spawn(binary, args, { cwd: process.cwd(), env, shell: false, stdio: 'inherit', windowsHide: true });
  child.once('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.once('close', (code) => { process.exitCode = code ?? 1; });
}

const [command, ...args] = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const toolDir = path.dirname(fileURLToPath(import.meta.url));
  if (command === 'install') {
    installRtk(toolDir).then((result) => console.log(JSON.stringify(result))).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  } else {
    run([command, ...args].filter((item) => item !== undefined), toolDir).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
