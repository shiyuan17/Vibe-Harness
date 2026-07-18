#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const PLAYWRIGHT_CLI_VERSION = '0.1.17';
export const PLAYWRIGHT_TOOL_RELATIVE_DIR = '.agents/cognis/tools/playwright-cli';
export const PLAYWRIGHT_ARTIFACTS_RELATIVE_DIR = '.cognis/artifacts/playwright';
export const PLAYWRIGHT_GENERATED_RELATIVE_DIR = `${PLAYWRIGHT_TOOL_RELATIVE_DIR}/node_modules`;

const execFileAsync = promisify(execFile);
const stateFileName = 'playwright-cli.json';
const configFileName = 'playwright-cli.config.json';
const lockDirName = 'playwright-cli.lock';
const cliRelativePath = 'node_modules/@playwright/cli/playwright-cli.js';
const browsersRelativeDir = 'node_modules/playwright-core/.local-browsers';
const baseEnvironmentNames = new Set([
  'APPDATA', 'COMSPEC', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'PATH', 'Path',
  'PATHEXT', 'PROGRAMDATA', 'ProgramData', 'SHELL', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'WINDIR',
]);
const playwrightEnvironmentNames = new Set([
  ...baseEnvironmentNames,
  'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_DIR', 'SSL_CERT_FILE',
  'all_proxy', 'https_proxy', 'http_proxy', 'no_proxy', 'npm_config_offline',
  'npm_config_prefer_offline', 'npm_config_registry',
]);

function allowedPlaywrightEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => playwrightEnvironmentNames.has(name)));
}

function assertInside(parent, candidate, label) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the target project.`);
  }
}

async function assertSafeRuntimePath(targetDir, candidate, label) {
  assertInside(targetDir, candidate, label);
  const resolvedTarget = path.resolve(targetDir);
  const canonicalTarget = await realpath(resolvedTarget);
  let lexical = resolvedTarget;
  let expected = canonicalTarget;
  for (const segment of path.relative(resolvedTarget, path.resolve(candidate)).split(path.sep).filter(Boolean)) {
    lexical = path.join(lexical, segment);
    expected = path.join(expected, segment);
    try {
      const info = await lstat(lexical);
      const canonical = await realpath(lexical);
      const normalizedCanonical = process.platform === 'win32' ? path.resolve(canonical).toLowerCase() : path.resolve(canonical);
      const normalizedExpected = process.platform === 'win32' ? path.resolve(expected).toLowerCase() : path.resolve(expected);
      if (info.isSymbolicLink() || normalizedCanonical !== normalizedExpected) {
        throw new Error(`${label} must not traverse a symbolic link, junction, or reparse point.`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
}

async function assertRuntimePathsSafe(paths) {
  for (const [label, candidate] of [
    ['Playwright artifacts directory', paths.artifactsDir],
    ['Playwright state directory', paths.stateDir],
    ['Playwright tool directory', paths.toolDir],
  ]) await assertSafeRuntimePath(paths.targetDir, candidate, label);
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function lockHash(toolDir) {
  const content = await readFile(path.join(toolDir, 'package-lock.json'));
  return createHash('sha256').update(content).digest('hex');
}

async function readJsonIfExists(filePath) {
  if (!(await pathExists(filePath))) return null;
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function hasChromium(toolDir) {
  const browserDir = path.join(toolDir, browsersRelativeDir);
  if (!(await pathExists(browserDir))) return false;
  return (await readdir(browserDir)).some((entry) => entry.startsWith('chromium'));
}

function runtimePaths({ targetDir, toolDir = path.join(targetDir, PLAYWRIGHT_TOOL_RELATIVE_DIR) }) {
  const resolvedTarget = path.resolve(targetDir);
  const resolvedTool = path.resolve(toolDir);
  assertInside(resolvedTarget, resolvedTool, 'Playwright tool directory');
  const canonicalState = existsSync(path.join(resolvedTarget, '.cognis', 'install-state.json'));
  const legacyState = existsSync(path.join(resolvedTarget, '.loopengine', 'install-state.json'));
  if (canonicalState && legacyState) {
    throw Object.assign(new Error('Both .cognis and .loopengine contain install state.'), {
      code: 'COGNIS_STATE_CONFLICT',
    });
  }
  const stateDir = path.join(resolvedTarget, legacyState ? '.loopengine/tool-state' : '.cognis/tool-state');
  return {
    artifactsDir: path.join(resolvedTarget, PLAYWRIGHT_ARTIFACTS_RELATIVE_DIR),
    cliPath: path.join(resolvedTool, cliRelativePath),
    configPath: path.join(stateDir, configFileName),
    lockDir: path.join(stateDir, lockDirName),
    stateDir,
    statePath: path.join(stateDir, stateFileName),
    targetDir: resolvedTarget,
    toolDir: resolvedTool,
  };
}

function normalizeArtifactArgs(args, artifactsDir) {
  const normalized = [];
  const resolveFilename = (value) => {
    const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(artifactsDir, value);
    assertInside(artifactsDir, resolved, 'Playwright artifact filename');
    return resolved;
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--config' || argument.startsWith('--config=')) {
      throw new Error('Use the managed Playwright config; custom config arguments are not allowed.');
    } else if (argument.startsWith('--filename=')) {
      normalized.push(`--filename=${resolveFilename(argument.slice('--filename='.length))}`);
    } else if (argument === '--filename' && args[index + 1]) {
      normalized.push(argument, resolveFilename(args[index + 1]));
      index += 1;
    } else {
      normalized.push(argument);
    }
  }
  return normalized;
}

async function writeRuntimeConfig(paths) {
  await assertRuntimePathsSafe(paths);
  const config = {
    allowUnrestrictedFileAccess: false,
    browser: { isolated: true },
    outputDir: paths.artifactsDir,
    outputMode: 'file',
  };
  await mkdir(paths.artifactsDir, { recursive: true });
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return paths.configPath;
}

async function isReady(paths, expectedLockHash) {
  const state = await readJsonIfExists(paths.statePath);
  return state?.status === 'ready'
    && state.version === PLAYWRIGHT_CLI_VERSION
    && state.lockHash === expectedLockHash
    && await pathExists(paths.cliPath)
    && await hasChromium(paths.toolDir);
}

async function acquireLock(lockDir, { now = () => Date.now(), pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const startedAt = now();
  const timeoutMs = 10 * 60 * 1000;
  const staleMs = 30 * 60 * 1000;
  while (true) {
    try {
      await mkdir(lockDir);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lockStat = await stat(lockDir).catch(() => null);
      if (lockStat && now() - lockStat.mtimeMs > staleMs) {
        await rm(lockDir, { force: true, recursive: true });
        continue;
      }
      if (now() - startedAt >= timeoutMs) {
        throw new Error('Timed out waiting for Playwright CLI preparation lock.');
      }
      await pause(250);
    }
  }
}

async function defaultRunCommand(command, args, options) {
  await execFileAsync(command, args, {
    ...options,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 600_000,
    windowsHide: true,
  });
}

async function npmInvocation(args) {
  if (process.platform !== 'win32') return { args, command: 'npm' };
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../node_modules/npm/bin/npm-cli.js'),
  ];
  const npmCliPath = (await Promise.all(candidates.map(async (candidate) => (
    await pathExists(candidate) ? candidate : null
  )))).find(Boolean);
  if (!npmCliPath) {
    throw new Error('Unable to locate npm-cli.js beside the current Node.js installation.');
  }
  return { args: [npmCliPath, ...args], command: process.execPath };
}

async function defaultRunCliCommand(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else {
        const error = new Error(`Playwright CLI exited with code ${code}.`);
        error.code = code;
        reject(error);
      }
    });
  });
}

export async function inspectPlaywrightTool({ targetDir, toolDir } = {}) {
  const paths = runtimePaths({ targetDir, toolDir });
  await assertRuntimePathsSafe(paths);
  const manifestPath = path.join(paths.toolDir, 'package.json');
  const lockPath = path.join(paths.toolDir, 'package-lock.json');
  const state = await readJsonIfExists(paths.statePath);
  let status = state?.status === 'unavailable' ? 'unavailable' : 'pending';
  if (await pathExists(manifestPath) && await pathExists(lockPath)) {
    const expectedLockHash = await lockHash(paths.toolDir);
    if (await isReady(paths, expectedLockHash)) status = 'ready';
  }
  return {
    artifactsDir: PLAYWRIGHT_ARTIFACTS_RELATIVE_DIR,
    status,
    toolDir: PLAYWRIGHT_TOOL_RELATIVE_DIR,
    version: PLAYWRIGHT_CLI_VERSION,
  };
}

export async function preparePlaywrightTool({ env = process.env, runCommand = defaultRunCommand, targetDir, toolDir } = {}) {
  const paths = runtimePaths({ targetDir, toolDir });
  await assertRuntimePathsSafe(paths);
  const expectedLockHash = await lockHash(paths.toolDir);
  await writeRuntimeConfig(paths);
  if (await isReady(paths, expectedLockHash)) return inspectPlaywrightTool({ targetDir, toolDir });

  await mkdir(paths.stateDir, { recursive: true });
  await acquireLock(paths.lockDir);
  let phase = 'dependency-install';
  try {
    if (await isReady(paths, expectedLockHash)) return inspectPlaywrightTool({ targetDir, toolDir });
    const childEnvironment = { ...allowedPlaywrightEnvironment(env), PLAYWRIGHT_BROWSERS_PATH: '0' };
    const npm = await npmInvocation(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    await runCommand(npm.command, npm.args, { cwd: paths.toolDir, env: childEnvironment });
    phase = 'browser-install';
    await runCommand(process.execPath, [paths.cliPath, 'install-browser', 'chromium'], { cwd: paths.toolDir, env: childEnvironment });
    phase = 'runtime-verification';
    if (!(await pathExists(paths.cliPath)) || !(await hasChromium(paths.toolDir))) {
      throw new Error('Playwright CLI preparation did not create the expected runtime files.');
    }
    await writeFile(paths.statePath, `${JSON.stringify({
      lockHash: expectedLockHash,
      preparedAt: new Date().toISOString(),
      status: 'ready',
      version: PLAYWRIGHT_CLI_VERSION,
    }, null, 2)}\n`, 'utf8');
    return inspectPlaywrightTool({ targetDir, toolDir });
  } catch (error) {
    await writeFile(paths.statePath, `${JSON.stringify({
      code: 'PLAYWRIGHT_CLI_PROVISION_FAILED',
      failedAt: new Date().toISOString(),
      lockHash: expectedLockHash,
      phase,
      status: 'unavailable',
      version: PLAYWRIGHT_CLI_VERSION,
    }, null, 2)}\n`, 'utf8');
    const wrapped = new Error('Unable to prepare Playwright CLI. Retry the command or use the documented browser fallback.');
    wrapped.code = 'PLAYWRIGHT_CLI_PROVISION_FAILED';
    wrapped.cause = error;
    wrapped.phase = phase;
    for (const property of ['exitCode', 'outputTruncated', 'stderr', 'stdout']) {
      if (error?.[property] !== undefined) wrapped[property] = error[property];
    }
    throw wrapped;
  } finally {
    await rm(paths.lockDir, { force: true, recursive: true });
  }
}

export async function runPlaywrightCli(args, options = {}) {
  const toolDir = options.toolDir ?? path.dirname(fileURLToPath(import.meta.url));
  const targetDir = options.targetDir ?? path.resolve(toolDir, '../../../..');
  const paths = runtimePaths({ targetDir, toolDir });
  await assertRuntimePathsSafe(paths);
  await preparePlaywrightTool({ ...options, targetDir, toolDir });
  const env = {
    ...allowedPlaywrightEnvironment(options.env ?? process.env),
    PLAYWRIGHT_BROWSERS_PATH: '0',
    PLAYWRIGHT_MCP_CONFIG: paths.configPath,
  };
  const normalizedArgs = normalizeArtifactArgs(args, paths.artifactsDir);
  return (options.runCliCommand ?? defaultRunCliCommand)(
    process.execPath,
    [paths.cliPath, ...normalizedArgs],
    { cwd: paths.targetDir, env, stdio: 'inherit' },
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await runPlaywrightCli(process.argv.slice(2));
  } catch (error) {
    console.error(JSON.stringify({ error: { code: error.code ?? 'PLAYWRIGHT_CLI_ERROR', message: error.message }, ok: false }));
    process.exitCode = 1;
  }
}
