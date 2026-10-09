#!/usr/bin/env node
/**
 * Runtime wrapper for the pinned codebase-memory-mcp tool.
 *
 * The wrapper is the single entry point for both the managed MCP server and
 * the project management CLI, so it owns four jobs the raw entry point cannot:
 *
 * 1. A private cache location. The cache directory comes from
 *    `cache-path.mjs` unless `CBM_CACHE_DIR` pins it, so an MCP query and a
 *    provisioning index always open the same graph.
 * 2. Linked-worktree mapping. A worktree session is redirected to the main
 *    checkout so both share one project entry instead of building a second,
 *    empty index.
 * 3. Windows path aliases for non-ASCII roots, which the native runtime
 *    cannot handle directly.
 * 4. The freshness stamp. `index_status` reports the live repository HEAD, so
 *    `status: ready` cannot answer "is this graph current?"; a successful
 *    `index_repository` records the HEAD it indexed in
 *    `.vibe-harness/tool-state/codebase-memory-mcp/index-state.json`.
 */

import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codebaseMemoryCacheDir, codebaseMemoryIndexStatePath } from './cache-path.mjs';
import { writeIndexState } from './index-state.mjs';
import { aliasPathForRoot, replaceAliasInStatusOutput } from './path-alias.mjs';
import { resolveGitFacts } from './project-root.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(toolDir, 'node_modules/codebase-memory-mcp/bin.js');
const runtimeManifest = path.join(toolDir, 'node_modules/codebase-memory-mcp/package.json');
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

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/** The CLI form is `run.mjs cli <tool> ...`; the MCP form passes no arguments. */
function requestedTool(argv) {
  const marker = argv.indexOf('cli');
  const candidate = marker === -1 ? argv[0] : argv[marker + 1];
  return candidate && !candidate.startsWith('-') ? candidate : null;
}

const tool = requestedTool(args);
const requestedRoot = process.env.CBM_ALLOWED_ROOT || process.cwd();
const requestedFacts = resolveGitFacts(requestedRoot);
// Only a linked worktree is remapped. A plain subdirectory or a non-git path
// keeps the caller's own root so relative `--repo-path` values stay meaningful.
const worktreeRoot = requestedFacts?.isWorktree ? requestedFacts.root : null;
const projectRoot = worktreeRoot ? requestedFacts.mainRoot : path.resolve(requestedRoot);

for (const flag of ['--repo-path', '--repo_path']) {
  const index = args.indexOf(flag);
  if (index === -1) continue;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) continue;
  const matchesRoot = samePath(value, projectRoot) || Boolean(worktreeRoot && samePath(value, worktreeRoot));
  if (!matchesRoot) continue;
  const previous = value;
  args[index + 1] = '.';
  if (worktreeRoot && !samePath(previous, projectRoot)) {
    process.stderr.write(
      `codebase-memory-mcp: mapping worktree path ${previous} to the main checkout ${projectRoot}.\n`,
    );
  }
}

const allowedRoot = projectRoot;
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
  // Resolved through the shared helper so the managed MCP block, the
  // provisioning phases and this wrapper cannot drift onto different caches.
  CBM_CACHE_DIR: mapProjectPath(codebaseMemoryCacheDir(projectRoot)),
  CBM_ALLOWED_ROOT: childAllowedRoot,
};

const transformStatusPath = Boolean(pathAlias && tool === 'index_status');
const captureStdout = tool === 'index_repository' || transformStatusPath;
const child = spawn(process.execPath, [entry, ...args], {
  cwd: childAllowedRoot,
  env: childEnv,
  stdio: captureStdout ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  windowsHide: true,
});

/** Parse a JSON payload from either a raw object or an MCP result envelope. */
function parseToolPayload(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const inner = parsed?.content?.[0]?.text;
  if (typeof inner === 'string') {
    const nested = inner.trim();
    if (nested.startsWith('{')) {
      try {
        return JSON.parse(nested);
      } catch {
        return parsed;
      }
    }
  }
  return parsed;
}

function lastJsonPayload(output) {
  const line = String(output ?? '')
    .split(/\r?\n/gu)
    .map((item) => item.trim())
    .findLast((item) => item.startsWith('{'));
  return line ? parseToolPayload(line) : null;
}

async function runtimeVersion() {
  try {
    const manifest = JSON.parse(await readFile(runtimeManifest, 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * Record the indexed HEAD so `run.mjs codebase-memory status` can tell a fresh
 * graph from a stale one. Only a successful `index_repository` writes the
 * stamp, and a stamp failure never fails the tool run itself.
 */
async function recordIndexState(output) {
  const result = lastJsonPayload(output);
  if (!result || result.status !== 'indexed') return;
  const facts = resolveGitFacts(projectRoot) ?? requestedFacts;
  if (!facts?.headSha) {
    process.stderr.write('codebase-memory-mcp: index state stamp skipped; the project root has no git HEAD.\n');
    return;
  }
  const statePath = codebaseMemoryIndexStatePath(projectRoot);
  const modeIndex = args.findIndex((argument) => argument === '--mode');
  const indexedAt = typeof result.indexed_at === 'string' ? result.indexed_at : new Date().toISOString();
  try {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeIndexState(statePath, {
      branch: facts.branch,
      cacheDir: childEnv.CBM_CACHE_DIR,
      edges: Number.isInteger(result.edges) ? result.edges : null,
      headSha: facts.headSha,
      indexedAt,
      mode: modeIndex === -1 ? 'moderate' : args[modeIndex + 1] ?? 'moderate',
      nodes: Number.isInteger(result.nodes) ? result.nodes : null,
      project: typeof result.project === 'string' && result.project.trim() !== ''
        ? result.project
        : path.basename(projectRoot),
      recordedAt: new Date().toISOString(),
      rootPath: projectRoot,
      runtimeVersion: await runtimeVersion(),
      source: worktreeRoot ? 'wrapper:worktree' : 'wrapper',
    });
  } catch (error) {
    process.stderr.write(`codebase-memory-mcp: could not record the index state stamp: ${error?.message ?? error}\n`);
  }
}

if (captureStdout) {
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stdout += text;
    process.stdout.write(transformStatusPath ? replaceAliasInStatusOutput(text, pathAlias, allowedRoot) : text);
  });
  child.stdout.on('end', () => {
    if (tool === 'index_repository') void recordIndexState(stdout);
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
