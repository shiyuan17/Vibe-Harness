// Worktree inspection, provisioning, local staging and recovery.
//
// The lifecycle commands share one model: workspace topology discovery,
// dependency mirrors, port blocks and the local stage step.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { gitFingerprint } from './git-fingerprint.mjs';
import { attestCompletionProvenance } from './verification-receipt.mjs';
import { resolveDelivery, validateCompletion } from './delivery.mjs';
import { readMergeEvidence, validateMergeEvidence } from './merge-evidence.mjs';
import { releaseServiceTeardown, teardownServices } from './services.mjs';
import {
  parseWorktreeList,
  pathKey,
  resolveWorktreeRoot,
  summarizeWorktreeAudit,
  validateWorktrees,
} from './worktree-audit.mjs';
import {
  ensureRealDirectory,
  expandMirrors,
  linkDirectory,
  linkOrCopyMirrors,
  removeMirrorLinks,
  worktreeMirrorEvidence,
} from './worktree-mirrors.mjs';
import {
  allocatePortBlock,
  collectWorktreePortEvidence,
  DEFAULT_PORT_BLOCK_SIZE,
  DEFAULT_PORT_ENV_FILE,
  inferPortPlan,
  isPortVariable,
  PORT_LOCK_RELATIVE_PATH,
  PORT_REGISTRY_RELATIVE_PATH,
  portsForBlock,
  readPortRegistry,
  renderWorktreeEnv,
  validatePortRegistry,
} from './worktree-ports.mjs';

import { boundedOutput, normalizePath } from './cli-output.mjs';
import { CONFIG_FILE, SCHEMA_VERSION, assertSafeCommand, isInsidePath, normalizeSlashes, packageManager, probeExecutable, readProjectConfig, runFile, runGit, safeRealpath } from './cli-runtime.mjs';
import { gitTimeoutMs } from './git-timeouts.mjs';
import { boundParentBatches } from './parent-batch.mjs';
import { acquireLeaseWithRetry, DEFAULT_HEARTBEAT_MS, DEFAULT_LEASE_MS, releaseLease, startLeaseHeartbeat } from './lease-lock.mjs';
import { readTaskAnchor, taskPlanCheckReport, taskParentBatchEvidence } from './task-command.mjs';
import { candidateEnvironment } from './verification-inputs.mjs';
import { readCandidateResources, saveCandidateResources } from './candidate-resources.mjs';
import { executeCommand, timeoutValue } from './verification-plan-support.mjs';
const LAND_LOCK_TIMEOUT_MS = 180_000;
const LAND_LOCK_RETRY_MS = 50;
const LAND_TRANSACTION_SCHEMA_VERSION = 6;

const IGNORED_SCAN_DIRECTORIES = new Set([
  '.agents', '.git', '.turbo', '.vibe-harness', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target',
]);
function safeWorktreeFile(root, relative, label) {
  const target = path.resolve(root, relative);
  const canonicalRoot = safeRealpath(root);
  if (!canonicalRoot || !isInsidePath(target, root)) {
    throw new Error(`${label} must stay inside its worktree`);
  }
  let existing = target;
  while (true) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      existing = path.dirname(existing);
    }
  }
  const canonicalExisting = safeRealpath(existing);
  if (!canonicalExisting || (pathKey(canonicalExisting) !== pathKey(canonicalRoot)
    && !isInsidePath(canonicalExisting, canonicalRoot))) {
    throw new Error(`${label} must stay inside its worktree`);
  }
  return target;
}
function listDirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !IGNORED_SCAN_DIRECTORIES.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
function workspacePatterns(packageJson) {
  const raw = packageJson?.workspaces;
  const patterns = Array.isArray(raw) ? raw : Array.isArray(raw?.packages) ? raw.packages : [];
  return patterns.filter((item) => typeof item === 'string' && item.trim() !== '');
}
function expandWorkspacePattern(rootDir, pattern) {
  const normalized = normalizeSlashes(pattern).replace(/^\.\//u, '');
  if (normalized.endsWith('/**')) {
    const base = path.resolve(rootDir, normalized.slice(0, -3));
    const found = [];
    const walk = (dir, depth) => {
      if (depth > 3) return;
      for (const name of listDirectories(dir)) {
        const next = path.join(dir, name);
        if (isNestedCheckout(next)) continue;
        found.push(next);
        walk(next, depth + 1);
      }
    };
    walk(base, 0);
    return found;
  }
  if (normalized.endsWith('/*')) {
    const base = path.resolve(rootDir, normalized.slice(0, -2));
    return listDirectories(base)
      .map((name) => path.join(base, name))
      .filter((dir) => !isNestedCheckout(dir));
  }
  return [path.resolve(rootDir, normalized)];
}
/**
 * A directory that owns its own `.git` entry is a separate checkout: a linked
 * worktree, a submodule, or a vendored clone. Its workspace topology belongs to
 * that checkout, so scanning it would report the same package name several
 * times and point a link at another worktree's copy.
 */
function isNestedCheckout(dir) {
  return existsSync(path.join(dir, '.git'));
}
function readPackageJsonSync(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}
/**
 * Discover workspace roots and the local packages they declare.
 *
 * A dependency root is a directory that owns a hoisted `node_modules` and a
 * `workspaces` declaration. The local packages are the workspace packages
 * inside it: those must resolve to the worktree's own sources, because Node
 * follows a shared junction back to the main checkout and would otherwise hand
 * a worktree the main checkout's copy.
 */
function discoverWorkspaceTopology(projectDir) {
  const candidates = [];
  const visit = (dir, depth) => {
    const packageJson = readPackageJsonSync(dir);
    if (workspacePatterns(packageJson).length > 0) candidates.push({ dir, packageJson });
    if (depth >= 2) return;
    for (const name of listDirectories(dir)) {
      const next = path.join(dir, name);
      if (isNestedCheckout(next)) continue;
      visit(next, depth + 1);
    }
  };
  visit(projectDir, 0);

  const roots = [];
  const packages = [];
  for (const candidate of candidates) {
    const relativeRoot = normalizeSlashes(path.relative(projectDir, candidate.dir)) || '.';
    roots.push({ dir: relativeRoot, abs: candidate.dir });
    const seen = new Set();
    for (const pattern of workspacePatterns(candidate.packageJson)) {
      for (const dir of expandWorkspacePattern(candidate.dir, pattern)) {
        const key = pathKey(dir);
        if (seen.has(key)) continue;
        seen.add(key);
        const manifest = readPackageJsonSync(dir);
        if (typeof manifest?.name !== 'string' || manifest.name.trim() === '') continue;
        packages.push({
          abs: dir,
          dir: normalizeSlashes(path.relative(projectDir, dir)),
          name: manifest.name.trim(),
          root: relativeRoot,
        });
      }
    }
  }
  return { packages, roots };
}
function readWorktreeConfig(config) {
  const raw = config?.worktree;
  if (raw === undefined) return { value: {}, error: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: {}, error: 'worktree must be an object.' };
  }
  const value = {};
  if (raw.dependencyMode !== undefined && !['shared-immutable', 'isolated'].includes(raw.dependencyMode)) {
    return { value: {}, error: 'worktree.dependencyMode must be shared-immutable or isolated.' };
  }
  value.dependencyMode = raw.dependencyMode ?? 'shared-immutable';
  for (const key of ['root', 'baseRef']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || raw[key].trim() === '') return { value: {}, error: `worktree.${key} must be a non-empty string.` };
    value[key] = raw[key].trim();
  }
  for (const key of ['dependencyRoots', 'localPackages']) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key]) || raw[key].some((item) => typeof item !== 'string' || item.trim() === '')) {
      return { value: {}, error: `worktree.${key} must be an array of non-empty strings.` };
    }
    value[key] = raw[key].map((item) => item.trim());
  }
  // `mirrors` projects the ignored governance surface (`.agents`, `.codex`,
  // `.host-config`, `.codegraph`) into every worktree. A declared path must be
  // project-relative and may use at most one whole-segment `*` wildcard.
  if (raw.mirrors !== undefined) {
    if (!Array.isArray(raw.mirrors)) {
      return { value: {}, error: 'worktree.mirrors must be an array of project-relative paths.' };
    }
    const mirrors = [];
    for (const item of raw.mirrors) {
      if (typeof item !== 'string' || item.trim() === '') {
        return { value: {}, error: 'worktree.mirrors must be an array of non-empty project-relative paths.' };
      }
      const normalized = normalizeSlashes(item.trim()).replace(/^\.\//u, '');
      const segments = normalized.split('/');
      const wildcards = segments.filter((segment) => segment.includes('*'));
      if (segments.length === 0 || segments.some((segment) => segment === '')
        || path.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized) || normalized.startsWith('/')
        || segments.includes('..')
        || wildcards.length > 1 || (wildcards.length === 1 && wildcards[0] !== '*')) {
        return { value: {}, error: `worktree.mirrors entry ${item} must be a project-relative path (at most one whole-segment "*" wildcard, no absolute path or "..").` };
      }
      mirrors.push(normalized);
    }
    value.mirrors = mirrors;
  }
  // `ports` and `provision` are fail-closed: a declared but malformed block
  // stops the plan instead of silently falling back to an inferred default,
  // because a wrong block silently hands two worktrees the same dev-server port.
  if (raw.ports !== undefined) {
    if (!raw.ports || typeof raw.ports !== 'object' || Array.isArray(raw.ports)) {
      return { value: {}, error: 'worktree.ports must be an object.' };
    }
    const ports = {};
    if (raw.ports.base !== undefined) {
      if (!Number.isInteger(raw.ports.base) || raw.ports.base < 1 || raw.ports.base > 65_535) {
        return { value: {}, error: 'worktree.ports.base must be an integer between 1 and 65535.' };
      }
      ports.base = raw.ports.base;
    }
    if (raw.ports.blockSize !== undefined) {
      if (!Number.isInteger(raw.ports.blockSize) || raw.ports.blockSize < 1 || raw.ports.blockSize > 1_000) {
        return { value: {}, error: 'worktree.ports.blockSize must be an integer between 1 and 1000.' };
      }
      ports.blockSize = raw.ports.blockSize;
    }
    if (raw.ports.variables !== undefined) {
      if (!Array.isArray(raw.ports.variables)
        || raw.ports.variables.some((item) => typeof item !== 'string' || !isPortVariable(item.trim()))) {
        return { value: {}, error: 'worktree.ports.variables must be an array of port variable names such as PORT or WEB_PORT.' };
      }
      ports.variables = raw.ports.variables.map((item) => item.trim());
    }
    if (raw.ports.envFile !== undefined) {
      if (typeof raw.ports.envFile !== 'string' || raw.ports.envFile.trim() === '' || path.isAbsolute(raw.ports.envFile)) {
        return { value: {}, error: 'worktree.ports.envFile must be a non-empty project-relative path.' };
      }
      ports.envFile = normalizeSlashes(raw.ports.envFile.trim());
    }
    value.ports = ports;
  }
  if (raw.provision !== undefined) {
    if (!raw.provision || typeof raw.provision !== 'object' || Array.isArray(raw.provision)) {
      return { value: {}, error: 'worktree.provision must be an object.' };
    }
    const provision = {};
    for (const key of ['candidateSetupCommands', 'candidateTeardownCommands']) {
      if (raw.provision[key] === undefined) continue;
      if (!Array.isArray(raw.provision[key]) || raw.provision[key].some((item) => typeof item !== 'string' || !item.trim())) {
        return { value: {}, error: `worktree.provision.${key} must contain commands.` };
      }
      provision[key] = raw.provision[key];
    }
    if (Boolean(provision.candidateSetupCommands?.length) !== Boolean(provision.candidateTeardownCommands?.length)) {
      return { value: {}, error: 'candidate setup and teardown commands must be declared together.' };
    }
    if (raw.provision.setupCommands !== undefined) {
      if (!Array.isArray(raw.provision.setupCommands)
        || raw.provision.setupCommands.some((item) => typeof item !== 'string' || item.trim() === '')) {
        return { value: {}, error: 'worktree.provision.setupCommands must be an array of non-empty command strings.' };
      }
      provision.setupCommands = raw.provision.setupCommands.map((item) => item.trim());
    }
    if (raw.provision.envFiles !== undefined) {
      if (!Array.isArray(raw.provision.envFiles)
        || raw.provision.envFiles.some((item) => typeof item !== 'string' || item.trim() === '' || path.isAbsolute(item))) {
        return { value: {}, error: 'worktree.provision.envFiles must be an array of project-relative paths.' };
      }
      provision.envFiles = raw.provision.envFiles.map((item) => normalizeSlashes(item.trim()));
    }
    value.provision = provision;
  }
  return { value, error: null };
}
function resolveWorktreeSettings(projectDir, projectConfig, args) {
  const parsed = readWorktreeConfig(projectConfig);
  if (parsed.error) return { error: parsed.error };
  const configured = parsed.value;
  const discovered = discoverWorkspaceTopology(projectDir);
  const dependencyRoots = (configured.dependencyRoots ?? discovered.roots.map((root) => root.dir))
    .filter((dir) => dir !== '.');
  const wanted = configured.localPackages ? new Set(configured.localPackages) : null;
  const localPackages = discovered.packages.filter((item) => wanted === null || wanted.has(item.name));
  const unknown = wanted === null ? [] : [...wanted].filter((name) => !localPackages.some((item) => item.name === name));
  const ports = configured.ports ?? {};
  const provision = configured.provision ?? {};
  const portPlan = inferPortPlan(projectDir, {
    configuredBase: ports.base ?? null,
    declaredVariables: ports.variables ?? [],
    provisionEnvFiles: provision.envFiles ?? [],
  });
  return {
    baseRef: args.baseRef ?? configured.baseRef ?? 'develop',
    configuredRoot: args.root ?? configured.root ?? null,
    dependencyRoots,
    dependencyMode: configured.dependencyMode,
    localPackages,
    // `mirrors` is optional for backward compatibility: an old config that
    // predates the key resolves to an empty projection, exactly today's
    // behaviour, with no diagnostics.
    mirrors: configured.mirrors ?? [],
    ports: {
      base: portPlan.base,
      blockSize: ports.blockSize ?? DEFAULT_PORT_BLOCK_SIZE,
      envFile: ports.envFile ?? DEFAULT_PORT_ENV_FILE,
      files: portPlan.files,
      variables: portPlan.variables,
    },
    provision: {
      envFiles: provision.envFiles ?? [],
      setupCommands: provision.setupCommands ?? [],
      candidateSetupCommands: provision.candidateSetupCommands ?? [],
      candidateTeardownCommands: provision.candidateTeardownCommands ?? [],
    },
    projectDir,
    root: resolveWorktreeRoot(projectDir, args.root ?? configured.root),
    unknownLocalPackages: unknown,
    // Every discovered workspace package, so `link-package-roots` can project
    // the per-package `node_modules` of an isolated layout.
    workspacePackages: discovered.packages,
  };
}
async function worktreeEntries(projectDir, { timeoutMs = gitTimeoutMs() } = {}) {
  const top = await runGit(['rev-parse', '--show-toplevel'], projectDir, { timeoutMs });
  if (!top.ok) return { entries: [], repositoryRoot: null, reason: 'not-a-git-worktree' };
  const listing = await runFile('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: projectDir, timeoutMs });
  if (!listing.ok) return { entries: [], repositoryRoot: normalizePath(top.stdout.trim()), reason: 'worktree-list-failed' };
  return { entries: parseWorktreeList(listing.stdout), repositoryRoot: normalizePath(top.stdout.trim()), reason: null };
}
async function worktreeDirtyMap(entries) {
  const dirty = new Map();
  for (const entry of entries) {
    if (!entry.path || !existsSync(entry.path)) continue;
    const status = await runGit(['status', '--porcelain=v1'], entry.path);
    dirty.set(pathKey(entry.path), status.ok ? status.stdout.trim() !== '' : null);
  }
  return dirty;
}
async function resolveWorktreeIntegration(projectDir, entries, baseRef) {
  const map = new Map();
  const probe = await runGit(['rev-parse', '--verify', '--quiet', baseRef], projectDir);
  if (!probe.ok) return { baseRefResolved: false, map };
  for (const entry of entries) {
    if (entry.primary || typeof entry.branch !== 'string' || entry.branch === '') continue;
    const head = await runGit(['rev-parse', `refs/heads/${entry.branch}`], projectDir);
    if (!head.ok) continue;
    const mergeBase = await runGit(['merge-base', entry.branch, baseRef], projectDir);
    const ancestor = await runGit(['merge-base', '--is-ancestor', head.stdout.trim(), baseRef], projectDir);
    map.set(entry.branch, {
      integrated: ancestor.ok,
      mergeBaseSha: mergeBase.ok ? mergeBase.stdout.trim() : null,
      targetRef: baseRef,
    });
  }
  return { baseRefResolved: true, map };
}
function packagesForRoot(settings, root) {
  // A package belongs to a dependency root either because its own `workspaces`
  // declaration discovered it there, or because the configured root contains
  // its directory. The second form lets a project name a dependency root that
  // is declared by a parent manifest.
  return settings.localPackages.filter((item) => item.root === root
    || (normalizeSlashes(root) !== '.' && isInsidePath(item.abs, path.resolve(settings.projectDir, root))));
}
// Content-addressed dependency stores that must travel with an overlay: bun
// (`bun install` writes `.bun`) and pnpm (`.pnpm`) resolve packages through
// these point directories, so skipping them leaves a worktree unable to run
// vitest/tsc. Build caches (`.cache`, `.vite`, `.vite-temp`) stay skipped
// because they are regenerated and must never be shared between worktrees.
const OVERLAY_POINT_ENTRIES = new Set(['.bin', '.bun', '.pnpm']);
/** Link one overlay entry (top-level, or under a scope) from its source. */
function linkOverlayEntry({ localPackages, mainModules, name, scope = null, worktreeModules, worktreePath }) {
  const target = scope === null ? path.join(worktreeModules, name) : path.join(worktreeModules, scope, name);
  if (existsSync(target)) rmSync(target, { force: true, recursive: true });
  const fullName = scope === null ? name : `${scope}/${name}`;
  const local = localPackages.find((item) => item.name === fullName);
  if (local) {
    linkDirectory(path.join(worktreePath, local.dir), target);
    return;
  }
  linkDirectory(scope === null ? path.join(mainModules, name) : path.join(mainModules, scope, name), target);
}
/**
 * Overlay one `node_modules` directory against the main checkout.
 *
 * Third-party entries link back to the main checkout, while every local package
 * resolves to the worktree's own sources — Node follows a shared junction, so a
 * local package must never resolve through the main checkout's copy.
 */
function overlayModulesDirectory({ localPackages, mainModules, worktreeModules, worktreePath }) {
  ensureRealDirectory(worktreeModules);
  const localScopes = new Set(localPackages.filter((item) => item.name.startsWith('@')).map((item) => item.name.split('/')[0]));
  for (const entry of listDirectories(mainModules).concat(listFilesOf(mainModules))) {
    if (entry.startsWith('.') && !OVERLAY_POINT_ENTRIES.has(entry)) continue;
    if (localScopes.has(entry)) continue;
    linkOverlayEntry({ localPackages, mainModules, name: entry, worktreeModules, worktreePath });
  }
  for (const scope of localScopes) {
    const scopeDir = path.join(worktreeModules, scope);
    mkdirSync(scopeDir, { recursive: true });
    for (const entry of listDirectories(path.join(mainModules, scope))) {
      linkOverlayEntry({ localPackages, mainModules, name: entry, scope, worktreeModules, worktreePath });
    }
    for (const local of localPackages.filter((item) => item.name.startsWith(`${scope}/`))) {
      const target = path.join(scopeDir, local.name.slice(scope.length + 1));
      if (existsSync(target)) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      linkDirectory(path.join(worktreePath, local.dir), target);
    }
  }
}
/** Link one dependency root of a worktree against the main checkout. */
function linkDependencyRoot(projectDir, worktreePath, settings, root) {
  const mainModules = path.join(projectDir, root, 'node_modules');
  const worktreeModules = path.join(worktreePath, root, 'node_modules');
  const localPackages = packagesForRoot(settings, root);
  if (!existsSync(mainModules)) return { action: 'skipped', reason: `${root}/node_modules is absent in the main checkout`, root };
  if (localPackages.length === 0) {
    if (existsSync(worktreeModules)) rmSync(worktreeModules, { force: true, recursive: true });
    linkDirectory(mainModules, worktreeModules);
    return { action: 'linked', mode: 'directory', root };
  }
  overlayModulesDirectory({ localPackages, mainModules, worktreeModules, worktreePath });
  return { action: 'linked', localPackages: localPackages.map((item) => item.name), mode: 'overlay', root };
}
/**
 * Overlay the isolated `node_modules` of one workspace package.
 *
 * An isolated layout (pnpm, bun's isolated linker) installs a package's own
 * dependencies next to that package instead of only at the hoisted root, so
 * linking just `root/node_modules` leaves `apps/*`, `packages/**`,
 * `internal/**` and `scripts/*` unable to resolve. A package without its own
 * `node_modules` produces no entry.
 */
function linkPackageRoot(projectDir, worktreePath, settings, pkg) {
  const mainModules = path.join(projectDir, pkg.dir, 'node_modules');
  if (!existsSync(mainModules)) return null;
  const worktreeModules = path.join(worktreePath, pkg.dir, 'node_modules');
  overlayModulesDirectory({
    localPackages: settings.localPackages,
    mainModules,
    worktreeModules,
    worktreePath,
  });
  return { dir: pkg.dir, package: pkg.name, status: 'linked' };
}
/** Project the per-package `node_modules` overlays of every workspace package. */
function linkPackageRoots(projectDir, worktreePath, settings) {
  const results = [];
  for (const pkg of settings.workspacePackages ?? []) {
    const result = linkPackageRoot(projectDir, worktreePath, settings, pkg);
    if (result) results.push(result);
  }
  return results;
}
function listFilesOf(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
/**
 * Remove the dependency links a bootstrap created inside one worktree.
 *
 * `git worktree remove` does not follow a junction, so it deletes the tracked
 * files and then stops, leaving the worktree directory behind. Removing the
 * link directories first lets Git finish the job. Node's recursive removal
 * unlinks a reparse point instead of descending into it, so the main checkout's
 * `node_modules` is never touched.
 */
function removeDependencyLinks(worktreePath, settings) {
  const removed = [];
  for (const root of settings.dependencyRoots) {
    const modules = path.join(worktreePath, root, 'node_modules');
    if (!existsSync(modules)) continue;
    if (!lstatSync(modules).isDirectory()) continue;
    rmSync(modules, { force: true, recursive: true });
    removed.push(`${root}/node_modules`);
  }
  // The isolated per-package overlays of `linkPackageRoots` are the same kind of
  // bootstrap artifact and hold junctions into the main checkout, so they are
  // removed with the roots; leaving them behind is what makes `git worktree
  // remove` stop half way on Windows.
  for (const pkg of settings.workspacePackages ?? []) {
    const modules = path.join(worktreePath, pkg.dir, 'node_modules');
    if (!existsSync(modules)) continue;
    if (!(lstatSync(modules).isDirectory() || lstatSync(modules).isSymbolicLink())) continue;
    rmSync(modules, { force: true, recursive: true });
    removed.push(`${pkg.dir}/node_modules`);
  }
  return removed;
}
/**
 * Remove every link a bootstrap created inside one worktree.
 *
 * The dependency links plus the mirrored governance directories must be gone
 * before `git worktree remove`; a directory junction left in place can make the
 * removal reach the main checkout's `.agents`. Copied files and real
 * directories are left for Git so checkout content is never deleted here.
 */
function removeWorktreeLinks(projectDir, worktreePath, settings) {
  return [
    ...removeDependencyLinks(worktreePath, settings),
    ...removeMirrorLinks(projectDir, worktreePath, settings.mirrors ?? []),
  ];
}
/** Filesystem evidence for the dependency links of every worktree. */
function worktreeDependencyEvidence(projectDir, entries, settings) {
  const evidence = new Map();
  for (const entry of entries) {
    if (entry.primary || !entry.path || !existsSync(entry.path)) continue;
    const facts = [];
    for (const root of settings.dependencyRoots) {
      const mainModules = path.join(projectDir, root, 'node_modules');
      const worktreeModules = path.join(entry.path, root, 'node_modules');
      if (!existsSync(worktreeModules)) {
        facts.push({ dependencyRoot: root, status: 'missing' });
        continue;
      }
      const localPackages = packagesForRoot(settings, root);
      if (localPackages.length === 0) {
        const resolved = safeRealpath(worktreeModules);
        if (resolved === null || pathKey(resolved) !== pathKey(mainModules)) {
          facts.push({ dependencyRoot: root, resolved, status: 'stale' });
        }
        continue;
      }
      for (const local of localPackages) {
        const linkPath = path.join(worktreeModules, local.name);
        if (!existsSync(linkPath)) {
          facts.push({ dependencyRoot: root, localPackage: local.name, status: 'missing' });
          continue;
        }
        const resolved = safeRealpath(linkPath);
        if (resolved === null || !isInsidePath(resolved, entry.path)) {
          facts.push({ dependencyRoot: root, localPackage: local.name, resolved, status: 'stale' });
        }
      }
    }
    if (facts.length > 0) evidence.set(pathKey(entry.path), facts);
  }
  return evidence;
}
const PORT_LOCK_TIMEOUT_MS = 5_000;
const PORT_LOCK_RETRY_MS = 50;
/**
 * Red-zone membership for a project-relative path.
 *
 * docs/rules/governance-core.md makes red-zone writes an explicit confirmation,
 * and `hooks.redZonePaths` is the only declaration that decides membership.
 */
function isRedZonePath(relativePath, patterns) {
  const candidate = normalizeSlashes(relativePath).replace(/^\.\//u, '').toLowerCase();
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const directory = raw.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
    const body = directory.replace(/\/+$/u, '').toLowerCase().replace(/^\.\//u, '');
    if (body === '') continue;
    if (candidate === body || candidate.startsWith(`${body}/`)) return true;
    if (!body.includes('/') && path.basename(candidate) === body) return true;
  }
  return false;
}

/**
 * Exclusive lock file around every registry read/modify/write.
 *
 * Uses the shared lease-lock pattern: PID + heartbeat + grace window.
 * This replaces the old `wx` mode lock that could be permanently stale.
 */
async function withPortRegistryLock(projectDir, action, { timeoutMs = PORT_LOCK_TIMEOUT_MS } = {}) {
  const lockPath = path.join(projectDir, PORT_LOCK_RELATIVE_PATH);
  mkdirSync(path.dirname(lockPath), { recursive: true });

  const result = await acquireLeaseWithRetry(lockPath, {
    timeoutMs,
    retryMs: PORT_LOCK_RETRY_MS,
    leaseMs: 10_000, // Port locks are typically short-lived
  });

  if (!result.ok) {
    return {
      code: 'WORKTREE_PORT_LOCK_TIMEOUT',
      error: `${PORT_LOCK_RELATIVE_PATH} is held after ${timeoutMs}ms`,
    };
  }

  try {
    return await action();
  } finally {
    releaseLease(lockPath);
  }
}
function writePortRegistry(projectDir, registry) {
  const file = path.join(projectDir, PORT_REGISTRY_RELATIVE_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  const entries = [...registry.entries].sort((left, right) => left.block - right.block || left.id.localeCompare(right.id));
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...registry, entries }, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, file);
}
/**
 * Allocate or reuse the worktree's port block from the main checkout registry.
 *
 * The registry is the fact source: a conflict between two entries fails closed
 * instead of silently handing the second worktree a used port.
 */
function planPortAssignment(projectDir, settings, { branch, id, path: worktreePath }) {
  const info = readPortRegistry(projectDir);
  if (info.error) {
    return { code: info.code ?? 'WORKTREE_PORT_REGISTRY_INVALID', error: `${info.path}: ${info.error}` };
  }
  const registry = info.registry ?? {
    schemaVersion: 1,
    base: settings.ports.base,
    blockSize: settings.ports.blockSize,
    entries: [],
    variables: settings.ports.variables,
  };
  const validated = validatePortRegistry(registry);
  if (!validated.ok) {
    return { code: validated.code ?? 'WORKTREE_PORT_REGISTRY_INVALID', error: `${info.path}: ${validated.error}` };
  }
  const block = allocatePortBlock(registry, { id });
  const ports = portsForBlock(registry.base, registry.blockSize, block, registry.variables);
  const existing = registry.entries.find((entry) => entry.id === id);
  return {
    block,
    envFile: settings.ports.envFile,
    ports,
    registry: {
      ...registry,
      entries: [
        ...registry.entries.filter((entry) => entry.id !== id),
        { block, branch, id, path: normalizeSlashes(worktreePath), ports, updatedAt: new Date().toISOString() },
      ],
    },
    registryDiffers: !existing
      ? registry.base !== settings.ports.base || registry.blockSize !== settings.ports.blockSize
      : false,
    reused: Boolean(existing),
  };
}
function releasePortRegistryEntry(projectDir, id, { timeoutMs = PORT_LOCK_TIMEOUT_MS, expectedPath = null } = {}) {
  return withPortRegistryLock(projectDir, async () => {
    const info = readPortRegistry(projectDir);
    if (!info.registry) return { released: false, reason: info.error ?? 'no registry' };
    const owned = info.registry.entries.find((entry) => entry.id === id);
    if (expectedPath && owned && pathKey(owned.path) !== pathKey(expectedPath)) {
      return { released: false, reason: 'resource ownership changed' };
    }
    const entries = info.registry.entries.filter((entry) => entry.id !== id);
    if (entries.length === info.registry.entries.length) return { released: false, reason: 'no entry' };
    writePortRegistry(projectDir, { ...info.registry, entries });
    return { released: true };
  }, { timeoutMs });
}
function parseWorktreeTask(value) {
  const parts = String(value).split(':');
  const [id, branch, ...rest] = parts;
  if (!id || id.trim() === '') throw new Error(`--task ${value} has no identifier`);
  return {
    branch: branch === undefined || branch === '' ? null : branch,
    id: id.trim(),
    path: rest.length > 0 ? rest.join(':') : null,
  };
}
async function worktreeListReport(projectDir) {
  const { entries, reason, repositoryRoot } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'list', status: 'unavailable', error: reason, worktrees: [] };
  return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'list', status: 'ready', repositoryRoot, worktrees: entries };
}
async function worktreeCheckReport(projectDir, args) {
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'check', status: 'failed', error: settings.error };
  const { entries, reason, repositoryRoot } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'check', status: 'unavailable', error: reason };
  const dirty = await worktreeDirtyMap(entries);
  const { baseRefResolved, map } = await resolveWorktreeIntegration(projectDir, entries, settings.baseRef);
  const tasks = args.task.map(parseWorktreeTask).map((task) => ({
    ...task,
    path: task.path ?? path.join(settings.root, task.id),
  }));
  const collected = collectWorktreePortEvidence({
    entries,
    projectDir,
    registryInfo: readPortRegistry(projectDir),
    settings: {
      dependencyRoots: settings.dependencyRoots,
      envFile: settings.ports.envFile,
      envFiles: settings.provision.envFiles,
    },
  });
  // The audit counts severity in one place, so the caller flattens the
  // per-worktree facts into the same problem list the other codes use.
  const portFacts = {
    flat: [...collected.registryProblems, ...[...collected.evidence.values()].flat()],
    summary: collected.summary,
  };
  const audit = validateWorktrees(entries, {
    baseRef: settings.baseRef,
    branchPrefix: args.branchPrefix ?? null,
    configuredRoot: settings.root,
    dependencyEvidence: worktreeDependencyEvidence(projectDir, entries, settings),
    dirty,
    integration: map,
    integrationAll: true,
    mirrorEvidence: worktreeMirrorEvidence(projectDir, entries, settings.mirrors),
    portProblems: portFacts.flat,
    portSummary: portFacts.summary,
    repositoryRoot,
    tasks,
  });
  if (!baseRefResolved) {
    audit.problems.push({
      code: 'WORKTREE_BASE_REF_UNRESOLVED',
      message: `worktree.baseRef ${settings.baseRef} does not resolve in ${repositoryRoot}; merge-back facts were skipped`,
      severity: 'warning',
    });
    audit.warningCount += 1;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'check',
    status: audit.ok && !(args.strict && audit.warningCount > 0) ? 'passed' : 'failed',
    audit,
    localPackages: settings.localPackages.map((item) => item.name),
    portRegistry: {
      base: settings.ports.base,
      blockSize: settings.ports.blockSize,
      envFile: settings.ports.envFile,
      exists: readPortRegistry(projectDir).exists,
      path: PORT_REGISTRY_RELATIVE_PATH,
      variables: settings.ports.variables,
    },
    summary: summarizeWorktreeAudit(audit),
    unknownLocalPackages: settings.unknownLocalPackages,
  };
}
/**
 * Six-step bootstrap plan: worktree add, dependency links, port allocation plus
 * env file, declared env files, declared setup commands, toolchain probe.
 *
 * The plan is produced without touching the disk so `--dry-run` and `--write`
 * describe the same steps; only the apply path performs them.
 */
function worktreeBootstrapPlan(projectDir, settings, task, repositoryRoot, { baseSha = null, confirmRedZone = false, existingEntry = null } = {}) {
  const worktreePath = task.path ?? path.join(settings.root, task.id);
  // A re-bootstrap of an existing worktree keeps that worktree's real branch in
  // the receipt and the port registry instead of the convention default.
  const branch = task.branch ?? existingEntry?.branch ?? `feat/${task.id}-worktree`;
  const redZonePatterns = readWorktreeRedZone(projectDir);
  const missingRoots = settings.dependencyRoots
    .filter((root) => !existsSync(path.join(projectDir, root, 'node_modules')));
  const setupCommands = settings.provision.setupCommands;
  const writeTargets = [settings.ports.envFile, ...settings.provision.envFiles];
  const redZoneTargets = writeTargets.filter((file) => isRedZonePath(file, redZonePatterns));
  const blocked = [];
  if (missingRoots.length > 0 && setupCommands.length === 0) {
    blocked.push({
      code: 'WORKTREE_MAIN_DEPENDENCIES_MISSING',
      message: `${missingRoots.map((root) => `${root === '.' ? '' : `${root}/`}node_modules`).join(', ')} is absent in the main checkout; run the project's install command there first (or declare worktree.provision.setupCommands so the worktree installs its own dependencies)`,
    });
  }
  if (redZoneTargets.length > 0 && !confirmRedZone) {
    blocked.push({
      code: 'WORKTREE_RED_ZONE_CONFIRMATION_REQUIRED',
      message: `${redZoneTargets.join(', ')} is a red-zone path (hooks.redZonePaths); pass --confirm-red-zone to write it`,
    });
  }
  const steps = [{
    branch,
    command: `git -C ${normalizeSlashes(repositoryRoot)} worktree add ${normalizeSlashes(worktreePath)} -b ${branch} ${baseSha ?? settings.baseRef}`,
    kind: existingEntry ? 'reuse-worktree' : 'git-worktree-add',
    path: normalizeSlashes(worktreePath),
  }];
  // A worktree that installs its own dependencies must do that before the links
  // overlay the main checkout, otherwise the setup command deletes the links.
  if (missingRoots.length > 0) {
    for (const command of setupCommands) steps.push({ command, kind: 'setup-command' });
  }
  for (const root of settings.dependencyRoots) {
    const localPackages = packagesForRoot(settings, root);
    steps.push({
      kind: 'link-dependencies',
      localPackages: localPackages.map((item) => item.name),
      mode: localPackages.length > 0 ? 'overlay' : 'directory',
      root,
    });
  }
  // Isolated layouts keep a per-package `node_modules` next to each workspace
  // package; that overlay is projected in its own step so the receipt shows
  // which packages were covered.
  steps.push({
    kind: 'link-package-roots',
    packages: (settings.workspacePackages ?? [])
      .filter((pkg) => existsSync(path.join(projectDir, pkg.dir, 'node_modules')))
      .map((pkg) => pkg.name),
  });
  // The governance surface (`worktree.mirrors`) is projected before the port
  // and env files so a declared mirror that also holds a copied file (for
  // example `opencode.json`) is in place ahead of the env materialization.
  steps.push({
    kind: 'mirror-governance',
    mirrors: expandMirrors(projectDir, settings.mirrors),
  });
  const assignment = planPortAssignment(projectDir, settings, { branch, id: task.id, path: worktreePath });
  if (assignment.error) {
    blocked.push({ code: assignment.code, message: assignment.error });
  } else {
    steps.push({
      block: assignment.block,
      envFile: assignment.envFile,
      kind: 'allocate-ports',
      ports: assignment.ports,
      registry: PORT_REGISTRY_RELATIVE_PATH,
      reused: assignment.reused,
    });
  }
  steps.push({
    files: settings.provision.envFiles,
    kind: 'materialize-env-files',
    redZone: redZoneTargets,
  });
  if (missingRoots.length === 0) {
    for (const command of setupCommands) steps.push({ command, kind: 'setup-command' });
  }
  steps.push({
    kind: 'probe-toolchain',
    programs: [...new Set(['git', 'node', projectPackageManager(projectDir) ?? 'pnpm'])],
  });
  return {
    blocked,
    baseSha,
    branch,
    missingDependencyRoots: missingRoots,
    ports: assignment.error ? null : assignment.ports,
    steps,
    worktreePath,
  };
}
function readWorktreeRedZone(projectDir) {
  try {
    const config = JSON.parse(readFileSync(path.join(projectDir, CONFIG_FILE), 'utf8'));
    return Array.isArray(config?.hooks?.redZonePaths) ? config.hooks.redZonePaths : [];
  } catch {
    return [];
  }
}
function projectPackageManager(projectDir) {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    return packageManager(packageJson, projectDir);
  } catch {
    return null;
  }
}
/** True when one declared mirror projects `relative` (exact, directory or wildcard). */
function mirrorsCover(projectDir, mirrors, relative) {
  const target = normalizeSlashes(relative).replace(/^\.\//u, '');
  for (const mirror of expandMirrors(projectDir, mirrors)) {
    if (target === mirror || target.startsWith(`${mirror}/`)) return true;
    if (mirror.includes('*')) {
      const pattern = new RegExp(
        `^${mirror.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*')}$`,
        'u',
      );
      if (pattern.test(target)) return true;
    }
  }
  return false;
}
/**
 * Warnings a bootstrap receipt carries about the projected surface.
 *
 * The host trust record is keyed by the hook definition's absolute path, so a
 * worktree that mirrors `.codex/hooks.json` needs its own `/hooks` authorization
 * even though the file is shared. Vibe-Harness never writes host config; it
 * only surfaces the actionable reminder.
 */
function worktreeBootstrapWarnings(projectDir, settings) {
  const warnings = [];
  if (mirrorsCover(projectDir, settings.mirrors, '.codex/hooks.json')) warnings.push('WORKTREE_HOOK_TRUST_REQUIRED');
  return warnings;
}
/** Run the declared setup commands inside the new worktree. */
async function runSetupCommands(commands, worktreePath, projectDir, timeoutMs) {
  const results = [];
  for (const command of commands) {
    let tokens;
    try {
      tokens = assertSafeCommand(command);
    } catch (error) {
      return { error: `${command}: ${error.message}`, results, step: { command, kind: 'setup-command', status: 'blocked' } };
    }
    // `--write` is the explicit authorization for this command list; credentials
    // never travel with it, and the receipt carries a redacted tail only.
    const result = await executeCommand(command, worktreePath, timeoutMs);
    results.push({ command, exitCode: result.exitCode, status: result.status, ...(result.code ? { code: result.code } : {}) });
    if (result.status !== 'passed') {
      return {
        error: `${command} ${result.code ?? 'failed'}${result.stderr ? `: ${result.stderr}` : ''}`,
        results,
        step: { command, code: result.code ?? 'COMMAND_FAILED', kind: 'setup-command', status: 'failed' },
      };
    }
  }
  return { error: null, results, step: null };
}
async function worktreeBootstrapReport(projectDir, args) {
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'bootstrap', status: 'failed', error: settings.error };
  if (args.task.length === 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'bootstrap', status: 'failed', error: 'bootstrap needs at least one --task <name>[:<branch>[:<path>]]' };
  }
  const { entries, repositoryRoot, reason } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'bootstrap', status: 'unavailable', error: reason };
  const timeoutMs = timeoutValue(args.timeout ?? config.verification?.timeoutMs);
  // Resolve once for the whole batch: a tracking ref can advance between
  // preview and add, but the task must start at the SHA shown in its plan.
  const base = await runGit(['rev-parse', '--verify', settings.baseRef], projectDir);
  const baseSha = base.ok ? base.stdout.trim() : null;
  const results = [];
  for (const raw of args.task) {
    const task = parseWorktreeTask(raw);
    const existing = entries.find((entry) => !entry.primary
      && entry.path
      && pathKey(entry.path) === pathKey(task.path ?? path.join(settings.root, task.id)));
    const plan = worktreeBootstrapPlan(projectDir, settings, task, repositoryRoot, {
      baseSha,
      confirmRedZone: Boolean(args.confirmRedZone),
      existingEntry: existing ?? null,
    });
    if (args.write && isInsidePath(plan.worktreePath, repositoryRoot)) {
      results.push({ ...plan, error: `${normalizeSlashes(plan.worktreePath)} is inside the repository; use worktree.root outside the project`, status: 'failed' });
      continue;
    }
    const blockedError = plan.blocked[0];
    if (blockedError) {
      results.push({ ...plan, code: blockedError.code, error: blockedError.message, status: 'blocked' });
      continue;
    }
    if (!args.write) {
      results.push({ ...plan, ports: plan.ports, status: 'planned' });
      continue;
    }
    if (!existing) {
      const added = await runGit(['worktree', 'add', plan.worktreePath, '-b', plan.branch, plan.baseSha ?? settings.baseRef], projectDir);
      if (!added.ok) {
        results.push({ ...plan, error: boundedOutput(added.stderr || added.error?.message || 'git worktree add failed', projectDir), status: 'failed' });
        continue;
      }
      const common = await gitCommonDir(projectDir);
      const gitDir = await runGit(['rev-parse', '--absolute-git-dir'], plan.worktreePath);
      if (common.ok && gitDir.ok) {
        const records = readWorktreeOwnership(common.path);
        saveWorktreeOwnership(common.path, [...records.filter((item) => pathKey(item.path) !== pathKey(plan.worktreePath)),
          { id: task.id, branch: plan.branch, path: plan.worktreePath, gitDir: gitDir.stdout.trim(), created: true }]);
      }
    }
    try {
      // A worktree that has to install its own dependencies runs the declared
      // setup commands before the links are overlaid on top of them.
      const setupFirst = plan.missingDependencyRoots.length > 0;
      let setup = { error: null, results: [], step: null };
      if (setupFirst) {
        setup = await runSetupCommands(settings.provision.setupCommands, plan.worktreePath, projectDir, timeoutMs);
        if (setup.error) throw Object.assign(new Error(setup.error), { code: setup.step?.code ?? 'SETUP_COMMAND_FAILED' });
      }
      const links = settings.dependencyRoots.map((root) => linkDependencyRoot(projectDir, plan.worktreePath, settings, root));
      const stale = [];
      for (const root of settings.dependencyRoots) {
        for (const local of packagesForRoot(settings, root)) {
          const linkPath = path.join(plan.worktreePath, root, 'node_modules', local.name);
          const resolved = safeRealpath(linkPath);
          if (resolved === null || !isInsidePath(resolved, plan.worktreePath)) stale.push(local.name);
        }
      }
      if (stale.length > 0) throw new Error(`local packages did not resolve inside the worktree: ${stale.join(', ')}`);

      // The isolated per-package overlays and the governance mirrors come
      // before the port/env writes, so a mirrored surface that also carries a
      // copied env file is in place when the env materialization runs.
      const packageRoots = linkPackageRoots(projectDir, plan.worktreePath, settings);
      const mirrors = linkOrCopyMirrors(projectDir, plan.worktreePath, settings.mirrors);

      // The registry entry is written inside the lock so two concurrent
      // bootstraps can never pick the same block.
      const allocation = await withPortRegistryLock(projectDir, async () => {
        const assignment = planPortAssignment(projectDir, settings, { branch: plan.branch, id: task.id, path: plan.worktreePath });
        if (assignment.error) return { error: assignment.error, code: assignment.code };
        const envPath = safeWorktreeFile(plan.worktreePath, assignment.envFile, 'worktree.ports.envFile');
        writePortRegistry(projectDir, assignment.registry);
        mkdirSync(path.dirname(envPath), { recursive: true });
        writeFileSync(envPath, renderWorktreeEnv({ block: assignment.block, id: task.id, ports: assignment.ports }), 'utf8');
        return { block: assignment.block, envFile: assignment.envFile, ports: assignment.ports, reused: assignment.reused };
      });
      if (allocation.error) throw Object.assign(new Error(allocation.error), { code: allocation.code });

      const envFiles = [];
      for (const file of settings.provision.envFiles) {
        const source = safeWorktreeFile(projectDir, file, 'worktree.provision.envFiles source');
        const target = safeWorktreeFile(plan.worktreePath, file, 'worktree.provision.envFiles target');
        if (existsSync(target)) {
          envFiles.push({ file, status: 'present' });
          continue;
        }
        if (!existsSync(source)) {
          envFiles.push({ file, reason: 'absent in the main checkout', status: 'skipped' });
          continue;
        }
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(source));
        envFiles.push({ file, status: 'materialized' });
      }

      if (!setupFirst) {
        setup = await runSetupCommands(settings.provision.setupCommands, plan.worktreePath, projectDir, timeoutMs);
        if (setup.error) throw Object.assign(new Error(setup.error), { code: setup.step?.code ?? 'SETUP_COMMAND_FAILED' });
      }

      const toolchain = {};
      for (const program of plan.steps.find((step) => step.kind === 'probe-toolchain').programs) {
        toolchain[program] = await probeExecutable(program, plan.worktreePath);
      }
      results.push({
        ...plan,
        allocation,
        envFiles,
        links,
        mirrors,
        packageRoots,
        setupCommands: setup.results,
        status: 'passed',
        toolchain,
        warnings: worktreeBootstrapWarnings(projectDir, settings),
      });
    } catch (error) {
      let branchDeleted = false;
      let released = { released: false };
      if (!existing) {
        // A directory junction left in the failed worktree could make the
        // forced removal descend into the main checkout, so the links are torn
        // down first exactly as the cleanup and land paths do.
        removeWorktreeLinks(projectDir, plan.worktreePath, settings);
        await runGit(['worktree', 'remove', '--force', plan.worktreePath], projectDir);
        await runGit(['worktree', 'prune'], projectDir);
        const branchHead = await runGit(['rev-parse', `refs/heads/${plan.branch}`], projectDir);
        const baseHead = await runGit(['rev-parse', settings.baseRef], projectDir);
        const untouched = branchHead.ok && baseHead.ok && branchHead.stdout.trim() === baseHead.stdout.trim();
        branchDeleted = untouched
          && (await runGit(['branch', '--delete', '--force', plan.branch], projectDir)).ok;
        released = await releasePortRegistryEntry(projectDir, task.id);
      }
      results.push({
        ...plan,
        branchDeleted,
        code: error.code ?? 'BOOTSTRAP_FAILED',
        error: boundedOutput(error.message, projectDir),
        released: released.released === true,
        status: 'failed',
        rolledBack: !existing,
      });
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'bootstrap',
    status: results.every((item) => !['failed', 'blocked'].includes(item.status)) ? (args.write ? 'passed' : 'planned') : 'failed',
    ports: settings.ports,
    results,
    write: Boolean(args.write),
  };
}
async function retainedLandSource(projectDir, entry) {
  const common = await gitCommonDir(projectDir);
  if (!common.ok) return { error: 'Cannot read delivery transaction ownership' };
  try {
    const files = readdirSync(common.path).filter((name) => /^vibe-harness-land-batch-.*\.json$/u.test(name));
    for (const name of files) {
      const state = JSON.parse(readFileSync(path.join(common.path, name), 'utf8'));
      if (!Array.isArray(state.sources) || typeof state.id !== 'string' || !state.id) {
        return { error: 'Delivery transaction sources are unreadable' };
      }
      if (state.localOnly === true) continue;
      if (state.sources.some((source) => source.branch === entry.branch
        || typeof source.path === 'string' && pathKey(source.path) === pathKey(entry.path))) return { batchId: state.id };
    }
    return {};
  } catch { return { error: 'Cannot confirm retained delivery transaction ownership' }; }
}
async function worktreeCleanupReport(projectDir, args) {
  const config = await readProjectConfig(projectDir);
  const delivery = resolveDelivery(config, args.delivery);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'cleanup', status: 'failed', error: settings.error };
  if (args.task.length === 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'cleanup', status: 'failed', error: 'cleanup needs at least one --task <name>' };
  }
  const { entries, reason } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'cleanup', status: 'unavailable', error: reason };
  const results = [];
  for (const raw of args.task) {
    const task = parseWorktreeTask(raw);
    const entry = entries.find((item) => !item.primary && item.path
      && (pathKey(item.path) === pathKey(task.path ?? path.join(settings.root, task.id))
        || (task.branch !== null && item.branch === task.branch)
        || path.basename(item.path) === task.id));
    if (!entry) {
      results.push({ error: `no worktree matches task ${task.id}`, id: task.id, status: 'failed' });
      continue;
    }
    const transaction = await retainedLandSource(projectDir, entry);
    if (transaction.error || transaction.batchId) {
      results.push({ id: task.id, status: 'blocked', code: 'WORKTREE_CLEANUP_LAND_RESUME_REQUIRED',
        ...(transaction.batchId ? { batchId: transaction.batchId } : {}),
        blockers: [transaction.error ?? '旧远端事务需迁移；安全丢弃使用 discard --batch <id> --write'] });
      continue;
    }
    if (entry.detached || typeof entry.branch !== 'string' || entry.branch === '') {
      results.push({ branch: entry.branch, error: `${entry.path} has no named branch; a detached worktree cannot be proven merged`, id: task.id, path: normalizeSlashes(entry.path), status: 'failed' });
      continue;
    }
    const head = await runGit(['rev-parse', `refs/heads/${entry.branch}`], projectDir);
    const ancestor = head.ok ? await runGit(['merge-base', '--is-ancestor', head.stdout.trim(), settings.baseRef], projectDir) : { ok: false };
    const dirty = await runGit(['status', '--porcelain=v1'], entry.path);
    const blocked = [];
    let mergeEvidence = null;
    let receipt = null;
    if (delivery.requireReceipt) {
      try {
        receipt = args.receipt ? JSON.parse(await readFile(path.resolve(projectDir, args.receipt), 'utf8')) : null;
        // `--receipt` is caller-supplied JSON, so the gate also has to resolve
        // the cited verification against the record this tool wrote: a
        // self-consistent receipt can otherwise assert acceptance for checks
        // that never ran.
        const gate = validateCompletion(receipt, delivery, await gitFingerprint(entry.path),
          { provenance: await attestCompletionProvenance(entry.path, receipt) });
        if (gate.status !== 'passed') blocked.push(...gate.errors);
        const target = await runGit(['rev-parse', '--verify', settings.baseRef], projectDir);
        if (!target.ok || receipt?.target?.head !== target.stdout.trim()) blocked.push('completion receipt target is stale');
      } catch { blocked.push('completion receipt could not be read'); }
    }
    if (!ancestor.ok && delivery.cleanup === 'evidence-compatible') {
      try {
        const evidence = await readMergeEvidence(projectDir, { file: args['merge-evidence'] ? path.resolve(projectDir, args['merge-evidence']) : null, mr: args.mr });
        mergeEvidence = await validateMergeEvidence(projectDir, entry.path, args.mr ? { ...evidence, taskId: task.id } : evidence,
          { taskId: task.id, sourceHead: head.stdout?.trim(), targetRef: settings.baseRef, delivery, receipt });
        if (mergeEvidence.status !== 'passed') blocked.push(mergeEvidence.reason);
      } catch { blocked.push('Merge evidence unavailable; cannot prove GitLab MR merged'); }
    } else if (!ancestor.ok) blocked.push(`branch ${entry.branch} is not merged into ${settings.baseRef}`);
    if (!dirty.ok) blocked.push('the worktree status could not be read');
    if (dirty.ok && dirty.stdout.trim() !== '') blocked.push('the worktree has uncommitted changes');
    if (blocked.length > 0) {
      results.push({ blockers: blocked, branch: entry.branch, id: task.id, path: normalizeSlashes(entry.path), status: 'blocked' });
      continue;
    }
    if (!args.write) {
      results.push({ branch: entry.branch, id: task.id, path: normalizeSlashes(entry.path), status: 'planned' });
      continue;
    }
    const confirmedHead = await runGit(['rev-parse', 'HEAD'], entry.path);
    const confirmedDirty = await runGit(['status', '--porcelain=v1'], entry.path);
    const confirmedTarget = await runGit(['rev-parse', settings.baseRef], projectDir);
    if (!confirmedHead.ok || confirmedHead.stdout.trim() !== head.stdout.trim() || !confirmedDirty.ok || confirmedDirty.stdout.trim()
      || !confirmedTarget.ok || (mergeEvidence && confirmedTarget.stdout.trim() !== mergeEvidence.evidence.targetAfter)
      || (!mergeEvidence && !(await runGit(['merge-base', '--is-ancestor', head.stdout.trim(), settings.baseRef], projectDir)).ok)) {
      results.push({ id: task.id, status: 'blocked', blockers: ['Worktree or target changed before cleanup'] });
      continue;
    }
    // Teardown is best effort: an unprovable teardown is reported on the result
    // below instead of keeping a merged worktree in place. The marker it writes
    // is released by whichever path ends this item, so `service start` is only
    // held back while the worktree is actually about to be removed.
    const services = await teardownServices(projectDir, entry.path);
    if (delivery.requireReceipt) {
      const finalReceipt = validateCompletion(receipt, delivery, await gitFingerprint(entry.path),
        { provenance: await attestCompletionProvenance(entry.path, receipt) });
      const finalTarget = await runGit(['rev-parse', '--verify', settings.baseRef], projectDir);
      if (finalReceipt.status !== 'passed' || !finalTarget.ok || finalTarget.stdout.trim() !== receipt.target.head) {
        // The evidence changed while the services were being torn down, so the
        // worktree survives; releasing the marker is what lets its owner start
        // services again instead of being locked out of a worktree that is
        // still there.
        releaseServiceTeardown(projectDir, entry.path);
        results.push({ id: task.id, status: 'blocked', blockers: ['Evidence changed during service teardown'] });
        continue;
      }
    }
    const removedLinks = removeWorktreeLinks(projectDir, entry.path, settings);
    const removed = await runGit(['worktree', 'remove', entry.path], projectDir);
    if (!removed.ok) {
      releaseServiceTeardown(projectDir, entry.path);
      results.push({ branch: entry.branch, error: boundedOutput(removed.stderr || removed.error?.message || 'git worktree remove failed', projectDir), id: task.id, path: normalizeSlashes(entry.path), removedLinks, ...(services.status !== 'passed' ? { services } : {}), status: 'failed' });
      continue;
    }
    await runGit(['worktree', 'prune'], projectDir);
    releaseServiceTeardown(projectDir, entry.path);
    // The block is released inside the same lock that hands it out; the branch
    // itself is still never deleted here.
    const released = await releasePortRegistryEntry(projectDir, task.id);
    results.push({
      branch: entry.branch,
      id: task.id,
      path: normalizeSlashes(entry.path),
      portBlockReleased: released.released === true,
      remainingDirectory: existsSync(entry.path),
      removedLinks,
      ...(services.status !== 'passed' ? { services } : {}),
      status: 'passed',
    });
  }
  const failed = results.some((item) => item.status === 'failed' || item.status === 'blocked');
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'cleanup',
    status: failed ? (delivery.profile !== 'legacy' && results.some((item) => item.status === 'blocked') ? 'blocked' : 'failed') : args.write ? 'passed' : 'planned',
    results,
    write: Boolean(args.write),
  };
}
async function gitCommonDir(projectDir) {
  const result = await runGit(['rev-parse', '--git-common-dir'], projectDir);
  if (!result.ok || result.stdout.trim() === '') return { ok: false, error: boundedOutput(result.stderr || result.error?.message || 'cannot resolve git common dir', projectDir) };
  return { ok: true, path: path.resolve(projectDir, result.stdout.trim()) };
}



/**
 * The wall-clock budget a land waits for a peer's shared lock. Resolved per
 * call so the parent-owned knob also applies to in-process callers; it can only
 * shorten the deadline, never widen it. Exported as the machine-readable
 * contract for that default and clamp.
 *
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {number}
 */
export function landLockTimeoutMs(environment = process.env) {
  const override = Number(environment.VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS);
  if (!Number.isFinite(override) || override <= 0) return LAND_LOCK_TIMEOUT_MS;
  return Math.min(LAND_LOCK_TIMEOUT_MS, Math.floor(override));
}



function leaseHeartbeatIntervalMs(leaseMs) {
  return Math.max(1, Math.min(DEFAULT_HEARTBEAT_MS, Math.floor(leaseMs / 3)));
}

function startLeaseHeartbeats(lockPaths, leaseMs) {
  return lockPaths.map((lockPath) => startLeaseHeartbeat(lockPath, {
    heartbeatMs: leaseHeartbeatIntervalMs(leaseMs),
  }));
}



async function cleanupLandCandidate(projectDir, candidatePath, {
  abort = false,
  settings = null,
  timeoutMs = gitTimeoutMs(),
} = {}) {
  const candidateGit = (args, cwd = candidatePath) => runGit(args, cwd, {
    timeoutMs: Math.max(1, Math.min(timeoutMs, gitTimeoutMs())),
  });
  if (!candidatePath) return { removed: true, residual: null };
  const resources = await teardownCandidateEnvironment(projectDir, candidatePath, timeoutMs);
  if (!resources.ok) return { removed: false, residual: normalizeSlashes(candidatePath), reason: resources.error };
  if (abort) await candidateGit(['merge', '--abort']);
  let resolvedSettings = settings;
  if (!resolvedSettings) {
    const config = await readProjectConfig(projectDir);
    resolvedSettings = resolveWorktreeSettings(projectDir, config, {});
  }
  if (!resolvedSettings.error) removeWorktreeLinks(projectDir, candidatePath, resolvedSettings);
  const status = await candidateGit(['status', '--porcelain=v1']);
  if (!status.ok || status.stdout.trim() !== '') {
    return {
      removed: false,
      residual: normalizeSlashes(candidatePath),
      reason: status.ok ? 'candidate worktree is dirty after merge cleanup' : boundedOutput(status.stderr || status.error?.message || 'candidate status failed', projectDir),
    };
  }
  const removed = await candidateGit(['worktree', 'remove', candidatePath], projectDir);
  if (!removed.ok) {
    return {
      removed: false,
      residual: normalizeSlashes(candidatePath),
      reason: boundedOutput(removed.stderr || removed.error?.message || 'candidate worktree remove failed', projectDir),
    };
  }
  await candidateGit(['worktree', 'prune'], projectDir);
  if (resources.id) {
    await releasePortRegistryEntry(projectDir, resources.id, { expectedPath: candidatePath });
    const registry = readPortRegistry(projectDir);
    if (registry.error || registry.registry?.entries.some((entry) => entry.id === resources.id)) {
      return { removed: false, residual: normalizeSlashes(candidatePath), reason: 'resource registry release unconfirmed' };
    }
    const record = await readCandidateResources(projectDir, candidatePath);
    if (record) await saveCandidateResources(projectDir, candidatePath, { ...record, phase: 'cleaned' });
  }
  releaseServiceTeardown(projectDir, candidatePath);
  return { removed: true, residual: null };
}
// Batch state is stored in the Git common dir, not in a source worktree.  The
// candidate is deliberately retained between calls while an agent resolves a
// merge; the short-lived shared lock only fences transitions, never the time
// spent editing a conflict.
function batchStatePath(commonDir, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(id)) throw new Error('invalid batch id');
  return path.join(commonDir, `vibe-harness-land-batch-${id}.json`);
}









function saveBatchState(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, file);
}
function batchFailure(code, error, extra = {}) {
  return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'stage',
    status: 'blocked', commandStatus: 'blocked', integrationStatus: 'not_integrated', code, error, ...extra };
}














async function teardownCandidateEnvironment(projectDir, candidate, timeoutMs) {
  if (!existsSync(candidate)) return { ok: true };
  try {
    const context = await readCandidateResources(projectDir, candidate);
    const { environment } = candidateEnvironment(candidate);
    if (!context) return existsSync(path.join(candidate, '.vibe-harness/candidate-resources.json'))
      ? { ok: false, error: 'candidate resource journal is missing; ownership cannot be proven' }
      : { ok: true };
    if (context.phase === 'stopped') return { ok: true, id: context.id };
    const stopped = await teardownServices(projectDir, candidate, true, { timeoutMs });
    if (stopped.status !== 'passed') return { ok: false, error: 'candidate services still occupied' };
    if (context.setup !== 'pending') {
      for (let index = context.teardownNext; index < context.teardownCommands.length; index++) {
        context.pendingStep = `teardown:${index}`;
        await saveCandidateResources(projectDir, candidate, context);
        const result = await executeCommand(context.teardownCommands[index], candidate, timeoutMs, candidate,
          { ...environment, VIBE_HARNESS_RESOURCE_STEP: context.pendingStep });
        if (result.status !== 'passed') return { ok: false, error: 'candidate teardown failed', result };
        context.teardownNext = index + 1;
        context.pendingStep = null;
        await saveCandidateResources(projectDir, candidate, context);
      }
    }
    context.phase = 'stopped';
    await saveCandidateResources(projectDir, candidate, context);
    return { ok: true, id: context.id };
  } catch (error) { return { ok: false, error: error.message }; }
}










function transactionFailure(subcommand, code, error, extra = {}) {
  return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand,
    status: 'blocked', commandStatus: 'blocked', integrationStatus: 'not_integrated', code, error, ...extra };
}
async function readLandTransaction(projectDir, batchId) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(batchId ?? '')) {
    return { error: transactionFailure('status', 'WORKTREE_BATCH_ID_INVALID', 'A valid --batch id is required') };
  }
  const common = await gitCommonDir(projectDir);
  if (!common.ok) return { error: transactionFailure('status', 'LAND_BATCH_COMMON_DIR', common.error) };
  const file = batchStatePath(common.path, batchId);
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return { error: transactionFailure('status', 'LAND_BATCH_NOT_FOUND', 'Batch state is missing or unreadable') }; }
  const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
  const sourcesValid = Array.isArray(state?.sources) && state.sources.length > 0 && state.sources.length <= 32
    && state.sources.every((source) => source && typeof source.id === 'string' && source.id
      && typeof source.branch === 'string' && source.branch && typeof source.path === 'string'
      && path.isAbsolute(source.path) && sha.test(source.head));
  const localValid = state?.localOnly !== true || state.schemaVersion === LAND_TRANSACTION_SCHEMA_VERSION
    && typeof state.primaryPath === 'string' && path.isAbsolute(state.primaryPath)
    && Number.isInteger(state.next) && state.next >= 0 && state.next <= state.sources?.length
    && ['checkpoint', 'merging', 'conflict', 'local_integrated', 'local_integrated_cleanup_pending', 'discarded'].includes(state.phase)
    && sha.test(state.expectedHead) && sha.test(state.preMergeHead)
    && (state.localIntegrated !== true || sha.test(state.localMergeCommit));
  const legacyValid = state?.localOnly === true || typeof state?.candidate === 'string'
    && path.isAbsolute(state.candidate) && /^\.vibe-harness-land-batch-[0-9a-f-]+$/iu.test(path.basename(state.candidate));
  if (state?.id !== batchId || ![1, 2, 3, 4, 5, 6].includes(state.schemaVersion)
    || state.target !== 'develop' || !sha.test(state.baseHead) || !sourcesValid || !localValid || !legacyValid) {
    return { error: transactionFailure('status', 'LAND_BATCH_STATE_INVALID', 'Invalid transaction identity or state', { batchId }) };
  }
  return { commonDir: common.path, file, state };
}
function transactionCandidateMatchesSettings(state, settings) {
  return pathKey(path.dirname(state.candidate)) === pathKey(path.dirname(settings.root));
}
const LOCAL_DEVELOP_CHECKPOINT_MESSAGE = 'chore(worktree): checkpoint local develop before merge';
function localStageReport(state, extra = {}) {
  const integrated = state.localIntegrated === true;
  return {
    schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'stage',
    delivery: { profile: 'local-land', stage: 'worktree' },
    status: integrated ? 'passed' : 'blocked', commandStatus: integrated ? 'passed' : 'blocked',
    integrationStatus: integrated ? state.cleanupPending ? 'local_integrated_cleanup_pending' : 'local_integrated' : 'not_integrated',
    localIntegrated: integrated, localMergeCommit: state.localMergeCommit ?? null,
    checkpointCommit: state.checkpointCommit ?? null, preMergeHead: state.preMergeHead,
    targetBranch: state.target, targetBefore: state.baseHead, targetAfter: state.localMergeCommit ?? null,
    batchId: state.id, phase: state.phase, conflicts: state.conflicts ?? [], cleanup: state.cleanup ?? [],
    cleanupPending: state.cleanupPending === true,
    sources: state.sources.map(({ id, branch, head, path: sourcePath, harnessOwned }) => ({
      id, branch, head, path: normalizeSlashes(sourcePath), harnessOwned: harnessOwned === true,
    })),
    ...extra,
  };
}
async function localStageSourcePlan(projectDir, args, settings, entries) {
  const sources = [];
  const blockers = [];
  for (const raw of args.task) {
    const task = parseWorktreeTask(raw);
    const entry = entries.find((item) => !item.primary && !item.prunable && !item.detached
      && typeof item.branch === 'string'
      && (pathKey(item.path) === pathKey(task.path ?? path.join(settings.root, task.id))
        || task.branch !== null && task.branch === item.branch || path.basename(item.path) === task.id));
    if (!entry || entry.branch === 'develop' || sources.some((item) => item.branch === entry.branch)) {
      blockers.push(`task ${task.id} is missing, duplicated, or targets the integration branch`);
      continue;
    }
    const [head, dirty, primaryAnchor, sourceAnchor] = await Promise.all([
      runGit(['rev-parse', `refs/heads/${entry.branch}`], projectDir),
      runGit(['status', '--porcelain=v1', '--untracked-files=all'], entry.path),
      readTaskAnchor(projectDir, task.id),
      readTaskAnchor(entry.path, task.id),
    ]);
    const anchorInfo = sourceAnchor.anchor?.executionBatch ? sourceAnchor : primaryAnchor;
    const bound = await boundParentBatches(entry.path);
    if (bound.some((batch) => batch.parentId !== task.id)) {
      blockers.push(`shared source ${entry.branch} must be staged once under its bound Parent ID`);
    }
    let executionBatch = null;
    if (anchorInfo.anchor?.executionBatch) {
      const evidence = await taskParentBatchEvidence(entry.path, task.id);
      if (args.task.length !== 1 || !evidence.ok || evidence.unmappedCommits?.length || evidence.externalPending?.length
        || evidence.members?.some((id) => !evidence.localCompleted?.includes(id))) {
        blockers.push(`Parent ${task.id} is not fully locally complete: ${evidence.reason ?? 'missing member evidence'}`);
      }
      executionBatch = {
        parentId: task.id,
        membershipDigest: evidence.membershipDigest,
        planDigest: anchorInfo.anchor.planDigest,
        members: anchorInfo.anchor.units.map(({ id, kind, localCompletion }) => ({
          id, kind, commit: localCompletion?.commit ?? null, commits: localCompletion?.commits ?? [],
          tree: localCompletion?.tree ?? null, verifiedCommit: localCompletion?.verifiedCommit ?? null,
          verificationId: localCompletion?.receipt?.verification?.id ?? null,
        })),
      };
    }
    if (!head.ok || !dirty.ok || dirty.stdout.trim()) blockers.push(`task ${task.id} does not have a clean committed source`);
    if (anchorInfo.exists && (anchorInfo.anchor?.blockers?.length
      || anchorInfo.anchor?.units?.some((unit) => unit.status !== 'done'))) {
      blockers.push(`task ${task.id} has unfinished anchor units or blockers`);
    }
    if (typeof anchorInfo.anchor?.planFile === 'string') {
      const plan = await taskPlanCheckReport(anchorInfo === sourceAnchor ? entry.path : projectDir, task.id);
      if (plan.status !== 'passed') blockers.push(`task ${task.id} plan check is ${plan.status}`);
    }
    const common = await gitCommonDir(projectDir);
    const harnessOwned = common.ok && readWorktreeOwnership(common.path).some((item) => item.created
      && item.id === task.id && item.branch === entry.branch && pathKey(item.path) === pathKey(entry.path));
    if (head.ok) sources.push({
      id: task.id, branch: entry.branch, path: entry.path, head: head.stdout.trim(), harnessOwned,
      ...(executionBatch ? { executionBatch } : {}),
    });
  }
  return { sources, blockers };
}
async function cleanupLocalStageSources(projectDir, settings, state) {
  const cleanup = [];
  const topology = await worktreeEntries(projectDir);
  const common = await gitCommonDir(projectDir);
  if (topology.reason || !common.ok) return [{ status: 'retained', reason: 'worktree topology is unavailable' }];
  const ownership = readWorktreeOwnership(common.path);
  for (const source of state.sources) {
    const completed = state.cleanup?.find((item) => item.id === source.id && item.status === 'passed');
    if (completed) {
      cleanup.push(completed);
      continue;
    }
    const item = { id: source.id, path: normalizeSlashes(source.path), status: 'retained' };
    const owner = ownership.find((record) => record.id === source.id && record.branch === source.branch
      && pathKey(record.path) === pathKey(source.path) && record.created === true);
    if (!source.harnessOwned || !owner) {
      cleanup.push({ ...item, reason: 'worktree ownership is not proven' });
      continue;
    }
    const entry = topology.entries.find((candidate) => pathKey(candidate.path) === pathKey(source.path));
    const branchHead = await runGit(['rev-parse', '--verify', `refs/heads/${source.branch}`], projectDir);
    if (branchHead.ok && branchHead.stdout.trim() !== source.head) {
      cleanup.push({ ...item, reason: 'source branch advanced after staging' });
      continue;
    }
    const merged = await runGit(['merge-base', '--is-ancestor', source.head, 'refs/heads/develop'], projectDir);
    if (!merged.ok || entry && (entry.primary || entry.branch !== source.branch || entry.locked || entry.prunable)) {
      cleanup.push({ ...item, reason: 'source identity or merge ancestry changed' });
      continue;
    }
    if (entry) {
      const gitDir = await runGit(['rev-parse', '--absolute-git-dir'], source.path);
      const dirty = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], source.path);
      if (!gitDir.ok || pathKey(gitDir.stdout.trim()) !== pathKey(owner.gitDir)
        || !dirty.ok || dirty.stdout.trim()) {
        cleanup.push({ ...item, reason: 'source worktree is dirty or ownership changed' });
        continue;
      }
      await teardownServices(projectDir, source.path, true);
      const after = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], source.path);
      if (!after.ok || after.stdout.trim()) {
        releaseServiceTeardown(projectDir, source.path);
        cleanup.push({ ...item, reason: 'source changed during service teardown' });
        continue;
      }
      removeWorktreeLinks(projectDir, source.path, settings);
      const removed = await runGit(['worktree', 'remove', source.path], projectDir);
      releaseServiceTeardown(projectDir, source.path);
      if (!removed.ok) {
        cleanup.push({ ...item, reason: boundedOutput(removed.stderr || 'worktree remove failed', projectDir) });
        continue;
      }
    } else if (existsSync(source.path)) {
      cleanup.push({ ...item, reason: 'unregistered source directory is retained' });
      continue;
    }
    const deleted = !branchHead.ok || (await runGit(['branch', '--delete', source.branch], projectDir)).ok;
    const released = await releasePortRegistryEntry(projectDir, source.id, { expectedPath: source.path });
    const passed = deleted && released.released !== false;
    if (passed) saveWorktreeOwnership(common.path, readWorktreeOwnership(common.path)
      .filter((record) => record.id !== owner.id || pathKey(record.path) !== pathKey(owner.path)));
    cleanup.push({ ...item, branchDeleted: deleted, portReleased: released.released === true,
      status: passed ? 'passed' : 'retained' });
  }
  return cleanup;
}
async function localStageWrite(projectDir, args, settings, primary, state, file) {
  if (state.localIntegrated) return localStageReport(state);
  if (state.phase === 'discarded') return batchFailure('LAND_DISCARDED', 'Start a new transaction after discard');
  const head = await runGit(['rev-parse', 'HEAD'], primary.path);
  const mergeHead = await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], primary.path);
  if (head.ok && head.stdout.trim() !== state.expectedHead && state.phase === 'checkpoint' && !mergeHead.ok) {
    const checkpoint = await runGit(['show', '-s', '--format=%P%n%s', 'HEAD'], primary.path);
    if (checkpoint.ok && checkpoint.stdout.trim() === `${state.expectedHead}\n${LOCAL_DEVELOP_CHECKPOINT_MESSAGE}`) {
      state.checkpointCommit = head.stdout.trim();
      state.baseHead = state.checkpointCommit;
      state.expectedHead = state.checkpointCommit;
      state.phase = 'merging';
      saveBatchState(file, state);
    }
  }
  if (state.phase === 'merging' && mergeHead.ok && mergeHead.stdout.trim() === state.sources[state.next]?.head) {
    state.phase = 'conflict';
    saveBatchState(file, state);
  }
  if (head.ok && head.stdout.trim() !== state.expectedHead && state.phase === 'conflict' && !mergeHead.ok) {
    const parents = await runGit(['show', '-s', '--format=%P', 'HEAD'], primary.path);
    const clean = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], primary.path);
    if (parents.ok && parents.stdout.trim() === `${state.expectedHead} ${state.sources[state.next]?.head}`
      && clean.ok && !clean.stdout.trim()) {
      state.expectedHead = head.stdout.trim();
      state.next += 1;
      state.phase = 'merging';
      saveBatchState(file, state);
    }
  }
  if (!head.ok || head.stdout.trim() !== state.expectedHead) {
    return batchFailure('LAND_LOCAL_HEAD_CHANGED', 'Local develop changed outside this transaction', { batchId: state.id });
  }
  if (state.phase === 'checkpoint') {
    if (mergeHead.ok) return batchFailure('LAND_MERGE_IN_PROGRESS', 'Resolve the existing merge first', { batchId: state.id });
    const dirty = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], primary.path);
    if (!dirty.ok) return batchFailure('LAND_LOCAL_STATUS_UNAVAILABLE', 'Cannot inspect local develop');
    if (dirty.stdout.trim()) {
      const added = await runGit(['add', '-A'], primary.path);
      const checkpoint = added.ok ? await runGit(['commit', '-m', LOCAL_DEVELOP_CHECKPOINT_MESSAGE], primary.path) : added;
      if (!checkpoint.ok) return batchFailure('LAND_LOCAL_CHECKPOINT_FAILED',
        boundedOutput(checkpoint.stderr || 'checkpoint commit failed', projectDir), { batchId: state.id });
      const checkpointHead = await runGit(['rev-parse', 'HEAD'], primary.path);
      if (!checkpointHead.ok) return batchFailure('LAND_LOCAL_HEAD_UNRESOLVED', 'Cannot resolve checkpoint commit', { batchId: state.id });
      state.checkpointCommit = checkpointHead.stdout.trim();
      state.expectedHead = state.checkpointCommit;
      state.baseHead = state.checkpointCommit;
    }
    state.phase = 'merging';
    saveBatchState(file, state);
  }
  if (state.phase === 'conflict') {
    const source = state.sources[state.next];
    const unresolved = await runGit(['diff', '--name-only', '--diff-filter=U'], primary.path);
    if (!mergeHead.ok || mergeHead.stdout.trim() !== source?.head) {
      return batchFailure('LAND_LOCAL_CONFLICT_STATE_INVALID', 'The active merge does not belong to this transaction', { batchId: state.id });
    }
    if (!unresolved.ok || unresolved.stdout.trim()) {
      return localStageReport(state, { code: 'LAND_LOCAL_CONFLICT', error: 'Resolve and stage all conflicts before resuming' });
    }
    const unstaged = await runGit(['diff', '--quiet'], primary.path);
    if (!unstaged.ok) return batchFailure('LAND_LOCAL_UNSTAGED_RESOLUTION', 'Stage resolved files before resuming', { batchId: state.id });
    const committed = await runGit(['commit', '--no-edit'], primary.path);
    if (!committed.ok) return batchFailure('LAND_LOCAL_MERGE_COMMIT_FAILED', boundedOutput(committed.stderr, projectDir), { batchId: state.id });
    state.expectedHead = (await runGit(['rev-parse', 'HEAD'], primary.path)).stdout.trim();
    state.next += 1;
    state.phase = 'merging';
    saveBatchState(file, state);
  } else if (mergeHead.ok) {
    return batchFailure('LAND_MERGE_IN_PROGRESS', 'An unfinished merge must be resolved before staging', { batchId: state.id });
  }
  while (state.next < state.sources.length) {
    const source = state.sources[state.next];
    const dirty = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], primary.path);
    if (!dirty.ok || dirty.stdout.trim()) return batchFailure('LAND_LOCAL_DIRTY', 'Local develop changed during integration', { batchId: state.id });
    if (!(await runGit(['merge-base', '--is-ancestor', source.head, 'HEAD'], primary.path)).ok) {
      const merged = await runGit(['merge', '--no-ff', '--no-commit', source.head], primary.path);
      const active = await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], primary.path);
      if (active.ok && active.stdout.trim() === source.head) {
        state.phase = 'conflict';
        const unresolved = await runGit(['diff', '--name-only', '--diff-filter=U'], primary.path);
        if (unresolved.stdout.trim()) state.conflicts.push({ task: source.id,
          files: unresolved.stdout.trim().split(/\r?\n/u), at: new Date().toISOString() });
        saveBatchState(file, state);
        if (!merged.ok) return localStageReport(state, { code: 'LAND_LOCAL_CONFLICT',
          error: 'Resolve and stage conflicts in local develop, then rerun stage --resume <batchId> --write', resumable: true });
        const committed = await runGit(['commit', '--no-edit'], primary.path);
        if (!committed.ok) return batchFailure('LAND_LOCAL_MERGE_COMMIT_FAILED',
          boundedOutput(committed.stderr, projectDir), { batchId: state.id, resumable: true });
      } else if (!merged.ok) return batchFailure('LAND_LOCAL_MERGE_FAILED',
        boundedOutput(merged.stderr, projectDir), { batchId: state.id });
    }
    state.expectedHead = (await runGit(['rev-parse', 'HEAD'], primary.path)).stdout.trim();
    state.next += 1;
    state.phase = 'merging';
    saveBatchState(file, state);
  }
  state.localMergeCommit = state.expectedHead;
  state.localIntegrated = true;
  state.cleanupPending = true;
  state.phase = 'local_integrated_cleanup_pending';
  state.integrationStatus = state.phase;
  saveBatchState(file, state);
  state.cleanup = await attemptLocalCleanup(projectDir, settings, state);
  state.cleanupPending = state.cleanup.some((item) => item.status !== 'passed');
  state.phase = state.cleanupPending ? 'local_integrated_cleanup_pending' : 'local_integrated';
  state.integrationStatus = state.phase;
  saveBatchState(file, state);
  return localStageReport(state);
}
async function worktreeLocalStageReport(projectDir, args) {
  if (args.delivery && args.delivery !== 'local-land') return batchFailure('LAND_BATCH_DELIVERY', 'Stage uses local-land only');
  if (args.baseRef !== undefined && args.baseRef !== 'develop') return batchFailure('LAND_LOCAL_TARGET', 'Stage targets local develop only');
  if (args.resume !== undefined && (!args.write || args.task.length > 0)) return batchFailure('LAND_BATCH_RESUME_OPTIONS', '--resume requires --write and no --task');
  if (args.resume === undefined && (!args.task.length || args.task.length > 32
    || new Set(args.task.map((item) => parseWorktreeTask(item).id)).size !== args.task.length)) {
    return batchFailure('LAND_BATCH_TASKS', 'Stage needs 1–32 distinct --task values');
  }
  const topology = await worktreeEntries(projectDir);
  const primary = topology.entries?.find((entry) => entry.primary);
  if (topology.reason || !primary?.path) return batchFailure('LAND_BATCH_WORKTREES', topology.reason ?? 'Primary checkout unavailable');
  projectDir = primary.path;
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return batchFailure('LAND_BATCH_SETTINGS', settings.error);
  const branch = await runGit(['symbolic-ref', '--short', 'HEAD'], primary.path);
  if (!branch.ok || branch.stdout.trim() !== 'develop') return batchFailure('LAND_LOCAL_TARGET', 'Primary checkout must be on local develop');
  const common = await gitCommonDir(projectDir);
  if (!common.ok) return batchFailure('LAND_BATCH_COMMON_DIR', common.error);
  let state;
  let file;
  if (args.resume !== undefined) {
    const loaded = await readLandTransaction(projectDir, args.resume);
    if (loaded.error) return loaded.error;
    ({ state, file } = loaded);
    if (state.localOnly !== true) return resumeLegacyConflict(projectDir, settings, state, file);
    if (pathKey(state.primaryPath) !== pathKey(primary.path)) return batchFailure('LAND_LOCAL_STATE_INVALID', 'Primary checkout changed');
  } else {
    for (const name of readdirSync(common.path).filter((item) => /^vibe-harness-land-batch-.*\.json$/u.test(item))) {
      let existing;
      try { existing = JSON.parse(readFileSync(path.join(common.path, name), 'utf8')); }
      catch { return batchFailure('LAND_LOCAL_STATE_INVALID', 'An existing transaction is unreadable'); }
      if (existing.localOnly && !existing.localIntegrated && existing.phase !== 'discarded') {
        return batchFailure('LAND_LOCAL_ACTIVE_TRANSACTION', 'Resume or discard the unfinished local transaction', { batchId: existing.id });
      }
    }
    const planned = await localStageSourcePlan(projectDir, args, settings, topology.entries);
    if (planned.blockers.length || planned.sources.length !== args.task.length) return batchFailure('LAND_BATCH_PREFLIGHT', planned.blockers.join('; '));
    const active = await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], primary.path);
    if (active.ok) return batchFailure('LAND_MERGE_IN_PROGRESS', 'Resolve the existing merge first');
    if (!args.write) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'stage',
      status: 'planned', targetBranch: 'develop', sources: planned.sources, localOnly: true, write: false,
      delivery: { profile: 'local-land', stage: 'worktree' } };
    const before = await runGit(['rev-parse', 'HEAD'], primary.path);
    if (!before.ok) return batchFailure('LAND_LOCAL_HEAD_UNRESOLVED', 'Cannot resolve local develop');
    const id = randomUUID();
    state = { schemaVersion: LAND_TRANSACTION_SCHEMA_VERSION, localOnly: true, id, target: 'develop',
      primaryPath: primary.path, baseHead: before.stdout.trim(), preMergeHead: before.stdout.trim(),
      expectedHead: before.stdout.trim(), checkpointCommit: null, sources: planned.sources,
      next: 0, phase: 'checkpoint', conflicts: [], localIntegrated: false, integrationStatus: 'not_integrated',
      startedAt: new Date().toISOString() };
    file = batchStatePath(common.path, id);
    saveBatchState(file, state);
  }
  return localStageWrite(projectDir, args, settings, primary, state, file);
}
async function worktreeStageReport(projectDir, args) {
  return worktreeLocalStageReport(projectDir, args);
}












async function worktreeBatchCleanupReport(projectDir, args) {
  const loaded = await readLandTransaction(projectDir, args.batch);
  if (loaded.error) return loaded.error;
  const { state, file } = loaded;
  if (!state.localOnly) return legacyTransactionReport(state, 'cleanup');
  if (!state.localIntegrated) return transactionFailure('cleanup', 'LAND_CLEANUP_NOT_INTEGRATED', 'Complete the local merge first');
  if (!args.write) return { ...localStageReport(state), subcommand: 'cleanup', status: 'planned', write: false };
  const topology = await worktreeEntries(projectDir);
  const primary = topology.entries?.find((entry) => entry.primary);
  if (!primary || pathKey(primary.path) !== pathKey(state.primaryPath)) return transactionFailure('cleanup', 'LAND_LOCAL_STATE_INVALID', 'Primary checkout changed');
  const settings = resolveWorktreeSettings(primary.path, await readProjectConfig(primary.path), args);
  if (settings.error) return transactionFailure('cleanup', 'LAND_SETTINGS', settings.error);
  state.cleanup = await attemptLocalCleanup(primary.path, settings, state);
  state.cleanupPending = state.cleanup.some((item) => item.status !== 'passed');
  state.phase = state.cleanupPending ? 'local_integrated_cleanup_pending' : 'local_integrated';
  state.integrationStatus = state.phase;
  saveBatchState(file, state);
  return { ...localStageReport(state), subcommand: 'cleanup' };
}


async function worktreeStageStatusReport(projectDir, args) {
  const loaded = await readLandTransaction(projectDir, args.batch);
  if (loaded.error) return loaded.error;
  const { state } = loaded;
  if (!state.localOnly) return legacyTransactionReport(state, 'status');
  const head = await runGit(['rev-parse', 'refs/heads/develop'], projectDir);
  return { ...localStageReport(state), subcommand: 'status', status: 'passed', commandStatus: 'passed',
    localHead: head.ok ? head.stdout.trim() : null };
}
async function worktreeDiscardReport(projectDir, args) {
  if (!args.write) return transactionFailure('discard', 'LAND_WRITE_REQUIRED', 'discard requires --write');
  const loaded = await readLandTransaction(projectDir, args.batch);
  if (loaded.error) return loaded.error;
  const { file, state } = loaded;
  if (!state.localOnly) {
    const settings = resolveWorktreeSettings(projectDir, await readProjectConfig(projectDir), args);
    const topology = await worktreeEntries(projectDir);
    if (settings.error || !transactionCandidateMatchesSettings(state, settings)) return legacyTransactionReport(state, 'discard');
    for (const candidate of [state.candidate, ...(state.previousCandidates ?? [])]) {
      if (typeof candidate !== 'string' || !transactionCandidateMatchesSettings({ candidate }, settings)
        || !/^\.vibe-harness-land-batch-[0-9a-f-]+$/iu.test(path.basename(candidate))) {
        return transactionFailure('discard', 'LAND_BATCH_STATE_INVALID', 'Legacy candidate path is outside the transaction root');
      }
      if (!existsSync(candidate)) continue;
      const entry = topology.entries?.find((item) => item.detached && pathKey(item.path) === pathKey(candidate));
      const clean = entry && await runGit(['status', '--porcelain=v1', '--untracked-files=all'], candidate);
      if (!clean?.ok || clean.stdout.trim()) return transactionFailure('discard', 'LAND_DISCARD_CANDIDATE_DIRTY', 'Legacy candidate must be clean before safe discard');
      const removed = await cleanupLandCandidate(projectDir, candidate, { settings });
      if (!removed.removed) return transactionFailure('discard', 'LAND_DISCARD_CLEANUP_INCOMPLETE', removed.reason);
    }
    state.phase = 'discarded';
    saveBatchState(file, state);
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'discard', status: 'passed',
      batchId: state.id, discarded: true, sourcesRetained: true };
  }
  if (state.localIntegrated) return transactionFailure('discard', 'LAND_ALREADY_INTEGRATED', 'Discard never rolls back local commits');
  const topology = await worktreeEntries(projectDir);
  const primary = topology.entries?.find((entry) => entry.primary);
  if (!primary || pathKey(primary.path) !== pathKey(state.primaryPath)) {
    return transactionFailure('discard', 'LAND_LOCAL_STATE_INVALID', 'Primary checkout changed');
  }
  const branch = await runGit(['symbolic-ref', '--short', 'HEAD'], state.primaryPath);
  const head = await runGit(['rev-parse', 'HEAD'], state.primaryPath);
  if (!branch.ok || branch.stdout.trim() !== 'develop' || !head.ok || head.stdout.trim() !== state.expectedHead) {
    return transactionFailure('discard', 'LAND_LOCAL_HEAD_CHANGED', 'Local develop changed outside this transaction');
  }
  if (state.phase === 'conflict') {
    const active = await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], state.primaryPath);
    if (!active.ok || active.stdout.trim() !== state.sources[state.next]?.head) return transactionFailure('discard', 'LAND_LOCAL_CONFLICT_STATE_INVALID', 'Active merge does not match this transaction');
    const aborted = await runGit(['merge', '--abort'], state.primaryPath);
    if (!aborted.ok) return transactionFailure('discard', 'LAND_LOCAL_ABORT_FAILED', boundedOutput(aborted.stderr, projectDir));
  }
  state.phase = 'discarded';
  saveBatchState(file, state);
  return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'discard', status: 'passed',
    batchId: state.id, discarded: true, checkpointCommit: state.checkpointCommit,
    preservedHead: state.expectedHead, sourcesRetained: true };
}

/**
 * Crash recovery for worktree provisioning (docs/rules/git-rules.md §Worktree).
 *
 * A hard kill bypasses the in-process rollback a failed bootstrap runs, so the
 * repository can be left with prunable worktree residue (directory gone, Git
 * metadata and branch binding left), worktrees whose provisioning stopped
 * before the locked registry/env write, zero-commit branches only that residue
 * still references, and registry entries whose worktree no longer exists.
 * Every category is detected from evidence (git listings, the port registry,
 * the filesystem) and nothing is touched without `--write`; a branch is only
 * ever deleted after being proven to sit at the base ref with a clean tree,
 * so no work can be lost.
 */
async function worktreeRecoverReport(projectDir, args) {
  if (args.task.length > 1 || args.all && args.task.length
    || args.write && !args.all && !args.task.length) {
    return transactionFailure('recover', 'WORKTREE_RECOVER_SCOPE_REQUIRED', 'Use one --task or explicit --all for recovery writes');
  }
  return worktreeRecoverReportUnlocked(projectDir, args);
}
async function worktreeRecoverReportUnlocked(projectDir, args) {
  const topology = await worktreeEntries(projectDir);
  const primary = topology.entries?.find((entry) => entry.primary);
  const common = await gitCommonDir(projectDir);
  if (topology.reason || !primary || !common.ok) return transactionFailure('recover', 'WORKTREE_RECOVER_UNAVAILABLE', 'Cannot inspect worktree ownership');
  projectDir = primary.path;
  const settings = resolveWorktreeSettings(projectDir, await readProjectConfig(projectDir), args);
  if (settings.error) return transactionFailure('recover', 'LAND_SETTINGS', settings.error);
  const taskId = args.task.length ? parseWorktreeTask(args.task[0]).id : null;
  const ownership = readWorktreeOwnership(common.path);
  const transactions = [];
  const retainedPaths = new Set();
  for (const name of readdirSync(common.path).filter((item) => /^vibe-harness-land-batch-.*\.json$/u.test(item))) {
    let state;
    try { state = JSON.parse(readFileSync(path.join(common.path, name), 'utf8')); }
    catch { return transactionFailure('recover', 'LAND_BATCH_STATE_INVALID', 'An existing transaction is unreadable'); }
    for (const source of state.sources ?? []) if (source.path) retainedPaths.add(pathKey(source.path));
    if (taskId && !state.sources?.some((source) => source.id === taskId)) continue;
    transactions.push({ id: state.id, phase: state.phase, status: 'preserved',
      reason: state.localOnly ? 'Use stage --resume, cleanup --batch or discard --batch' : '旧远端事务需迁移' });
  }
  const results = [];
  for (const owner of ownership.filter((item) => item.created && (!taskId || item.id === taskId))) {
    if (retainedPaths.has(pathKey(owner.path))) continue;
    const entry = topology.entries.find((item) => pathKey(item.path) === pathKey(owner.path));
    if (entry && (entry.primary || entry.locked || entry.branch !== owner.branch)) continue;
    const head = await runGit(['rev-parse', `refs/heads/${owner.branch}`], projectDir);
    const merged = head.ok && await runGit(['merge-base', '--is-ancestor', head.stdout.trim(), 'refs/heads/develop'], projectDir);
    if (!merged?.ok || !entry || entry.prunable) {
      results.push({ id: owner.id, path: owner.path, status: 'retained', reason: 'Source identity or local ancestry is unproven' });
      continue;
    }
    if (!args.write) { results.push({ id: owner.id, path: owner.path, status: 'planned' }); continue; }
    results.push(...await cleanupLocalStageSources(projectDir, settings, {
      localMergeCommit: (await runGit(['rev-parse', 'refs/heads/develop'], projectDir)).stdout.trim(),
      sources: [{ ...owner, head: head.stdout.trim(), harnessOwned: true }],
    }));
  }
  return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'recover',
    status: args.write ? 'passed' : 'planned', transactions, results, write: Boolean(args.write) };
}
async function dispatchWorktreeReport(projectDir, subcommand, args) {
  if (subcommand === 'list') return worktreeListReport(projectDir);
  if (subcommand === 'check') return worktreeCheckReport(projectDir, args);
  if (subcommand === 'bootstrap') return worktreeBootstrapReport(projectDir, args);
  if (subcommand === 'stage') return worktreeStageReport(projectDir, args);
  if (subcommand === 'status') return worktreeStageStatusReport(projectDir, args);
  if (subcommand === 'discard') return worktreeDiscardReport(projectDir, args);
  if (subcommand === 'cleanup') return worktreeCleanupReport(projectDir, args);
  if (subcommand === 'recover') return worktreeRecoverReport(projectDir, args);
  throw new Error(`Unknown worktree subcommand: ${subcommand} (expected list, check, bootstrap, stage, status, discard, cleanup or recover)`);
}
export async function worktreeReport(projectDir, args) {
  const subcommand = args._[1] ?? 'check';
  if (['land', 'publish'].includes(subcommand)) return transactionFailure(subcommand, 'WORKTREE_COMMAND_RETIRED', 'Use local worktree stage; legacy remote transactions require migration');
  if (args.push || args.targetMode !== undefined || args.archiveIntegrated || args.supersede) {
    return transactionFailure(subcommand, 'WORKTREE_OPTION_RETIRED', 'Remote delivery options are not supported');
  }
  if (args.batch !== undefined && (typeof args.batch !== 'string' || !['status', 'discard', 'cleanup'].includes(subcommand))
    || args.resume !== undefined && subcommand !== 'stage') {
    return transactionFailure(subcommand, 'WORKTREE_BATCH_INVALID', 'Use --batch <id> for status/discard/cleanup or --resume <id> for stage');
  }
  const dispatch = () => subcommand === 'cleanup' && args.batch
    ? worktreeBatchCleanupReport(projectDir, args) : dispatchWorktreeReport(projectDir, subcommand, args);
  if (!args.write || !['stage', 'cleanup', 'discard', 'recover'].includes(subcommand)) return dispatch();
  const common = await gitCommonDir(projectDir);
  if (!common.ok) return transactionFailure(subcommand, 'LAND_BATCH_COMMON_DIR', common.error);
  const lock = path.join(common.path, 'vibe-harness-local-integration.lock');
  const lease = await acquireLeaseWithRetry(lock, { timeoutMs: landLockTimeoutMs(), retryMs: LAND_LOCK_RETRY_MS, leaseMs: DEFAULT_LEASE_MS });
  if (!lease.ok) return transactionFailure(subcommand, 'LAND_BATCH_LOCK', 'Another local operation owns develop');
  const heartbeat = startLeaseHeartbeats([lock], DEFAULT_LEASE_MS)[0];
  try { return await dispatch(); } finally { heartbeat.stop(); releaseLease(lock); }
}

function readWorktreeOwnership(commonDir) {
  try { return JSON.parse(readFileSync(path.join(commonDir, 'vibe-harness-worktree-ownership.json'), 'utf8')); }
  catch { return []; }
}
function saveWorktreeOwnership(commonDir, records) {
  saveBatchState(path.join(commonDir, 'vibe-harness-worktree-ownership.json'), records);
}
function legacyTransactionReport(state, subcommand) {
  return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand, status: 'blocked',
    code: 'WORKTREE_LEGACY_TRANSACTION', error: '旧远端事务需迁移',
    batchId: state.id, legacyPhase: state.phase, integrationStatus: 'not_integrated',
    sources: state.sources.map(({ id, branch, head }) => ({ id, branch, head })) };
}

async function attemptLocalCleanup(projectDir, settings, state) {
  try { return await cleanupLocalStageSources(projectDir, settings, state); }
  catch {
    return [{ status: 'retained', reason: 'Cleanup failed; local integration is preserved, retry cleanup --batch' }];
  }
}

async function resumeLegacyConflict(projectDir, settings, state, file) {
  const report = legacyTransactionReport(state, 'stage');
  if (state.phase !== 'conflict' || !transactionCandidateMatchesSettings(state, settings)) return report;
  const topology = await worktreeEntries(projectDir);
  const candidate = topology.entries?.find((entry) => entry.detached && pathKey(entry.path) === pathKey(state.candidate));
  if (!candidate) return report;
  const mergeHead = await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], candidate.path);
  const unresolved = await runGit(['diff', '--name-only', '--diff-filter=U'], candidate.path);
  const unstaged = await runGit(['diff', '--quiet'], candidate.path);
  if (!mergeHead.ok || mergeHead.stdout.trim() !== state.sources[state.next]?.head
    || !unresolved.ok || unresolved.stdout.trim() || !unstaged.ok) return report;
  const committed = await runGit(['commit', '--no-edit'], candidate.path);
  if (!committed.ok) return report;
  state.phase = 'legacy_conflict_resolved';
  saveBatchState(file, state);
  return { ...report, conflictResolved: true };
}
