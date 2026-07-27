#!/usr/bin/env node
import { lstat, realpath, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aliasPathForRoot, replaceAliasInStatusOutput } from './path-alias.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(toolDir, 'node_modules/codebase-memory-mcp/bin.js');
const allowedEnvironmentNames = new Set([
  'ALL_PROXY', 'APPDATA', 'CBM_ALLOWED_ROOT', 'CBM_CACHE_DIR', 'CBM_MEM_BUDGET_MB', 'CBM_WORKERS',
  'COMSPEC', 'HOME', 'HTTPS_PROXY',
  'HTTP_PROXY', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'NO_PROXY', 'PATH', 'Path',
  'PATHEXT', 'PROGRAMDATA', 'ProgramData', 'SHELL', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'SystemRoot',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'WINDIR', 'all_proxy', 'https_proxy', 'http_proxy',
  'no_proxy',
]);
const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => allowedEnvironmentNames.has(name)),
);
const args = process.argv.slice(2);
const repositoryIndex = args.indexOf('index_repository');
const repoPathIndex = args.indexOf('--repo-path');
if (repositoryIndex !== -1 && repoPathIndex !== -1 && process.env.CBM_ALLOWED_ROOT) {
  const requestedPath = args[repoPathIndex + 1];
  if (requestedPath && path.resolve(requestedPath) === path.resolve(process.env.CBM_ALLOWED_ROOT)) {
    args[repoPathIndex + 1] = '.';
  }
}
const allowedRoot = process.env.CBM_ALLOWED_ROOT || process.cwd();
const needsWindowsPathAlias = process.platform === 'win32' && /[^\x00-\x7F]/u.test(allowedRoot);
let pathAlias;
let pathAliasCreated = false;
if (needsWindowsPathAlias) {
  pathAlias = aliasPathForRoot(allowedRoot);
  const expectedTarget = path.resolve(allowedRoot).toLowerCase();
  let existingTarget;
  try {
    existingTarget = (await realpath(pathAlias)).toLowerCase();
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      const existing = await lstat(pathAlias).catch(() => null);
      if (!existing?.isSymbolicLink()) throw error;
      await rm(pathAlias, { force: true });
    }
  }
  if (existingTarget) {
    if (path.resolve(existingTarget).toLowerCase() !== expectedTarget) {
      throw new Error(`Codebase-memory alias conflicts with an existing path: ${pathAlias}`);
    }
  } else {
    await symlink(path.resolve(allowedRoot), pathAlias, 'junction');
    pathAliasCreated = true;
  }
}

function mapProjectPath(value) {
  if (!pathAlias || !value) return value;
  const relative = path.relative(path.resolve(allowedRoot), path.resolve(value));
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return path.join(pathAlias, relative);
  }
  return value;
}

const childAllowedRoot = pathAlias || allowedRoot;
const childEnv = {
  ...childEnvironment,
  CBM_ALLOWED_ROOT: childAllowedRoot,
};
if (childEnvironment.CBM_CACHE_DIR) childEnv.CBM_CACHE_DIR = mapProjectPath(childEnvironment.CBM_CACHE_DIR);
const transformStatusPath = Boolean(pathAlias && args.includes('index_status'));
const child = spawn(process.execPath, [entry, ...args], {
  cwd: childAllowedRoot,
  env: childEnv,
  stdio: transformStatusPath ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  windowsHide: true,
});
if (transformStatusPath) {
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stdout.on('end', () => {
    process.stdout.write(replaceAliasInStatusOutput(stdout, pathAlias, allowedRoot));
  });
}

async function cleanupAlias() {
  if (pathAliasCreated) await rm(pathAlias, { force: true });
}
child.once('error', (error) => {
  console.error(`Unable to start codebase-memory-mcp: ${error.code ?? 'START_FAILED'}`);
  void cleanupAlias();
  process.exitCode = 1;
});
child.once('exit', async (code, signal) => {
  await cleanupAlias();
  process.exitCode = code ?? (signal ? 1 : 0);
});
