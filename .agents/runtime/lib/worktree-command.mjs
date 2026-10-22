// Worktree inspection, provisioning, landing and recovery.
//
// The lifecycle commands share one model: workspace topology discovery, dependency
// mirrors, port blocks, the shared land lock and the land/candidate steps that
// verify a merge before the primary checkout moves.
//
// Extracted verbatim from `runtime/commands/run.mjs` so that file keeps only
// argument parsing, dispatch and output selection. Behaviour, field names and
// exit codes are unchanged; only the module boundary moved.
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { gitFingerprint } from './git-fingerprint.mjs';
import { attestCompletionProvenance, recordFinalVerification } from './verification-receipt.mjs';
import { verificationLockStatus } from './verification-lock.mjs';
import { completionReceipt, isReviewRequired, resolveDelivery, validateCompletion } from './delivery.mjs';
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
import { CONFIG_FILE, PASS_STATUSES, SCHEMA_VERSION, assertSafeCommand, delay, isInsidePath, normalizeSlashes, packageManager, probeExecutable, readProjectConfig, runFile, runGit, safeRealpath } from './cli-runtime.mjs';
import { gitTimeoutMs } from './git-timeouts.mjs';
import {
  acquireLease,
  acquireLeaseWithRetry,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  readLease,
  releaseLease,
  startLeaseHeartbeat,
} from './lease-lock.mjs';
import { TASK_UNIT_FAILURE_STATUSES, planDependentUnits, planUnitGraph, readTaskAnchor, taskAnchorRelativePath, taskCheckpointReport, taskPlanCheckReport } from './task-command.mjs';
import { verifyProject } from './verification-command.mjs';
import { configuredChecks, executeCommand, parseVerifyTier, resolveReceiptTier, resolveReviewedChecks, timeoutValue } from './verification-plan-support.mjs';

// A peer `worktree land` holds the shared lock across its merge, verification
// and cleanup, so the wait budget is sized for a full landing instead of a
// filesystem round trip: a second land retries until this deadline and only
// then reports LAND_LOCK_TIMEOUT. The parent-owned environment knob can only
// shorten it, which is how tests hold the lock on purpose.
const LAND_LOCK_TIMEOUT_MS = 180_000;
const LAND_PHASE2_LEASE_MS = 60_000;
const LAND_LOCK_RETRY_MS = 50;
const LAND_MAX_ATTEMPTS = 3;
// --- worktree / slice / patch (P0) -----------------------------------------
//
// These commands replace the throwaway scripts an agent used to write into the
// project itself: `git worktree add` plus a hand-built `node_modules` junction
// per worktree, and inline `node -e` snippets that sliced or rewrote files.
// Every command is read-only unless `--write` is passed; nothing here removes a
// branch, and `worktree cleanup` refuses while a branch has not landed.

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
    baseRef: args.baseRef ?? configured.baseRef ?? 'origin/develop',
    configuredRoot: args.root ?? configured.root ?? null,
    dependencyRoots,
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
    },
    projectDir,
    root: resolveWorktreeRoot(projectDir, args.root ?? configured.root),
    unknownLocalPackages: unknown,
    // Every discovered workspace package, so `link-package-roots` can project
    // the per-package `node_modules` of an isolated layout.
    workspacePackages: discovered.packages,
  };
}
async function worktreeEntries(projectDir) {
  const top = await runGit(['rev-parse', '--show-toplevel'], projectDir);
  if (!top.ok) return { entries: [], repositoryRoot: null, reason: 'not-a-git-worktree' };
  const listing = await runFile('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: projectDir, timeoutMs: gitTimeoutMs() });
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
  writeFileSync(file, `${JSON.stringify({ ...registry, entries }, null, 2)}\n`, 'utf8');
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
function releasePortRegistryEntry(projectDir, id) {
  return withPortRegistryLock(projectDir, async () => {
    const info = readPortRegistry(projectDir);
    if (!info.registry) return { released: false, reason: info.error ?? 'no registry' };
    const entries = info.registry.entries.filter((entry) => entry.id !== id);
    if (entries.length === info.registry.entries.length) return { released: false, reason: 'no entry' };
    writePortRegistry(projectDir, { ...info.registry, entries });
    return { released: true };
  });
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
async function worktreeCleanupReport(projectDir, args) {
  if (args.write && !args.cleanupLocked) {
    return withWorktreeLandLock(projectDir, () => worktreeCleanupReport(projectDir, { ...args, cleanupLocked: true }));
  }
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
/**
 * Land a finished worktree back onto the primary checkout's current branch
 * (docs/rules/git-rules.md §Worktree): merge --no-ff, run the verify gate,
 * optionally push, then remove the worktree and — only after a successful
 * push — delete its branch. Every step re-checks its evidence, so a failed
 * run is safe to retry: an already-merged branch skips the candidate merge,
 * and a run interrupted after the push retries with just cleanup and delete.
 * Without --write the report is the ordered plan; without --push the branch
 * survives with a suggested command instead of being deleted.
 */
// Branches a direct local land must never merge into because a server-side
// review or release gate protects them. `develop` is deliberately excluded
// (ADR-0013): the integration branch accepts direct no-ff landings so a task
// branch does not need a round-trip through an MR. The allowlist below records
// that decision explicitly so a later widening of the pattern cannot silently
// re-block it, and `isLandProtectedBranch` keeps the target rejection and the
// tracking-push allowance sourced from the same predicate.
const LAND_PROTECTED_BRANCH_PATTERN = /^(?:main|master|release(?:[-/].+)?)$/iu;
const LAND_PROTECTED_BRANCH_ALLOWLIST = new Set(['develop']);
function isLandProtectedBranch(branch) {
  if (LAND_PROTECTED_BRANCH_ALLOWLIST.has(String(branch ?? '').toLowerCase())) return false;
  return LAND_PROTECTED_BRANCH_PATTERN.test(branch);
}
async function gitCommonDir(projectDir) {
  const result = await runGit(['rev-parse', '--git-common-dir'], projectDir);
  if (!result.ok || result.stdout.trim() === '') return { ok: false, error: boundedOutput(result.stderr || result.error?.message || 'cannot resolve git common dir', projectDir) };
  return { ok: true, path: path.resolve(projectDir, result.stdout.trim()) };
}

/**
 * Merge without repository hooks.
 *
 * A candidate merge must not run formatters, generators or installers that a
 * developer wired into pre-commit/post-merge: those write through the shared
 * dependency junctions and turn a read-only merge into a mutation of the main
 * checkout's `node_modules`. `--no-verify` covers commit hooks; an empty
 * `core.hooksPath` also covers post-merge/checkout hooks and the LEFTHOOK/HUSKY
 * switches cover managers that ignore Git's hooks directory.
 */
async function runIsolatedGit(projectDir, args, cwd = projectDir) {
  const common = await gitCommonDir(projectDir);
  const hooksDirectory = common.ok ? path.join(common.path, 'vibe-harness-empty-hooks') : null;
  if (hooksDirectory) {
    try {
      mkdirSync(hooksDirectory, { recursive: true });
    } catch {
      // A hooks directory that cannot be created leaves the empty -c value in
      // place; Git then reports the failure instead of silently running hooks.
    }
  }
  return runGit(['-c', hooksDirectory ? `core.hooksPath=${hooksDirectory}` : 'core.hooksPath=', ...args], cwd, {
    env: { LEFTHOOK: '0', HUSKY: '0' },
  });
}

function candidateResidue(settings, taskId) {
  const parent = path.dirname(settings.root);
  const prefix = `.vibe-harness-land-${taskId}-`.toLowerCase();
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix))
      .map((entry) => path.join(parent, entry.name));
  } catch {
    return [];
  }
}

function dependencyRootBlockers(projectDir, worktreePath, settings) {
  if ((settings.provision?.setupCommands ?? []).length > 0) return [];
  const blockers = [];
  for (const root of settings.dependencyRoots) {
    for (const [label, base] of [['main checkout', projectDir], ['worktree', worktreePath]]) {
      const modules = path.join(base, root, 'node_modules');
      if (!existsSync(modules)) {
        blockers.push({ code: 'LAND_DEPENDENCY_ROOT_MISSING', root, location: label, message: `${root === '.' ? '' : `${root}/`}node_modules is absent in the ${label} ${normalizeSlashes(base)}; install dependencies or declare worktree.provision.setupCommands before landing` });
        continue;
      }
      try {
        const info = lstatSync(modules);
        if (info.isSymbolicLink() && !safeRealpath(modules)) {
          blockers.push({ code: 'LAND_DEPENDENCY_JUNCTION_BROKEN', root, location: label, message: `${root === '.' ? '' : `${root}/`}node_modules is a broken link in the ${label} ${normalizeSlashes(base)}` });
        }
      } catch (error) {
        blockers.push({ code: 'LAND_DEPENDENCY_ROOT_UNREADABLE', root, location: label, message: `${root === '.' ? '' : `${root}/`}node_modules cannot be inspected in the ${label}: ${error.message}` });
      }
    }
  }
  return blockers;
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

function targetRefLockPath(gitCommonDirPath, targetRef) {
  const refHash = createHash('sha256').update(targetRef).digest('hex').slice(0, 24);
  return path.join(gitCommonDirPath, `vibe-harness-land-${refHash}.lock`);
}

function targetRefLockPaths(gitCommonDirPath, targetRef) {
  const legacyHash = createHash('sha1').update(targetRef).digest('hex').slice(0, 12);
  const legacyPath = path.join(gitCommonDirPath, `vibe-harness-land-${legacyHash}.lock`);
  const currentPath = targetRefLockPath(gitCommonDirPath, targetRef);
  // Keep the old path as a compatibility fence so an already-running runtime
  // using the SHA-1 name still coordinates with this process.
  return [...new Set([legacyPath, currentPath])];
}

function landCandidateActivityLockPath(gitCommonDirPath, candidateId) {
  return path.join(gitCommonDirPath, `vibe-harness-land-candidate-${candidateId}.lock`);
}

function leaseHeartbeatIntervalMs(leaseMs) {
  return Math.max(1, Math.min(DEFAULT_HEARTBEAT_MS, Math.floor(leaseMs / 3)));
}

function startLeaseHeartbeats(lockPaths, leaseMs) {
  return lockPaths.map((lockPath) => startLeaseHeartbeat(lockPath, {
    heartbeatMs: leaseHeartbeatIntervalMs(leaseMs),
  }));
}

async function acquireLandCandidateActivityLease(projectDir, candidateId) {
  const common = await gitCommonDir(projectDir);
  if (!common.ok) {
    return { held: false, code: 'LAND_CANDIDATE_LOCK_UNAVAILABLE', blockers: [common.error] };
  }
  const lockPath = landCandidateActivityLockPath(common.path, candidateId);
  const result = acquireLease(lockPath, { leaseMs: DEFAULT_LEASE_MS });
  if (!result.held) {
    return {
      held: false,
      code: 'LAND_CANDIDATE_LOCK_UNAVAILABLE',
      blockers: [`cannot acquire candidate activity lease ${normalizeSlashes(lockPath)}: ${result.reason ?? 'lock is held'}`],
    };
  }
  const heartbeat = startLeaseHeartbeats([lockPath], DEFAULT_LEASE_MS)[0];
  return {
    held: true,
    lockPath,
    leaseHealthy: () => !heartbeat.lost,
    stopHeartbeat: () => heartbeat.stop(),
  };
}

async function acquirePhase2Lock(projectDir, targetRef) {
  const common = await gitCommonDir(projectDir);
  if (!common.ok) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'worktree',
      subcommand: 'land',
      status: 'blocked',
      code: 'LAND_LOCK_UNAVAILABLE',
      blockers: [common.error],
    };
  }
  const lockPaths = targetRefLockPaths(common.path, targetRef);
  const timeoutMs = landLockTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  const heldPaths = [];
  for (const lockPath of lockPaths) {
    const result = await acquireLeaseWithRetry(lockPath, {
      timeoutMs: Math.max(0, deadline - Date.now()),
      retryMs: LAND_LOCK_RETRY_MS,
      leaseMs: LAND_PHASE2_LEASE_MS,
    });
    if (!result.ok) {
      for (const heldPath of heldPaths) releaseLease(heldPath);
      return {
        schemaVersion: SCHEMA_VERSION,
        command: 'worktree',
        subcommand: 'land',
        status: 'blocked',
        code: result.code === 'LEASE_UNAVAILABLE' ? 'LAND_LOCK_UNAVAILABLE' : 'LAND_LOCK_TIMEOUT',
        blockers: [`${normalizeSlashes(lockPath)} could not be acquired${result.code === 'LEASE_UNAVAILABLE' ? `: ${result.error}` : ` after ${timeoutMs}ms`}`],
      };
    }
    heldPaths.push(lockPath);
  }
  return { held: true, lockPaths, leaseMs: LAND_PHASE2_LEASE_MS };
}
async function withWorktreeLandLock(projectDir, action) {
  const common = await gitCommonDir(projectDir);
  if (!common.ok) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'worktree',
      subcommand: 'land',
      status: 'blocked',
      code: 'LAND_LOCK_UNAVAILABLE',
      blockers: [common.error],
    };
  }
  const lockPath = path.join(common.path, 'vibe-harness-worktree-land.lock');
  const timeoutMs = landLockTimeoutMs();
  const result = await acquireLeaseWithRetry(lockPath, {
    timeoutMs,
    retryMs: LAND_LOCK_RETRY_MS,
    leaseMs: DEFAULT_LEASE_MS,
  });
  if (!result.ok) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'worktree',
      subcommand: 'land',
      status: 'blocked',
      code: result.code === 'LEASE_UNAVAILABLE' ? 'LAND_LOCK_UNAVAILABLE' : 'LAND_LOCK_TIMEOUT',
      blockers: [result.code === 'LEASE_UNAVAILABLE'
        ? `cannot create shared land lock: ${result.error}`
        : `${normalizeSlashes(lockPath)} is held by another land operation after ${timeoutMs}ms; inspect the owner before removing the lock`],
    };
  }
  const heartbeat = startLeaseHeartbeats([lockPath], DEFAULT_LEASE_MS)[0];
  try {
    return await action();
  } finally {
    heartbeat.stop();
    releaseLease(lockPath);
  }
}
async function cleanupLandCandidate(projectDir, candidatePath, { abort = false, settings = null } = {}) {
  if (!candidatePath) return { removed: true, residual: null };
  if (abort) await runGit(['merge', '--abort'], candidatePath);
  let resolvedSettings = settings;
  if (!resolvedSettings) {
    const config = await readProjectConfig(projectDir);
    resolvedSettings = resolveWorktreeSettings(projectDir, config, {});
  }
  if (!resolvedSettings.error) removeWorktreeLinks(projectDir, candidatePath, resolvedSettings);
  const status = await runGit(['status', '--porcelain=v1'], candidatePath);
  if (!status.ok || status.stdout.trim() !== '') {
    return {
      removed: false,
      residual: normalizeSlashes(candidatePath),
      reason: status.ok ? 'candidate worktree is dirty after merge cleanup' : boundedOutput(status.stderr || status.error?.message || 'candidate status failed', projectDir),
    };
  }
  const removed = await runGit(['worktree', 'remove', candidatePath], projectDir);
  if (!removed.ok) {
    return {
      removed: false,
      residual: normalizeSlashes(candidatePath),
      reason: boundedOutput(removed.stderr || removed.error?.message || 'candidate worktree remove failed', projectDir),
    };
  }
  await runGit(['worktree', 'prune'], projectDir);
  releaseServiceTeardown(projectDir, candidatePath);
  return { removed: true, residual: null };
}
async function remoteDevelopHead(projectDir) {
  const remote = await runGit(['ls-remote', '--exit-code', 'origin', 'refs/heads/develop'], projectDir);
  const match = remote.ok && /^([0-9a-f]{40,64})\s+refs\/heads\/develop\s*$/iu.exec(remote.stdout.trim());
  return match ? { ok: true, sha: match[1].toLowerCase() }
    : { ok: false, error: boundedOutput(remote.stderr || remote.error?.message || 'origin/develop cannot be confirmed', projectDir) };
}
async function worktreeLandReport(projectDir, args) {
  if (args.targetMode && args.targetMode !== 'primary' && args.targetMode !== 'remote') {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'land', status: 'failed', code: 'LAND_TARGET_MODE_INVALID', error: `unknown --target-mode ${args.targetMode}` };
  }
  if (args.targetMode === 'remote' && (args.delivery !== 'local-land' || args.baseRef !== 'develop' || (args.write && !args.push))) {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'land', status: 'failed', code: 'LAND_REMOTE_MODE_INVALID',
      error: 'remote target mode requires --delivery local-land --base-ref develop and, with --write, --push' };
  }
  const delivery = resolveDelivery(await readProjectConfig(projectDir), args.delivery);
  if (args.write && args.task[0]) {
    const taskId = parseWorktreeTask(args.task[0]).id;
    const anchor = await readTaskAnchor(projectDir, taskId);
    if (anchor.exists) await taskCheckpointReport(projectDir, { ...args, _: ['task', 'checkpoint', taskId], reason: 'pre-delivery' });
  }
  if (delivery.merge === 'squash') {
    const result = await worktreeCleanupReport(projectDir, args);
    return { ...result, subcommand: 'land', delivery: { profile: delivery.profile, stage: 'cleanup' },
      guidance: 'Managed MR landing reads merge evidence only; it never creates a local no-ff merge or pushes.' };
  }
  if (args.write && args.verify === false) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'worktree',
      subcommand: 'land',
      status: 'failed',
      code: 'LAND_VERIFY_REQUIRED',
      error: 'worktree land --write requires verification; use dry-run to inspect a no-verify plan',
    };
  }
  if (!args.write) return worktreeLandReportUnlocked(projectDir, args);
  return worktreeLandReportTwoPhase(projectDir, args);
}

/**
 * Build and verify a candidate without blocking peer worktrees, then acquire
 * the target-ref lease for the short baseline check, merge, push and cleanup.
 * A baseline change releases the lease, cleans the candidate and retries from
 * the newly observed target head.
 */
async function worktreeLandReportTwoPhase(projectDir, args) {
  let lastResult = null;
  let retryArgs = args;
  for (let attempt = 1; attempt <= LAND_MAX_ATTEMPTS; attempt += 1) {
    let phase2 = null;
    let phase2Heartbeats = [];
    const candidateActivities = [];
    try {
      lastResult = await worktreeLandReportUnlocked(projectDir, retryArgs, {
        beforeFinalize: async (targetRef) => {
          phase2 = await acquirePhase2Lock(projectDir, targetRef);
          if (!phase2.held) return phase2;
          phase2Heartbeats = startLeaseHeartbeats(phase2.lockPaths, phase2.leaseMs);
          return {
            ...phase2,
            leaseHealthy: () => phase2Heartbeats.every((heartbeat) => !heartbeat.lost),
          };
        },
        onCandidateStart: async (candidateId) => {
          const activity = await acquireLandCandidateActivityLease(projectDir, candidateId);
          if (activity.held) candidateActivities.push(activity);
          return activity;
        },
      });
    } finally {
      for (const heartbeat of phase2Heartbeats) heartbeat.stop();
      if (phase2?.held) {
        for (const lockPath of phase2.lockPaths) releaseLease(lockPath);
      }
      for (const activity of candidateActivities) {
        activity.stopHeartbeat();
        releaseLease(activity.lockPath);
      }
    }
    if (lastResult.code !== 'LAND_BASELINE_CHANGED') return lastResult;
    if (attempt < LAND_MAX_ATTEMPTS) {
      // A retry must keep the target chosen by the first attempt. Without this
      // pin, a checkout switched during verification could redirect the merge.
      retryArgs = { ...retryArgs, baseRef: lastResult.targetBranch ?? retryArgs.baseRef };
      await delay(100 * attempt);
    }
  }
  return {
    ...lastResult,
    retryCount: LAND_MAX_ATTEMPTS - 1,
    guidance: `target branch changed ${LAND_MAX_ATTEMPTS - 1} times during land; inspect the target before retrying`,
  };
}

async function worktreeLandReportUnlocked(projectDir, args, { beforeFinalize = null, onCandidateStart = null } = {}) {
  const failure = (error, code) => ({ schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'land', status: 'failed', ...(code ? { code } : {}), error });
  const targetMode = args.targetMode ?? 'primary';
  if (!['primary', 'remote'].includes(targetMode)) return failure(`unknown --target-mode ${targetMode} (expected primary or remote)`, 'LAND_TARGET_MODE_INVALID');
  const remoteMode = targetMode === 'remote';
  if (remoteMode && (args.delivery !== 'local-land' || args.baseRef !== 'develop' || (args.write && !args.push))) {
    return failure('remote target mode requires --delivery local-land --base-ref develop and, with --write, --push', 'LAND_REMOTE_MODE_INVALID');
  }
  if (args.push && !args.write) {
    return failure('worktree land --push requires --write: push and branch deletion only run in a real write');
  }
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return failure(settings.error);
  const delivery = resolveDelivery(config, args.delivery);
  const { entries, reason } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'land', status: 'unavailable', error: reason };
  const primary = entries.find((item) => item.primary) ?? null;
  if (!primary?.path) return failure('no primary checkout in the worktree listing; land merges into the primary checkout');
  if (primary.detached || typeof primary.branch !== 'string' || primary.branch === '') {
    return failure(`${normalizeSlashes(primary.path)} is on a detached HEAD; land needs a named target branch`);
  }
  // `git merge` can only merge into the branch the primary checkout has
  // checked out, so --base-ref is an assertion of intent, not a selector:
  // naming a different branch fails instead of switching the user's checkout.
  const targetBranch = args.baseRef ?? primary.branch;
  if (targetBranch !== primary.branch) {
    return failure(
      `land merges into the primary checkout's current branch ${primary.branch}; check out ${args.baseRef} first or omit --base-ref`,
      'LAND_BASELINE_CHANGED',
    );
  }
  if (isLandProtectedBranch(targetBranch)) {
    return failure(`target branch ${targetBranch} is a protected or shared branch; land refuses to merge into it`, 'LAND_TARGET_PROTECTED');
  }
  const reviewPolicy = delivery.reviewPolicy ?? 'required';
  const reviewRequired = isReviewRequired({ reviewPolicy, targetBranch });
  const remoteTracking = remoteMode ? await runGit(['rev-parse', '--verify', 'refs/remotes/origin/develop'], projectDir) : null;
  const remoteHead = remoteMode ? await remoteDevelopHead(projectDir) : null;
  if (remoteMode && (!remoteHead.ok || !remoteTracking.ok || remoteTracking.stdout.trim() !== remoteHead.sha)) {
    return { ...failure('fetch origin develop and confirm origin/develop matches the remote before landing', 'LAND_REMOTE_BASE_STALE'),
      ...(remoteHead?.error ? { detail: remoteHead.error } : {}) };
  }
  if (remoteMode && !(await runGit(['merge-base', '--is-ancestor', `refs/heads/${targetBranch}`, remoteHead.sha], projectDir)).ok) {
    return failure('local develop has unpushed commits or has diverged from origin/develop; handle those commits separately', 'LAND_LOCAL_TARGET_AHEAD');
  }
  const registryInfo = readPortRegistry(projectDir);
  const registry = registryInfo.registry ?? null;
  const attributed = entries.filter((item) => !item.primary && !item.prunable && !item.detached && typeof item.branch === 'string' && item.branch !== ''
    && (isInsidePath(item.path, settings.root)
      || (registry?.entries ?? []).some((entry) => entry.id === path.basename(item.path)
        || (entry.path && pathKey(entry.path) === pathKey(item.path))
        || (entry.branch && entry.branch === item.branch))));
  let entry = null;
  if (args.task.length > 1) return failure('worktree land accepts at most one --task');
  if (args.task.length === 1) {
    const task = parseWorktreeTask(args.task[0]);
    entry = attributed.find((item) => pathKey(item.path) === pathKey(task.path ?? path.join(settings.root, task.id))
      || (task.branch !== null && item.branch === task.branch)
      || path.basename(item.path) === task.id) ?? null;
    if (!entry) return failure(`no attributed worktree matches task ${task.id}`);
  } else {
    if (attributed.length === 0) return failure('no attributed worktree to land (bootstrap one first or pass --task <id>)');
    if (attributed.length > 1) {
      return failure(`multiple attributed worktrees (${attributed.map((item) => `${path.basename(item.path)} on ${item.branch}`).join(', ')}); pass --task <id> to choose`);
    }
    entry = attributed[0];
  }
  if (entry.branch === targetBranch) {
    return failure(`the worktree branch ${entry.branch} is the target branch itself`);
  }
  const registryEntry = (registry?.entries ?? []).find((item) => item.id === path.basename(entry.path)
    || (item.path && pathKey(item.path) === pathKey(entry.path))
    || (item.branch && item.branch === entry.branch)) ?? null;
  const taskId = registryEntry?.id ?? path.basename(entry.path);
  const branchHead = await runGit(['rev-parse', `refs/heads/${entry.branch}`], projectDir);
  if (!branchHead.ok) return failure(`branch ${entry.branch} is not a local ref; land cannot attribute its commits`);
  const branchHeadSha = branchHead.stdout.trim();
  const primaryHead = await runGit(['rev-parse', 'HEAD'], primary.path);
  const targetHeadBeforeLand = await runGit(['rev-parse', `refs/heads/${targetBranch}`], primary.path);
  const baselineMergeBase = await runGit(['merge-base', branchHeadSha, targetBranch], projectDir);
  const baselineDivergence = await runGit(['rev-list', '--left-right', '--count', `${targetBranch}...${branchHeadSha}`], projectDir);
  const configuredBaseHead = await runGit(['rev-parse', '--verify', settings.baseRef], projectDir);
  const [targetAhead = null, sourceAhead = null] = baselineDivergence.ok
    ? baselineDivergence.stdout.trim().split(/\s+/u).map((value) => Number.parseInt(value, 10))
    : [];
  const baseline = {
    baseRef: settings.baseRef,
    baseRefHead: configuredBaseHead.ok ? configuredBaseHead.stdout.trim() : null,
    targetBranch,
    targetHead: targetHeadBeforeLand.ok ? targetHeadBeforeLand.stdout.trim() : null,
    sourceHead: branchHeadSha,
    mergeBase: baselineMergeBase.ok ? baselineMergeBase.stdout.trim() : null,
    targetAhead: Number.isInteger(targetAhead) ? targetAhead : null,
    sourceAhead: Number.isInteger(sourceAhead) ? sourceAhead : null,
    // The branch was cut from an older target tip when the configured base has
    // moved past its merge-base. This is a fact to report, not a blocker: the
    // isolated candidate still merges into the current target and is verified.
    baseRefDrift: Boolean(configuredBaseHead.ok && baselineMergeBase.ok
      && configuredBaseHead.stdout.trim() !== baselineMergeBase.stdout.trim()),
  };

  const blockers = [];
  const landStartedAt = Date.now();
  const timingsMs = {};
  const residualCandidates = candidateResidue(settings, taskId);
  if (residualCandidates.length > 0) {
    blockers.push(`residual land candidate worktree(s) exist for ${taskId}: ${residualCandidates.map(normalizeSlashes).join(', ')}; inspect and remove them before retrying`);
  }
  const dependencyBlockers = dependencyRootBlockers(projectDir, entry.path, settings);
  for (const blocker of dependencyBlockers) blockers.push(blocker.message);
  const worktreeStatus = await runGit(['status', '--porcelain=v1'], entry.path);
  const sourceFingerprint = remoteMode && worktreeStatus.ok ? await gitFingerprint(entry.path) : null;
  if (!worktreeStatus.ok) blockers.push('the worktree status could not be read');
  else if (worktreeStatus.stdout.trim() !== '') blockers.push('the worktree has uncommitted changes');
  const primaryStatus = await runGit(['status', '--porcelain=v1'], primary.path);
  const primaryFingerprint = remoteMode && primaryStatus.ok ? await gitFingerprint(primary.path) : null;
  if (!primaryStatus.ok) blockers.push('the primary checkout status could not be read');
  else if (!remoteMode && primaryStatus.stdout.trim() !== '') blockers.push('the primary checkout has uncommitted changes');
  const primaryStatusLines = primaryStatus.ok
    ? primaryStatus.stdout.split(/\r?\n/u).map((line) => line.trimEnd()).filter(Boolean)
    : [];
  const primaryDifferences = primaryStatusLines.map((line) => ({
    status: line.slice(0, 2).trim(),
    path: line.slice(3),
  }));
  const primaryTrackedDiff = await runGit(['diff', '--shortstat', '--no-ext-diff'], primary.path);
  const primaryStagedDiff = await runGit(['diff', '--cached', '--shortstat', '--no-ext-diff'], primary.path);
  const primaryCheckout = {
    branch: primary.branch,
    head: primaryHead.ok ? primaryHead.stdout.trim() : null,
    dirty: primaryStatusLines.length > 0,
    changeCount: primaryDifferences.length,
    trackedChangeCount: primaryDifferences.filter((change) => change.status !== '??').length,
    untrackedChangeCount: primaryDifferences.filter((change) => change.status === '??').length,
    changes: primaryDifferences.slice(0, 50),
    changesTruncated: primaryDifferences.length > 50,
    unstagedSummary: primaryTrackedDiff.ok ? primaryTrackedDiff.stdout.trim() : null,
    stagedSummary: primaryStagedDiff.ok ? primaryStagedDiff.stdout.trim() : null,
  };
  // An anchor with unfinished units means the work is not done yet; landing it
  // anyway would merge a half-finished slice into the target branch.
  let anchorInfo = null;
  let unitGate = null;
  try {
    anchorInfo = await readTaskAnchor(projectDir, taskId);
  } catch (error) {
    blockers.push(`task anchor ${taskAnchorRelativePath(taskId)} is unreadable: ${error.message}`);
  }
  if (anchorInfo?.exists && anchorInfo.anchor) {
    let landPlanUnits = [];
    if (typeof anchorInfo.anchor.planFile === 'string') {
      const planCheck = await taskPlanCheckReport(projectDir, taskId);
      if (planCheck.status !== 'passed') blockers.push(`task plan check failed for ${taskId}: ${planCheck.error ?? planCheck.code}`);
      else landPlanUnits = planUnitGraph(planCheck);
    }
    const units = Array.isArray(anchorInfo.anchor.units) ? anchorInfo.anchor.units.filter((unit) => unit && typeof unit === 'object') : [];
    const anchorBlockers = Array.isArray(anchorInfo.anchor.blockers) ? anchorInfo.anchor.blockers.filter((item) => typeof item === 'string' && item.trim() !== '') : [];
    anchorBlockers.forEach((item) => blockers.push(`task anchor ${taskId} has blocker: ${item}`));
    const pending = units.filter((unit) => unit.status !== 'done').map((unit) => unit.id ?? '?');
    if (units.length > 0 && pending.length > 0) blockers.push(`task anchor ${taskId} has units not done (${pending.join(', ')})`);
    // Land reuses the same predecessor judgement the dispatch gate uses: a
    // failed or blocked unit, and everything the plan declares on top of it,
    // is named instead of being folded into "units not done".
    const failedUnits = units.filter((unit) => TASK_UNIT_FAILURE_STATUSES.includes(unit.status)).map((unit) => unit.id ?? '?');
    const waitingUnits = planDependentUnits(landPlanUnits, failedUnits);
    if (failedUnits.length > 0) {
      unitGate = { failed: failedUnits, waiting: waitingUnits };
      blockers.push(`task anchor ${taskId} has failed or blocked units (${failedUnits.join(', ')}); repair and re-verify them before landing${waitingUnits.length > 0 ? ` (dependent units wait: ${waitingUnits.join(', ')})` : ''}`);
    }
  }
  const ancestor = await runGit(['merge-base', '--is-ancestor', branchHeadSha, remoteMode ? remoteHead.sha : targetBranch], projectDir);
  const alreadyMerged = ancestor.ok;
  // The verify tier defaults to the quick layer and only escalates when the
  // task anchor itself declares full risk; --tier always wins.
  let tier;
  try {
    tier = parseVerifyTier(args.tier ?? (anchorInfo?.anchor?.riskLevel === 'full' ? 'standard' : undefined));
  } catch (error) {
    return failure(error.message);
  }
  // A completion receipt is only accepted when no declared layer is left
  // deferred, and its acceptance names the checks the caller reviewed as
  // relevant. Both are preflight facts: a landing that cannot produce them is
  // reported here instead of after the merge candidate was built and tested.
  let tierEscalation = null;
  let deepLockStatus = null;
  if (delivery.requireReceipt && args.verify !== false) {
    const configured = configuredChecks(config, projectDir);
    if (configured.error) return failure(configured.error);
    const receiptTier = resolveReceiptTier({ commands: configured.commands, config, explicit: args.tier !== undefined, projectDir, tier });
    if (receiptTier.blocked) blockers.push(receiptTier.blocked);
    else tier = receiptTier.tier;
    if (receiptTier.escalatedFrom) tierEscalation = { from: receiptTier.escalatedFrom, to: receiptTier.tier };
    if (reviewRequired && receiptTier.selectedNames.length > 0) {
      const reviewed = resolveReviewedChecks(args.reviewed, receiptTier.selectedNames);
      if (reviewed.blocked) blockers.push(reviewed.blocked);
      else if (reviewed.ids.length === 0) {
        blockers.push(`a completion receipt (delivery.${delivery.profile}) requires the explicit relevance review of the checks this change is verified by: pass --reviewed <${receiptTier.selectedNames.join('|')}|all> after reading the changed paths against them`);
      }
    }
  }
  if (tier === 'deep') {
    const lock = await verificationLockStatus(projectDir);
    deepLockStatus = { held: Boolean(lock.ok && lock.held), stale: lock.stale === true, path: lock.path ?? null, holder: lock.holder ?? null };
    if (lock.ok && lock.held) {
      blockers.push(`a deep or backend-wide verification already holds ${normalizeSlashes(lock.path)}${lock.holder?.pid ? ` (pid ${lock.holder.pid})` : ''}; wait for it to finish before building another candidate`);
    }
  }
  // Push policy mirrors $vb-git-split-push: plain push when an upstream exists;
  // without one the branch may only start tracking when origin is the sole
  // remote and the branch is not protected.
  const upstream = await runGit(['for-each-ref', `refs/heads/${targetBranch}`, '--format=%(upstream:short)'], projectDir);
  const hasUpstream = upstream.ok && upstream.stdout.trim() !== '';
  const remotes = await runGit(['remote'], projectDir);
  const remoteList = remotes.ok ? remotes.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) : [];
  const pushCommand = remoteMode ? 'git push origin <verified-candidate-sha>:refs/heads/develop'
    : hasUpstream ? 'git push'
    : remoteList.length === 1 && remoteList[0] === 'origin' && !isLandProtectedBranch(targetBranch)
      ? `git push -u origin ${targetBranch}`
      : null;
  if (args.push && pushCommand === null) {
    blockers.push(`branch ${targetBranch} has no upstream and the push policy does not allow setting one (requires a sole origin remote and a non-protected branch)`);
  }

  const baseResult = {
    id: taskId,
    branch: entry.branch,
    path: normalizeSlashes(entry.path),
    alreadyMerged,
    pushed: false,
    branchDeleted: false,
    portBlockReleased: false,
    ...(remoteMode ? { targetRef: 'origin/develop', targetBefore: remoteHead.sha, primaryUnchanged: true } : {}),
  };
  const stepPlans = [
    { id: 'merge', detail: alreadyMerged ? `already merged into ${remoteMode ? 'origin/develop' : targetBranch}; skipped` : remoteMode
      ? `merge ${entry.branch} --no-ff into detached candidate at origin/develop ${remoteHead.sha}; leave the primary checkout unchanged`
      : `merge ${entry.branch} in an isolated candidate worktree, then fast-forward ${targetBranch}` },
    ...(args.verify === false ? [{ id: 'verify', detail: 'skipped by --no-verify' }] : [{ id: 'verify', detail: `verify --tier ${tier} on the merged result` }]),
    ...(remoteMode ? [{ id: 'push', detail: pushCommand }] : args.push ? [{ id: 'push', detail: pushCommand ?? 'blocked by push policy' }] : [{ id: 'push', detail: `no --push; branch kept, run after landing: git push${hasUpstream ? '' : ` -u origin ${targetBranch}`}` }]),
    { id: 'cleanup', detail: 'remove dependency links, the worktree, then release the port registry entry' },
    ...(remoteMode || args.push ? [{ id: 'delete-branch', detail: `git branch -d ${entry.branch} (only after a successful push)` }] : [{ id: 'delete-branch', detail: `branch ${entry.branch} kept without --push; delete after pushing with: git branch -d ${entry.branch}` }]),
  ];
  if (blockers.length > 0) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'worktree',
      subcommand: 'land',
      status: 'blocked',
      ...(unitGate ? { code: 'LAND_UNIT_PREDECESSOR_FAILED', unitGate } : {}),
      blockers,
      targetBranch,
      ...(remoteMode ? { targetMode, targetRef: 'origin/develop', targetBefore: remoteHead.sha } : {}),
      tier,
      ...(tierEscalation ? { tierEscalation } : {}),
      preflight: { primaryCheckout, baseline, residualCandidates: residualCandidates.map(normalizeSlashes), dependencyBlockers, deepLock: deepLockStatus },
      write: Boolean(args.write),
      results: [{ ...baseResult, status: 'blocked', steps: stepPlans.map((step) => ({ ...step, status: 'blocked' })) }],
    };
  }
  if (!args.write) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'worktree',
      subcommand: 'land',
      status: 'planned',
      targetBranch,
      targetMode,
      ...(remoteMode ? { targetRef: 'origin/develop', targetBefore: remoteHead.sha, primaryUnchanged: true } : {}),
      tier,
      ...(tierEscalation ? { tierEscalation } : {}),
      preflight: { primaryCheckout, baseline, residualCandidates: residualCandidates.map(normalizeSlashes), dependencyBlockers, deepLock: deepLockStatus },
      write: false,
      results: [{ ...baseResult, status: 'planned', steps: stepPlans.map((step) => ({ ...step, status: 'planned' })) }],
    };
  }

  const steps = [];
  let failedStep = null;
  let pushed = false;
  const markFailed = (step) => {
    failedStep = step;
    steps.push(step);
  };

  let landReceipt = null;
  // True while the completion receipt returned to the caller is backed by a
  // durable provenance record; a receipt without one is not handed over.
  let provenanceRecorded = true;
  let candidatePath = null;
  let candidateHeadSha = null;
  let candidateLeaseHealthy = () => true;
  let phase2Lease = null;
  let remoteConfirmed = false;
  let pushUncertain = false;
  // The best-effort service teardown outcome, carried on the cleanup step when
  // ownership could not be proven instead of blocking the landing.
  let servicesTeardown = null;
  const targetHead = remoteMode ? { ok: true, stdout: remoteHead.sha } : await runGit(['rev-parse', `refs/heads/${targetBranch}`], primary.path);
  const localTargetAtStart = remoteMode ? await runGit(['rev-parse', `refs/heads/${targetBranch}`], projectDir) : null;
  if (!targetHead.ok) {
    markFailed({ id: 'merge', status: 'failed', code: 'LAND_TARGET_HEAD_UNRESOLVED', error: boundedOutput(targetHead.stderr || targetHead.error?.message || 'target branch head could not be resolved', projectDir), detail: `resolve ${targetBranch}` });
  } else {
    const candidateBaseSha = targetHead.stdout.trim();
    const candidateId = randomUUID();
    candidatePath = path.join(path.dirname(settings.root), `.vibe-harness-land-${taskId}-${candidateId}`);
    const candidateActivity = onCandidateStart
      ? await onCandidateStart(candidateId)
      : { held: true, leaseHealthy: () => true };
    if (!candidateActivity?.held) {
      markFailed({
        id: 'merge',
        status: 'blocked',
        code: candidateActivity?.code ?? 'LAND_CANDIDATE_LOCK_UNAVAILABLE',
        blockers: candidateActivity?.blockers ?? ['candidate activity lease could not be acquired'],
        detail: `protect candidate ${candidateId} from concurrent recovery`,
      });
    } else if (candidateActivity.leaseHealthy) {
      candidateLeaseHealthy = candidateActivity.leaseHealthy;
    }
    const setupStartedAt = Date.now();
    const added = failedStep ? { ok: false } : await runIsolatedGit(projectDir, ['worktree', 'add', '--detach', candidatePath, candidateBaseSha]);
    if (!failedStep && !added.ok) {
      markFailed({ id: 'merge', status: 'failed', code: 'LAND_CANDIDATE_CREATE_FAILED', error: boundedOutput(added.stderr || added.error?.message || 'candidate worktree creation failed', projectDir), detail: `git worktree add --detach ${candidatePath} ${candidateBaseSha}` });
    } else if (!failedStep) {
      try {
        for (const root of settings.dependencyRoots) linkDependencyRoot(projectDir, candidatePath, settings, root);
        // The governance surface is ignored by Git and therefore absent from a
        // fresh candidate worktree, so a verification command that reaches the
        // mirrored toolchain would fail here while passing in the source
        // worktree. The candidate is torn down through `removeWorktreeLinks`,
        // which removes these again before `git worktree remove`.
        if ((settings.mirrors ?? []).length > 0) linkOrCopyMirrors(projectDir, candidatePath, settings.mirrors);
        // The isolated per-package overlays belong to the same resolution
        // surface as the dependency roots: without them a pnpm/Bun isolated
        // layout resolves in the source worktree and fails in the candidate,
        // so `worktree land` would reject a mergeable branch. The cleanup path
        // removes them again through `removeDependencyLinks`.
        linkPackageRoots(projectDir, candidatePath, settings);
        for (const relative of new Set([settings.ports.envFile, ...settings.provision.envFiles])) {
          const source = safeWorktreeFile(entry.path, relative, 'worktree candidate env');
          const target = safeWorktreeFile(candidatePath, relative, 'worktree candidate env');
          if (existsSync(source)) {
            mkdirSync(path.dirname(target), { recursive: true });
            copyFileSync(source, target);
          }
        }
      } catch (error) {
        const removed = await cleanupLandCandidate(projectDir, candidatePath, { settings });
        markFailed({ id: 'merge', status: 'failed', code: 'LAND_CANDIDATE_SETUP_FAILED', error: error.message, candidatePath: removed.residual, detail: 'prepare isolated candidate dependencies' });
      }
      timingsMs.setupMs = Date.now() - setupStartedAt;
      let candidateMerge = { ok: true };
      const mergeStartedAt = Date.now();
      if (!failedStep && !alreadyMerged) {
        candidateMerge = await runIsolatedGit(projectDir, ['merge', '--no-ff', '--no-edit', '--no-verify', entry.branch], candidatePath);
      }
      timingsMs.mergeMs = Date.now() - mergeStartedAt;
      if (!failedStep && !candidateMerge.ok) {
        const removed = await cleanupLandCandidate(projectDir, candidatePath, { abort: true, settings });
        markFailed({
          id: 'merge',
          status: 'failed',
          code: 'LAND_MERGE_CONFLICT',
          error: boundedOutput(candidateMerge.stderr || candidateMerge.error?.message || 'candidate merge failed', projectDir),
          candidatePath: removed.residual,
          detail: `isolated merge ${entry.branch} into ${targetBranch}`,
        });
      } else if (!failedStep) {
        const candidateHead = await runGit(['rev-parse', 'HEAD'], candidatePath);
        if (!candidateHead.ok) {
          const removed = await cleanupLandCandidate(projectDir, candidatePath, { settings });
          markFailed({ id: 'merge', status: 'failed', code: 'LAND_CANDIDATE_HEAD_UNRESOLVED', error: boundedOutput(candidateHead.stderr || candidateHead.error?.message || 'candidate HEAD could not be resolved', projectDir), candidatePath: removed.residual, detail: 'resolve candidate HEAD' });
        } else {
          candidateHeadSha = candidateHead.stdout.trim();
          steps.push({ id: 'merge', status: alreadyMerged ? 'skipped' : 'passed', detail: alreadyMerged ? `${entry.branch} is already merged into ${targetBranch}` : `merged ${entry.branch} in isolated candidate worktree` });
          const verifyStartedAt = Date.now();
          const verify = await verifyProject(candidatePath, {
            tier, task: [taskId], only: null, reuse: true, allowManual: false, reviewed: args.reviewed,
            reviewPolicy, targetBranch,
          });
          timingsMs.verifyMs = Date.now() - verifyStartedAt;
          timingsMs.cacheLookupMs = verify.cache?.lookupMs ?? null;
          timingsMs.checks = Object.entries(verify.checks ?? {}).map(([id, item]) => ({
            id,
            status: item?.status ?? null,
            durationMs: item?.durationMs ?? null,
          }));
          if (delivery.requireReceipt) {
            landReceipt = completionReceipt(verify, delivery, {
              rollback: `git revert -m 1 ${candidateHeadSha}`,
              targetBranch,
              reviewPolicy,
            });
            landReceipt.delivery.stage = 'complete';
            landReceipt.target.head = candidateHeadSha;
          }
          const completionGate = delivery.requireReceipt
            ? validateCompletion(landReceipt, delivery, await gitFingerprint(candidatePath),
              { provenance: await attestCompletionProvenance(candidatePath, landReceipt), targetBranch })
            : null;
          const verifyOk = PASS_STATUSES.includes(verify.status) && completionGate?.status !== 'blocked';
          const checkLines = Object.entries(verify.checks ?? {})
            .filter(([, item]) => item?.status && item.status !== 'not_configured')
            .map(([name, item]) => `${name}=${item.status}`)
            .join(' ');
          if (verifyOk) {
            steps.push({ id: 'verify', status: 'passed', tier: verify.tier, receipt: verify.verification?.id ?? null, detail: `verify isolated candidate ${verify.status}${checkLines ? ` (${checkLines})` : ''}` });
          } else {
            const removed = await cleanupLandCandidate(projectDir, candidatePath, { settings });
            markFailed({ id: 'verify', status: 'failed', code: 'LAND_VERIFY_FAILED', tier: verify.tier, error: verify.error ?? `verify ended ${verify.status}${checkLines ? ` (${checkLines})` : ''}`, candidatePath: removed.residual, detail: `verify --tier ${tier} on isolated candidate` });
          }
        }
      }
    }
  }

  if (!failedStep && !candidateLeaseHealthy()) {
    const removed = await cleanupLandCandidate(projectDir, candidatePath, { settings });
    markFailed({
      id: 'merge',
      status: 'blocked',
      code: 'LAND_CANDIDATE_LOCK_LOST',
      candidatePath: removed.residual,
      error: removed.reason,
      detail: 'candidate activity lease was lost during land verification',
    });
  }

  if (!failedStep) {
    if (beforeFinalize && !failedStep) {
      phase2Lease = await beforeFinalize(targetBranch);
      if (!phase2Lease?.held) {
        const removed = await cleanupLandCandidate(projectDir, candidatePath, { settings });
        markFailed({
          id: 'merge',
          status: 'blocked',
          code: phase2Lease?.code ?? 'LAND_LOCK_UNAVAILABLE',
          blockers: phase2Lease?.blockers ?? ['target-ref lease could not be acquired'],
          ...(removed.residual ? { candidatePath: removed.residual } : {}),
          ...(removed.reason ? { error: removed.reason } : {}),
          detail: `acquire Phase 2 lease for ${targetBranch}`,
        });
      }
    }
  }

  if (!failedStep) {
    const [
      targetNow,
      sourceNow,
      primaryNow,
      primaryFingerprintNow,
      localTargetNow,
      primaryBranchNow,
      sourceStatusNow,
      sourceFingerprintNow,
      candidateNow,
      candidateHeadNow,
    ] = await Promise.all([
      remoteMode ? remoteDevelopHead(projectDir) : runGit(['rev-parse', `refs/heads/${targetBranch}`], primary.path),
      runGit(['rev-parse', `refs/heads/${entry.branch}`], projectDir),
      runGit(['status', '--porcelain=v1'], primary.path),
      remoteMode ? gitFingerprint(primary.path) : Promise.resolve(null),
      remoteMode ? runGit(['rev-parse', `refs/heads/${targetBranch}`], projectDir) : Promise.resolve(null),
      runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], primary.path),
      runGit(['status', '--porcelain=v1'], entry.path),
      remoteMode ? gitFingerprint(entry.path) : Promise.resolve(null),
      candidatePath ? runGit(['status', '--porcelain=v1'], candidatePath) : Promise.resolve({ ok: false }),
      candidatePath ? runGit(['rev-parse', 'HEAD'], candidatePath) : Promise.resolve({ ok: false }),
    ]);
    const baselineBlockers = [];
    if (phase2Lease?.held && phase2Lease.leaseHealthy?.() === false) baselineBlockers.push('target-ref lease was lost while land was running');
    if (!candidateLeaseHealthy()) baselineBlockers.push('candidate activity lease was lost while land was running');
    if (!targetNow.ok || (remoteMode ? targetNow.sha : targetNow.stdout.trim()) !== targetHead.stdout.trim()) baselineBlockers.push(`target branch ${targetBranch} changed while land was running`);
    if (!sourceNow.ok || sourceNow.stdout.trim() !== branchHeadSha) baselineBlockers.push(`source branch ${entry.branch} changed while land was running`);
    if (!primaryBranchNow.ok || primaryBranchNow.stdout.trim() !== targetBranch) baselineBlockers.push('the primary checkout switched branches while land was running');
    if (!primaryNow.ok || primaryNow.stdout.trim() !== (remoteMode ? primaryStatus.stdout.trim() : '')) baselineBlockers.push('the primary checkout changed while land was running');
    if (remoteMode && (primaryFingerprintNow?.writeFingerprint !== primaryFingerprint?.writeFingerprint
      || !localTargetAtStart?.ok || !localTargetNow?.ok
      || localTargetNow.stdout.trim() !== localTargetAtStart.stdout.trim())) {
      baselineBlockers.push('the primary checkout or local develop changed while land was running');
    }
    if (!sourceStatusNow.ok || sourceStatusNow.stdout.trim() !== '') baselineBlockers.push('the source worktree became dirty while land was running');
    if (remoteMode && (sourceFingerprintNow?.fingerprint !== sourceFingerprint?.fingerprint
      || sourceFingerprintNow?.writeFingerprint !== sourceFingerprint?.writeFingerprint)) baselineBlockers.push('the source worktree changed while land was running');
    if (!candidateNow.ok || candidateNow.stdout.trim() !== '') baselineBlockers.push('the candidate worktree is not clean after verification');
    if (!candidateHeadNow.ok || candidateHeadNow.stdout.trim() !== candidateHeadSha) baselineBlockers.push('the candidate HEAD changed during verification');
    if (baselineBlockers.length > 0) {
      const removed = await cleanupLandCandidate(projectDir, candidatePath, { settings });
      markFailed({ id: 'merge', status: 'blocked', code: 'LAND_BASELINE_CHANGED', blockers: baselineBlockers, candidatePath: removed.residual, detail: 'baseline changed after isolated verification; retry from the current target' });
    } else if (remoteMode) {
      // The receipt describes the verified candidate, not the dirty primary.
      // Persist its authenticated provenance before publishing the commit.
      if (delivery.requireReceipt && landReceipt?.verification) {
        landReceipt.target = { head: candidateHeadSha, ref: 'origin/develop', before: remoteHead.sha };
        const recorded = await recordFinalVerification(projectDir, landReceipt.verification, { checks: landReceipt.acceptance });
        const attested = recorded ? await attestCompletionProvenance(projectDir, landReceipt) : { ok: false };
        if (!attested.ok) {
          provenanceRecorded = false;
          markFailed({ id: 'verify', status: 'blocked', code: 'LAND_PROVENANCE_UNRECORDED',
            candidatePath: normalizeSlashes(candidatePath), detail: 'candidate verification provenance could not be durably attested' });
        }
      }
      if (!failedStep) {
        steps[steps.findIndex((step) => step.id === 'merge')].detail = `candidate verified at ${candidateHeadSha}; primary checkout unchanged`;
      }
    } else if (phase2Lease?.held && phase2Lease.leaseHealthy?.() === false) {
      const removed = await cleanupLandCandidate(projectDir, candidatePath, { settings });
      markFailed({
        id: 'merge',
        status: 'blocked',
        code: 'LAND_LOCK_LOST',
        candidatePath: removed.residual,
        error: removed.reason,
        detail: 'target-ref lease was lost before fast-forwarding the verified candidate',
      });
    } else {
      const finalizeStartedAt = Date.now();
      const finalized = await runIsolatedGit(projectDir, ['merge', '--ff-only', candidateHeadSha], primary.path);
      timingsMs.finalizeMs = Date.now() - finalizeStartedAt;
      if (!finalized.ok) {
        const removed = await cleanupLandCandidate(projectDir, candidatePath, { settings });
        markFailed({ id: 'merge', status: 'failed', code: 'LAND_FINALIZE_FAILED', error: boundedOutput(finalized.stderr || finalized.error?.message || 'candidate could not be fast-forwarded into the primary checkout', projectDir), candidatePath: removed.residual, detail: `git merge --ff-only ${candidateHeadSha}` });
      } else {
        const removed = await cleanupLandCandidate(projectDir, candidatePath, { settings });
        // The receipt returned by this command describes the primary checkout,
        // but the write evidence it carries was read in the candidate worktree,
        // whose metadata the removal just destroyed. Re-anchoring it to the
        // primary after the fast-forward — and recording that evidence where
        // the receipt will be validated — keeps the command from returning a
        // receipt that its own gate then has to reject as stale.
        if (delivery.requireReceipt && landReceipt?.verification) {
          const finalizedAt = new Date().toISOString();
          const anchored = await gitFingerprint(primary.path);
          landReceipt.verification = {
            ...landReceipt.verification,
            verifiedAt: landReceipt.verification.finishedAt,
            finishedAt: finalizedAt,
            finalizedAt,
            fingerprint: anchored.fingerprint,
            writeFingerprint: anchored.writeFingerprint,
            ...(landReceipt.verification.acceptance
              ? { acceptance: { ...landReceipt.verification.acceptance, finalFingerprint: anchored.fingerprint } }
              : {}),
          };
          landReceipt.source = { ...landReceipt.source, head: candidateHeadSha, fingerprint: anchored.fingerprint };
          const recorded = await recordFinalVerification(primary.path, landReceipt.verification,
            { checks: landReceipt.acceptance });
          // The completion receipt is only valid through this record, so a
          // failure to write it has to stop the landing here: reporting `passed`
          // with a receipt whose provenance can never be attested would hand the
          // caller evidence the tool itself would reject.
          if (!recorded) {
            provenanceRecorded = false;
            if (!failedStep) {
              // The fast-forward already moved the target, so the branch is put
              // back: a blocked result has to leave the target exactly as
              // retryable as it found it, otherwise the next attempt sees an
              // already-landed change with no valid completion evidence. The
              // primary checkout was proven clean and on this branch just above.
              const restored = await runGit(['reset', '--hard', targetHead.stdout.trim()], primary.path);
              markFailed({
                id: 'merge', status: 'blocked',
                code: restored.ok ? 'LAND_PROVENANCE_UNRECORDED' : 'LAND_PROVENANCE_UNRECORDED_AND_UNRESTORED',
                ...(restored.ok ? {} : { error: boundedOutput(restored.stderr || restored.error?.message || 'the target branch could not be restored', projectDir) }),
                detail: restored.ok
                  ? 'record the finalized verification evidence for the primary checkout'
                  : `git reset --hard ${targetHead.stdout.trim()} in ${primary.path}`,
              });
            }
          }
        }
        if (!removed.removed) {
          markFailed({ id: 'merge', status: 'failed', code: 'LAND_CANDIDATE_CLEANUP_FAILED', candidatePath: removed.residual, error: removed.reason, detail: 'remove isolated candidate worktree' });
        } else {
          steps[steps.findIndex((step) => step.id === 'merge')].detail = `candidate verified and fast-forwarded into ${targetBranch}`;
        }
      }
    }
  }

  // Step 3: push (only with --push; a failed push stops the branch delete).
  if (!failedStep && args.push) {
    const pushArgs = remoteMode ? ['push', 'origin', `${candidateHeadSha}:refs/heads/develop`]
      : hasUpstream ? ['push'] : ['push', '-u', 'origin', targetBranch];
    const sourceBeforePush = remoteMode ? await runGit(['rev-parse', `refs/heads/${entry.branch}`], projectDir) : null;
    if (phase2Lease?.held && phase2Lease.leaseHealthy?.() === false) {
      markFailed({ id: 'push', status: 'blocked', code: 'LAND_LOCK_LOST',
        detail: 'target-ref lease was lost before push; preserve the source and inspect the target' });
    } else if (remoteMode && (!sourceBeforePush.ok || sourceBeforePush.stdout.trim() !== branchHeadSha)) {
      markFailed({ id: 'push', status: 'blocked', code: 'LAND_BASELINE_CHANGED',
        detail: 'task HEAD changed before push; preserve the source and retry verification' });
    }
    const pushStartedAt = Date.now();
    // A normal non-forced push atomically rejects a target that moved after
    // the locked baseline check, so another pre-push ls-remote is redundant.
    const pushedResult = failedStep ? { ok: false } : await runGit(pushArgs, remoteMode ? candidatePath : primary.path);
    timingsMs.pushMs = Date.now() - pushStartedAt;
    const remoteAfter = remoteMode && !failedStep ? await remoteDevelopHead(projectDir) : null;
    remoteConfirmed = remoteMode && Boolean(remoteAfter?.ok && remoteAfter.sha === candidateHeadSha);
    if (failedStep) {
      // A changed baseline is not a push attempt.
    } else if (pushedResult.ok && (!remoteMode || remoteConfirmed) || remoteMode && remoteConfirmed) {
      pushed = true;
      steps.push({ id: 'push', status: 'passed', detail: remoteMode ? `origin/develop confirmed at ${candidateHeadSha}` : pushCommand });
    } else if (remoteMode && remoteAfter.ok && remoteAfter.sha !== remoteHead.sha) {
      markFailed({ id: 'push', status: 'blocked', code: 'LAND_BASELINE_CHANGED',
        detail: 'origin/develop advanced while the verified candidate was being prepared; preserve the source and retry verification' });
    } else {
      pushUncertain = remoteMode && (!remoteAfter.ok || pushedResult.ok);
      markFailed({ id: 'push', status: 'failed', code: pushUncertain ? 'LAND_PUSH_UNCONFIRMED' : 'LAND_PUSH_FAILED',
        error: boundedOutput(pushedResult.stderr || pushedResult.error?.message || 'git push failed or remote result is uncertain', projectDir),
        detail: pushCommand, ...(remoteMode ? { candidatePath: normalizeSlashes(candidatePath) } : {}) });
    }
  } else if (!failedStep) {
    steps.push({ id: 'push', status: 'skipped', detail: `no --push; branch kept, run after landing: git push${hasUpstream ? '' : ` -u origin ${targetBranch}`}` });
  }

  // Step 4: cleanup. The worktree removal must precede the branch delete below
  // because a checked-out branch cannot be deleted. Service teardown is best
  // effort rather than a gate: it is still attempted because a stopping service
  // can flush tracked or untracked state into the source worktree, but a
  // teardown that cannot be proven no longer keeps a merged worktree in place —
  // its outcome is reported on the cleanup step instead.
  if (!failedStep && phase2Lease?.held && phase2Lease.leaseHealthy?.() === false) {
    markFailed({ id: 'cleanup', status: 'blocked', code: 'LAND_LOCK_LOST',
      detail: 'target-ref lease was lost before removing the source worktree' });
  }
  const cleanupStartedAt = Date.now();
  if (!failedStep) {
    servicesTeardown = await teardownServices(projectDir, entry.path);
    // The completion receipt describes the candidate — not the source — so the
    // source is read again here: the removal below must not delete work that
    // appeared while services were being stopped.
    const sourceAfterTeardown = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], entry.path);
    const sourceHeadAfterTeardown = remoteMode ? await runGit(['rev-parse', `refs/heads/${entry.branch}`], projectDir) : null;
    const remoteAfterTeardown = remoteMode ? await remoteDevelopHead(projectDir) : null;
    if (!sourceAfterTeardown.ok || sourceAfterTeardown.stdout.trim() !== ''
      || remoteMode && (!sourceHeadAfterTeardown.ok || sourceHeadAfterTeardown.stdout.trim() !== branchHeadSha
        || !remoteAfterTeardown.ok || remoteAfterTeardown.sha !== candidateHeadSha)) {
      // The worktree survives the block, so the teardown marker it would keep
      // `service start` out with is released again.
      releaseServiceTeardown(projectDir, entry.path);
      markFailed({
        id: 'services', status: 'blocked', code: 'LAND_SOURCE_WORKTREE_DIRTY',
        error: boundedOutput(sourceAfterTeardown.stderr || sourceAfterTeardown.error?.message || 'the source worktree is not clean after service teardown', projectDir),
        detail: `git status --porcelain=v1 --untracked-files=all in ${entry.path}`,
      });
    }
  }
  if (!failedStep && phase2Lease?.held && phase2Lease.leaseHealthy?.() === false) {
    markFailed({ id: 'cleanup', status: 'blocked', code: 'LAND_LOCK_LOST',
      detail: 'target-ref lease was lost during service teardown; preserve the source worktree' });
  }
  if (!failedStep) {
    const removedLinks = removeWorktreeLinks(projectDir, entry.path, settings);
    const removed = await runGit(['worktree', 'remove', entry.path], projectDir);
    if (removed.ok) {
      await runGit(['worktree', 'prune'], projectDir);
      releaseServiceTeardown(projectDir, entry.path);
      const released = await releasePortRegistryEntry(projectDir, taskId);
      steps.push({
        id: 'cleanup',
        status: 'passed',
        removedLinks,
        portBlockReleased: released.released === true,
        detail: `worktree removed; links ${removedLinks.length}`,
        ...(servicesTeardown && servicesTeardown.status !== 'passed' ? { services: servicesTeardown } : {}),
      });
    } else {
      // The worktree survives the failed removal, so it must not stay locked
      // out of `service start` by a teardown marker written for a removal that
      // never happened.
      releaseServiceTeardown(projectDir, entry.path);
      markFailed({ id: 'cleanup', status: 'failed', code: 'LAND_CLEANUP_FAILED', removedLinks, error: boundedOutput(removed.stderr || removed.error?.message || 'git worktree remove failed', projectDir), detail: `git worktree remove ${entry.path}` });
    }
  }
  timingsMs.cleanupMs = Date.now() - cleanupStartedAt;

  // Step 5: delete the branch — only after a successful push, and `-d` still
  // refuses a branch that is not fully merged.
  if (!failedStep && args.push && pushed) {
    if (phase2Lease?.held && phase2Lease.leaseHealthy?.() === false) {
      markFailed({ id: 'delete-branch', status: 'blocked', code: 'LAND_LOCK_LOST',
        detail: 'target-ref lease was lost before deleting the source branch' });
    } else {
      const stillMerged = await runGit(['merge-base', '--is-ancestor', branchHeadSha, remoteMode ? candidateHeadSha : targetBranch], projectDir);
      if (!stillMerged.ok) {
        markFailed({ id: 'delete-branch', status: 'failed', code: 'LAND_BRANCH_NOT_MERGED', error: `branch ${entry.branch} is not merged into ${targetBranch}`, detail: `git branch -d ${entry.branch}` });
      } else {
        const deleted = await runGit(['branch', '--delete', entry.branch], remoteMode ? candidatePath : projectDir);
        if (deleted.ok) steps.push({ id: 'delete-branch', status: 'passed', detail: `branch ${entry.branch} deleted` });
        else markFailed({ id: 'delete-branch', status: 'failed', code: 'LAND_BRANCH_DELETE_FAILED', error: boundedOutput(deleted.stderr || deleted.error?.message || 'git branch --delete failed', projectDir), detail: `git branch -d ${entry.branch}` });
      }
    }
  } else if (!failedStep) {
    steps.push({ id: 'delete-branch', status: 'skipped', detail: `branch ${entry.branch} kept without --push; delete after pushing with: git branch -d ${entry.branch}` });
  }
  if (remoteMode && candidatePath && existsSync(candidatePath) && !pushUncertain) {
    const removed = await cleanupLandCandidate(projectDir, candidatePath, { settings });
    if (!removed.removed) markFailed({ id: 'candidate-cleanup', status: 'failed', code: 'LAND_CANDIDATE_CLEANUP_FAILED',
      candidatePath: removed.residual, error: removed.reason, detail: 'remove isolated candidate after landing attempt' });
  }

  const stepFailures = steps.filter((step) => step.status === 'failed' || step.status === 'blocked');
  const landStatus = stepFailures.some((step) => step.status === 'blocked') && !stepFailures.some((step) => step.status === 'failed')
    ? 'blocked'
    : stepFailures.length > 0 ? 'failed' : 'passed';
  timingsMs.totalMs = Date.now() - landStartedAt;
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'land',
    status: landStatus,
    ...(failedStep?.code ? { code: failedStep.code } : {}),
    targetBranch,
    targetMode,
    ...(remoteMode ? { targetRef: 'origin/develop', targetBefore: remoteHead.sha,
      targetAfter: pushed && remoteConfirmed ? candidateHeadSha : null, primaryUnchanged: true,
      guidance: pushed && remoteConfirmed
        ? 'Remote develop is integrated at the verified candidate; the primary checkout and local develop were not updated and must be reconciled separately.'
        : 'Remote integration is not confirmed; preserve the task branch and inspect the remote before retrying.',
      ...(failedStep && candidatePath && existsSync(candidatePath) ? { candidatePath: normalizeSlashes(candidatePath) } : {}) } : {}),
    tier,
    ...(tierEscalation ? { tierEscalation } : {}),
    timingsMs,
    ...(landReceipt && provenanceRecorded ? { completion: landReceipt } : {}),
    write: true,
    results: [{ ...baseResult, pushed, branchDeleted: steps.some((step) => step.id === 'delete-branch' && step.status === 'passed'), portBlockReleased: steps.some((step) => step.id === 'cleanup' && step.status === 'passed' && step.portBlockReleased === true), status: landStatus, steps }],
  };
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
  if (!args.write) return worktreeRecoverReportUnlocked(projectDir, args);
  const result = await withWorktreeLandLock(projectDir, () => worktreeRecoverReportUnlocked(projectDir, args));
  return result.subcommand === 'land' ? { ...result, subcommand: 'recover' } : result;
}
async function worktreeRecoverReportUnlocked(projectDir, args) {
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'recover', status: 'failed', error: settings.error };
  const { entries, reason } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'recover', status: 'unavailable', error: reason };
  const registry = readPortRegistry(projectDir).registry ?? null;
  const registryEntryFor = (worktree) => (registry?.entries ?? []).find((item) => item.id === path.basename(worktree.path)
    || (item.path && pathKey(item.path) === pathKey(worktree.path))
    || (item.branch && item.branch === worktree.branch)) ?? null;
  const baseHead = await runGit(['rev-parse', '--verify', '--quiet', settings.baseRef], projectDir);
  const baseSha = baseHead.ok ? baseHead.stdout.trim() : null;
  // Without a resolvable base ref nothing can be proven untouched, so the two
  // categories that delete branches stay empty; `worktree check` is the command
  // that reports WORKTREE_BASE_REF_UNRESOLVED.
  const branchUntouched = async (branch) => {
    if (baseSha === null) return false;
    const head = await runGit(['rev-parse', `refs/heads/${branch}`], projectDir);
    if (!head.ok) return false;
    const branchSha = head.stdout.trim();
    if (branchSha === baseSha) return true;
    // The branch is safe to remove when its head is an ancestor of the current
    // base: the base has moved forward, but the branch contains no unique work.
    const containedByBase = await runGit(['merge-base', '--is-ancestor', branchSha, baseSha], projectDir);
    return containedByBase.ok;
  };

  const prunable = entries.filter((entry) => !entry.primary && entry.prunable);
  const liveEntries = entries.filter((entry) => !entry.prunable);
  const candidateRoot = path.dirname(settings.root);
  const candidatePattern = /^\.vibe-harness-land-(.+)-([0-9a-f]{8}-[0-9a-f-]{27,})$/iu;
  const candidateCommon = await gitCommonDir(projectDir);
  if (args.write && !candidateCommon.ok) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'worktree',
      subcommand: 'recover',
      status: 'blocked',
      code: 'WORKTREE_RECOVER_CANDIDATE_STATE_UNKNOWN',
      blockers: [candidateCommon.error],
    };
  }
  const candidates = [];
  for (const entry of liveEntries) {
    if (!entry.detached || !entry.path || pathKey(path.dirname(entry.path)) !== pathKey(candidateRoot)) continue;
    const match = candidatePattern.exec(path.basename(entry.path));
    if (!match || !(registry?.entries ?? []).some((item) => item.id === match[1])) continue;
    const state = await runGit(['status', '--porcelain=v1'], entry.path);
    const activityLease = candidateCommon.ok
      ? readLease(landCandidateActivityLockPath(candidateCommon.path, match[2]))
      : null;
    candidates.push({
      path: entry.path,
      id: match[1],
      clean: state.ok && state.stdout.trim() === '',
      activeLand: Boolean(activityLease && !activityLease.stale),
      status: 'planned',
    });
  }

  // Incomplete worktrees: a bootstrap that died between `git worktree add` and
  // the locked registry/env write leaves a worktree that is clean, still at the
  // base ref, and missing the registry entry or the port env file (a successful
  // bootstrap always writes both). Attribution requires the worktree to sit
  // under the configured root or carry a registry entry, so foreign worktrees
  // are never touched.
  const incomplete = [];
  for (const entry of entries) {
    if (entry.primary || entry.prunable || entry.detached || typeof entry.branch !== 'string' || entry.branch === '') continue;
    const registryEntry = registryEntryFor(entry);
    if (!isInsidePath(entry.path, settings.root) && !registryEntry) continue;
    const envFilePresent = existsSync(path.join(entry.path, settings.ports.envFile));
    if (envFilePresent && registryEntry) continue;
    if (!await branchUntouched(entry.branch)) continue;
    const dirty = await runGit(['status', '--porcelain=v1'], entry.path);
    if (!dirty.ok || dirty.stdout.trim() !== '') continue;
    incomplete.push({
      branch: entry.branch,
      envFilePresent,
      id: registryEntry?.id ?? path.basename(entry.path),
      path: entry.path,
      registryEntryId: registryEntry?.id ?? null,
    });
  }

  // Zero-commit branches nothing checks out, referenced only by residue. The
  // prunable listing is the attribution evidence that the bootstrap created the
  // branch, so this must be detected before prune removes that listing;
  // unreferenced branches are user placeholders and are never deleted. Bindings
  // that only a prunable listing still holds are freed by the prune below, so
  // those branches are cleanup candidates here; every other binding (primary,
  // live or incomplete worktree) keeps its branch out of cleanup.
  const checkedOut = new Set(entries
    .filter((entry) => !entry.prunable && typeof entry.branch === 'string' && entry.branch !== '')
    .map((entry) => entry.branch));
  const branchListing = await runGit(['for-each-ref', 'refs/heads', '--format=%(refname:short)'], projectDir);
  const orphanedBranches = [];
  if (branchListing.ok) {
    for (const branch of branchListing.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)) {
      if (checkedOut.has(branch) || branch === settings.baseRef) continue;
      if (!await branchUntouched(branch)) continue;
      const evidence = (registry?.entries ?? []).some((item) => item.branch === branch) ? 'registry'
        : prunable.some((item) => item.branch === branch) ? 'prunable'
        : null;
      if (evidence === null) continue;
      orphanedBranches.push({ branch, evidence });
    }
  }

  // Registry entries no surviving worktree claims. A prunable worktree is
  // already gone from the filesystem, so its entry only leaks the port block;
  // an entry matched by an incomplete worktree is released by that worktree's
  // own rollback instead.
  const orphanedRegistry = [];
  for (const item of registry?.entries ?? []) {
    const claimed = liveEntries.some((entry) => !entry.primary && (
      item.id === path.basename(entry.path)
      || (item.path && pathKey(item.path) === pathKey(entry.path))
      || (item.branch && item.branch === entry.branch)
    ));
    if (!claimed) orphanedRegistry.push({ id: item.id, path: item.path ?? null });
  }

  // Apply: incomplete worktrees first (each removal is its own rollback), then
  // one prune for the residue, then branch deletes (prune is what frees the
  // bindings the prunable listing held), then registry releases.
  const results = [];
  const candidateResults = [];
  for (const item of candidates) {
    if (item.activeLand) {
      candidateResults.push({
        ...item,
        status: args.write ? 'blocked' : 'planned',
        reason: 'candidate belongs to an active land operation; retry after it finishes',
      });
      continue;
    }
    if (!item.clean) {
      candidateResults.push({ ...item, status: 'blocked', reason: 'candidate is dirty; inspect it before manual cleanup' });
      continue;
    }
    if (!args.write) {
      candidateResults.push(item);
      continue;
    }
    const removed = await cleanupLandCandidate(projectDir, item.path, { settings });
    candidateResults.push(removed.removed
      ? { ...item, status: 'passed' }
      : { ...item, status: 'failed', code: 'WORKTREE_RECOVER_CANDIDATE_FAILED', error: removed.reason });
  }
  for (const item of incomplete) {
    if (!args.write) {
      results.push({ ...item, status: 'planned' });
      continue;
    }
    // A teardown that cannot be proven is reported on the item and does not
    // keep crash residue in place: `recover` only ever removes worktrees whose
    // provisioning never completed.
    const services = await teardownServices(projectDir, item.path);
    const removedLinks = removeWorktreeLinks(projectDir, item.path, settings);
    const removed = await runGit(['worktree', 'remove', '--force', item.path], projectDir);
    if (!removed.ok) {
      results.push({
        ...item,
        code: 'WORKTREE_RECOVER_REMOVE_FAILED',
        error: boundedOutput(removed.stderr || removed.error?.message || 'git worktree remove failed', projectDir),
        removedLinks,
        ...(services.status !== 'passed' ? { services } : {}),
        status: 'failed',
      });
      continue;
    }
    releaseServiceTeardown(projectDir, item.path);
    const branchDeleted = (await runGit(['branch', '--delete', '--force', item.branch], projectDir)).ok;
    const released = item.registryEntryId !== null
      ? await releasePortRegistryEntry(projectDir, item.registryEntryId)
      : { released: false };
    const errors = [];
    if (!branchDeleted) errors.push(`branch ${item.branch} could not be deleted`);
    if (item.registryEntryId !== null && released.released !== true) errors.push(`registry entry ${item.registryEntryId} not released`);
    results.push({
      ...item,
      ...(errors.length > 0 ? { code: 'WORKTREE_RECOVER_PARTIAL', error: errors.join('; ') } : {}),
      branchDeleted,
      portBlockReleased: released.released === true,
      removedLinks,
      ...(services.status !== 'passed' ? { services } : {}),
      status: errors.length === 0 ? 'passed' : 'failed',
    });
  }

  let pruned = null;
  if (args.write && (prunable.length > 0 || incomplete.length > 0)) {
    pruned = (await runGit(['worktree', 'prune'], projectDir)).ok;
  }

  const branchResults = [];
  for (const item of orphanedBranches) {
    if (!args.write) {
      branchResults.push({ ...item, status: 'planned' });
      continue;
    }
    const deleted = await runGit(['branch', '--delete', '--force', item.branch], projectDir);
    branchResults.push(deleted.ok
      ? { ...item, status: 'passed' }
      : {
        ...item,
        code: 'WORKTREE_RECOVER_BRANCH_FAILED',
        error: boundedOutput(deleted.stderr || deleted.error?.message || 'git branch --delete failed', projectDir),
        status: 'failed',
      });
  }

  const registryResults = [];
  for (const item of orphanedRegistry) {
    if (!args.write) {
      registryResults.push({ ...item, status: 'planned' });
      continue;
    }
    const services = item.path ? await teardownServices(projectDir, item.path) : { status: 'passed' };
    // The teardown writes its worktree marker even without a registry entry, and
    // this branch never removes the worktree afterwards, so the marker has to be
    // released here or a later service start in the same path stays blocked.
    if (item.path) releaseServiceTeardown(projectDir, item.path);
    const released = await releasePortRegistryEntry(projectDir, item.id);
    registryResults.push(released.released === true
      ? { ...item, ...(services.status !== 'passed' ? { services } : {}), status: 'passed' }
      : {
        ...item,
        code: 'WORKTREE_RECOVER_RELEASE_FAILED',
        error: released.reason ?? released.error ?? 'registry entry not released',
        ...(services.status !== 'passed' ? { services } : {}),
        status: 'failed',
      });
  }

  const failed = [...results, ...candidateResults, ...branchResults, ...registryResults].some((item) => item.status === 'failed' || item.status === 'blocked')
    || (args.write && prunable.length > 0 && pruned !== true);
  const summary = [
    `status: ${failed ? 'failed' : args.write ? 'passed' : 'planned'} (write: ${Boolean(args.write)})`,
    `prunable residue: ${prunable.length}${prunable.length > 0 ? ` (${prunable.map((item) => item.path).join(', ')})` : ''}`,
    ...candidateResults.map((item) => `land candidate: ${item.path} ${item.status}${item.reason ? ` (${item.reason})` : ''}`),
    ...results.map((item) => `incomplete: ${item.path} branch ${item.branch} ${item.status}`),
    ...branchResults.map((item) => `branch: ${item.branch} ${item.status}${item.evidence ? ` [${item.evidence}]` : ''}${item.error ? ` (${item.error})` : ''}`),
    ...registryResults.map((item) => `registry entry: ${item.id} ${item.status}`),
  ].join('\n');
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'recover',
    status: failed ? 'failed' : args.write ? 'passed' : 'planned',
    baseRef: settings.baseRef,
    candidates: candidateResults,
    orphanedBranches: branchResults,
    orphanedRegistry: registryResults,
    prunable: prunable.map((item) => ({
      branch: item.branch,
      path: item.path,
      reason: typeof item.prunable === 'string' ? item.prunable : 'worktree directory missing',
    })),
    pruned: args.write ? pruned : null,
    results,
    summary,
    write: Boolean(args.write),
  };
}
export async function worktreeReport(projectDir, args) {
  const subcommand = args._[1] ?? 'check';
  if (args.targetMode !== undefined && subcommand !== 'land') {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand, status: 'failed',
      code: 'WORKTREE_TARGET_MODE_INVALID', error: '--target-mode is only supported by worktree land' };
  }
  if (subcommand === 'list') return worktreeListReport(projectDir);
  if (subcommand === 'check') return worktreeCheckReport(projectDir, args);
  if (subcommand === 'bootstrap') return worktreeBootstrapReport(projectDir, args);
  if (subcommand === 'land') return worktreeLandReport(projectDir, args);
  if (subcommand === 'cleanup') return worktreeCleanupReport(projectDir, args);
  if (subcommand === 'recover') return worktreeRecoverReport(projectDir, args);
  throw new Error(`Unknown worktree subcommand: ${subcommand} (expected list, check, bootstrap, land, cleanup or recover)`);
}
