import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const VERSION = '0.43.0';
const BASE_URL = `https://github.com/rtk-ai/rtk/releases/download/v${VERSION}`;
const ASSETS = {
  'darwin-arm64': { name: 'rtk-aarch64-apple-darwin.tar.gz', sha256: '8a17e49acbd378997eb21d0eb6f7f861111f35b4fc9b1c74edf4c7448e576c65' },
  'darwin-x64': { name: 'rtk-x86_64-apple-darwin.tar.gz', sha256: 'a85f60e2637811be68366208b8d8b9c5ba1b748cb5df4477ab20cd73d3c5d9f8' },
  'linux-arm64': { name: 'rtk-aarch64-unknown-linux-gnu.tar.gz', sha256: '5519f7ca12e5c143a609f0d28a0a77b97413a8dce31c2681f1a41c24519a8731' },
  'linux-x64': { name: 'rtk-x86_64-unknown-linux-musl.tar.gz', sha256: 'ff8a1e7766496e175291a85aeca1dc97c9ff6df33e51e5893d1fbc78fea2a609' },
  'win32-x64': { name: 'rtk-x86_64-pc-windows-msvc.zip', sha256: '7c5e4a2ef816a4d4ed947ddd74ca3df851fc39ea87d49a3ca2bf3abc515a016b' },
};

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
  const archive = path.join(toolDir, asset.name);
  const extractDir = path.join(toolDir, '.extract');
  await mkdir(toolDir, { recursive: true });
  try {
    const response = await fetch(asset.url, { redirect: 'follow' });
    if (!response.ok || !response.body) throw Object.assign(new Error(`RTK download failed with HTTP ${response.status}.`), { code: 'RTK_DOWNLOAD_FAILED' });
    await pipeline(response.body, createWriteStream(archive));
    const content = await readFile(archive);
    if (!(await verifyRtkChecksum(content, asset.sha256))) throw Object.assign(new Error('RTK archive checksum mismatch.'), { code: 'RTK_CHECKSUM_MISMATCH' });
    await mkdir(extractDir, { recursive: true });
    const listing = await execFile('tar', ['-tf', archive], { cwd: toolDir });
    assertArchiveEntries(listing.stdout);
    const extractArgs = asset.name.endsWith('.zip') ? ['-xf', archive, '-C', extractDir] : ['-xzf', archive, '-C', extractDir];
    await execFile('tar', extractArgs, { cwd: toolDir });
    const binaryName = process.platform === 'win32' ? 'rtk.exe' : 'rtk';
    const binary = await findBinary(extractDir, binaryName);
    if (!binary) throw Object.assign(new Error('RTK archive did not contain the expected binary.'), { code: 'RTK_BINARY_MISSING' });
    const destination = path.join(toolDir, 'bin', binaryName);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(binary));
    if (process.platform !== 'win32') await chmod(destination, 0o755);
    return { status: 'ready', version: VERSION };
  } finally {
    await rm(archive, { force: true });
    await rm(extractDir, { force: true, recursive: true });
  }
}

async function run(args, toolDir) {
  const binaryName = process.platform === 'win32' ? 'rtk.exe' : 'rtk';
  const binary = path.join(toolDir, 'bin', binaryName);
  const child = spawn(binary, args, { cwd: process.cwd(), env: process.env, shell: false, stdio: 'inherit', windowsHide: true });
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
    run([command, ...args].filter((item) => item !== undefined), toolDir);
  }
}
