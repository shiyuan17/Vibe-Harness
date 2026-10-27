// Worktree inspection, provisioning, staging, publishing and recovery.
//
// The lifecycle commands share one model: workspace topology discovery,
// dependency mirrors, port blocks and the stage/publish steps that verify a
// merge outside the delivery queue before a seconds-scale finalize pushes it.
//
// Extracted verbatim from `runtime/commands/run.mjs` so that file keeps only
// argument parsing, dispatch and output selection. Behaviour, field names and
// exit codes are unchanged; only the module boundary moved.
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
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
import { CONFIG_FILE, PASS_STATUSES, SCHEMA_VERSION, assertSafeCommand, delay, isInsidePath, normalizeSlashes, packageManager, probeExecutable, readProjectConfig, runFile, runGit, safeRealpath } from './cli-runtime.mjs';
import { gitTimeoutMs } from './git-timeouts.mjs';
import { boundParentBatches } from './parent-batch.mjs';
import {
  acquireLease,
  acquireLeaseWithRetry,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  readLease,
  releaseLease,
  startLeaseHeartbeat,
} from './lease-lock.mjs';
import { TASK_UNIT_FAILURE_STATUSES, planDependentUnits, planUnitGraph, readTaskAnchor, taskAnchorRelativePath, taskCheckpointReport, taskPlanCheckReport, taskParentBatchEvidence } from './task-command.mjs';
import { verifyProject } from './verification-command.mjs';
import { buildDeliveryVerificationPlan, deliveryRiskPolicy } from './verification-risk.mjs';
import { candidateEnvironment } from './verification-inputs.mjs';
import { createPushVerification, preparePushAttempt } from './push-verification.mjs';
import { candidateResourceId, readCandidateResources, saveCandidateResources } from './candidate-resources.mjs';
import { configuredChecks, executeCommand, parseVerifyTier, resolveReceiptTier, resolveReviewedChecks, timeoutValue } from './verification-plan-support.mjs';
import {
  acquireDeliveryTurn,
  inspectDeliveryQueue,
  reconcileDeliveryQueue,
  releaseDeliveryTurn,
} from './worktree-delivery-queue.mjs';

// Per-transaction locks fence retries of one batch. Cross-transaction
// publishing is serialized by the repository FIFO, but only for the
// seconds-scale finalize section (re-check, push, readback, confirm);
// staging and verification run outside the queue.
const LAND_LOCK_TIMEOUT_MS = 180_000;
const LAND_LOCK_RETRY_MS = 50;
const LAND_MAX_ATTEMPTS = 3;
const DEFAULT_LAND_CLEANUP_TIMEOUT_MS = 30_000;
const LAND_TRANSACTION_SCHEMA_VERSION = 5;
const STAGED_REF_PREFIX = 'refs/vibe-harness/staged';
const REMOTE_SNAPSHOT_REF_PREFIX = 'refs/vibe-harness/remote';
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
    baseRef: args.baseRef ?? configured.baseRef ?? 'origin/develop',
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
 * Copy an isolated dependency root without flattening pnpm's package links.
 *
 * `cpSync(..., { dereference: true })` makes the copy independent of the
 * primary checkout, but turns every top-level package junction into a plain
 * directory. Isolated pnpm layouts resolve a package's optional and peer
 * dependencies through its sibling paths under `.pnpm/<id>/node_modules`; once
 * the top-level package no longer points there, tools such as TypeScript 7
 * cannot find their platform package. Preserve the copied package files and
 * `.pnpm` store, then reconnect the top-level links inside the candidate.
 */
function copyIsolatedModules(sourceModules, worktreeModules) {
  const packageLinks = [];
  const collectScopeLinks = (directory, scope) => {
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      const source = path.join(directory, entry.name);
      const target = safeRealpath(source);
      if (!target || !isInsidePath(target, sourceModules)) continue;
      const relative = scope === null ? entry.name : `${scope}/${entry.name}`;
      packageLinks.push({
        link: relative,
        target: normalizeSlashes(path.relative(sourceModules, target)),
      });
    }
  };
  collectScopeLinks(sourceModules, null);
  for (const entry of readdirSync(sourceModules, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      collectScopeLinks(path.join(sourceModules, entry.name), entry.name);
    }
  }
  if (existsSync(worktreeModules)) rmSync(worktreeModules, { recursive: true, force: true });
  cpSync(sourceModules, worktreeModules, { recursive: true, dereference: true });
  for (const packageLink of packageLinks) {
    const link = path.join(worktreeModules, packageLink.link);
    const target = path.join(worktreeModules, packageLink.target);
    if (!existsSync(target)) continue;
    if (existsSync(link)) rmSync(link, { recursive: true, force: true });
    mkdirSync(path.dirname(link), { recursive: true });
    linkDirectory(target, link);
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
        blockers: [transaction.error ?? 'A staged delivery owns this source; run publish --batch <batchId> --write to finalize it, or discard --batch <batchId> --write to close it unpublished'] });
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

function dependencyRootBlockers(projectDir, worktreePath, settings, { locations = ['main checkout', 'worktree'] } = {}) {
  if ((settings.provision?.setupCommands ?? []).length > 0) return [];
  const blockers = [];
  for (const root of settings.dependencyRoots) {
    for (const [label, base] of [['main checkout', projectDir], ['worktree', worktreePath]]) {
      if (!locations.includes(label)) continue;
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
function stagedRef(batchId) {
  return `${STAGED_REF_PREFIX}/${batchId}`;
}
function remoteSnapshotRef(batchId) {
  return `${REMOTE_SNAPSHOT_REF_PREFIX}/${batchId}`;
}
function pushEndpointFingerprint(url) {
  return createHash('sha256').update(String(url)).digest('hex');
}
function persistedPushTarget(target) {
  if (!target || typeof target !== 'object') return null;
  return {
    remote: target.remote ?? 'origin',
    ref: target.ref,
    ...(typeof target.fingerprint === 'string' ? { fingerprint: target.fingerprint } : {}),
    ...(target.unavailable === true ? { unavailable: true } : {}),
  };
}
function deliveryQueueTransaction(handle) {
  const report = handle?.report && typeof handle.report === 'object' ? handle.report : handle;
  if (!report || typeof report !== 'object' || typeof report.state !== 'string') return null;
  return {
    schemaVersion: 1,
    ticketId: report.ticketId ?? null,
    state: report.state ?? 'queued',
    position: report.position ?? null,
    ahead: report.ahead ?? null,
    waitedMs: report.waitedMs ?? 0,
  };
}
function deliveryQueueReport(handle, state = null) {
  if (!handle?.report) return null;
  return {
    ...handle.report,
    ...(state ? { state } : {}),
  };
}
function createDeliveryGate(projectDir, args, operation, batchId = null) {
  let handle = null;
  let finished = null;
  let failure = null;
  return {
    get handle() {
      return handle;
    },
    get failure() {
      return failure;
    },
    async ensure() {
      if (handle) return handle;
      if (failure) return failure;
      const acquired = await acquireDeliveryTurn(projectDir, {
        operation,
        batchId,
        onProgress: args.onProgress,
      });
      if (!acquired.ok) {
        failure = acquired;
        return acquired;
      }
      handle = acquired;
      return acquired;
    },
    async release(status = 'completed') {
      if (!handle) return false;
      const turn = handle;
      const released = await releaseDeliveryTurn(turn, status);
      // Drop the turn even when release reports a lost ticket so a stale
      // handle is never reused; ensure() acquires a fresh turn instead.
      handle = null;
      if (released) finished = turn;
      return released;
    },
    report(state = null) {
      if (handle) return deliveryQueueReport(handle, state);
      if (finished) return deliveryQueueReport(finished, state);
      return null;
    },
  };
}
async function releaseDeliveryGate(args, state, file, status = 'completed') {
  const gate = args?._deliveryGate;
  if (!gate) return null;
  await gate.release(status);
  const report = gate.report(status);
  if (state && report) state.queue = deliveryQueueTransaction(report);
  if (state && file) saveBatchState(file, state);
  return report;
}
function queueBlockedFailure(subcommand, failure) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand,
    status: 'blocked',
    commandStatus: 'blocked',
    integrationStatus: 'not_integrated',
    remoteValidation: 'not_required',
    localRefSync: 'not_attempted',
    code: failure.code ?? 'WORKTREE_QUEUE_UNAVAILABLE',
    error: failure.error ?? 'repository delivery queue is unavailable',
    queue: failure.queue ?? null,
  };
}
function saveBatchState(file, state) {
  // Credentials can appear in remote URLs. Persist only a stable endpoint
  // fingerprint and names; the live command keeps the URL in memory.
  const persisted = {
    ...state,
    schemaVersion: LAND_TRANSACTION_SCHEMA_VERSION,
    pushTarget: persistedPushTarget(state.pushTarget),
  };
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, file);
}
function batchFailure(code, error, extra = {}) {
  return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'stage',
    status: 'blocked', code, error, ...extra };
}
// Freeze the effective push endpoint, never Git's default refspec/upstream.
async function landPushTarget(projectDir, target) {
  if (target !== 'develop') return { error: 'local-land pushes only origin/develop; check out develop first' };
  const [urls, mirror] = await Promise.all([
    runGit(['remote', 'get-url', '--push', '--all', 'origin'], projectDir),
    runGit(['config', '--bool', '--get', 'remote.origin.mirror'], projectDir),
  ]);
  const addresses = urls.ok ? urls.stdout.trim().split(/\r?\n/u).filter(Boolean) : [];
  if (addresses.length !== 1 || mirror.stdout.trim() === 'true') {
    return { error: 'origin must have exactly one effective push URL and must not be a mirror' };
  }
  return {
    remote: 'origin',
    url: addresses[0],
    ref: 'refs/heads/develop',
    fingerprint: pushEndpointFingerprint(addresses[0]),
  };
}
async function resolveStoredPushTarget(projectDir, state, target) {
  const endpoint = await landPushTarget(projectDir, target);
  if (endpoint.error) return endpoint;
  const stored = persistedPushTarget(state.pushTarget);
  if (stored?.fingerprint && (stored.ref !== endpoint.ref || stored.fingerprint !== endpoint.fingerprint)) {
    return {
      code: 'LAND_PUSH_TARGET_CHANGED',
      error: 'The effective push endpoint changed since this transaction was staged',
    };
  }
  if (stored?.ref && stored.ref !== endpoint.ref) {
    return {
      code: 'LAND_PUSH_TARGET_CHANGED',
      error: 'The target ref changed since this transaction was staged',
    };
  }
  state.pushTarget = endpoint;
  return endpoint;
}
async function exactRemoteHead(projectDir, endpoint) {
  const result = await runGit(['ls-remote', '--exit-code', '--', endpoint.url, endpoint.ref], projectDir);
  const lines = result.ok ? result.stdout.trim().split(/\r?\n/u) : [];
  const [sha, ref] = lines[0]?.split(/\s+/u) ?? [];
  return lines.length === 1 && ref === endpoint.ref && /^[0-9a-f]{40,64}$/iu.test(sha ?? '')
    ? { ok: true, sha } : { ok: false, sha: null };
}
async function localLandBaseline(projectDir, target) {
  const local = await runGit(['rev-parse', `refs/heads/${target}`], projectDir);
  return local.ok && /^[0-9a-f]{40,64}$/iu.test(local.stdout.trim())
    ? { sha: local.stdout.trim() }
    : { error: `Cannot resolve local ${target}; stage does not fetch or create the target branch` };
}

async function inspectPrimaryCheckout(primary) {
  const [branch, head, status, trackedDiff, stagedDiff] = await Promise.all([
    runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], primary.path),
    runGit(['rev-parse', 'HEAD'], primary.path),
    runGit(['status', '--porcelain=v1', '--untracked-files=all'], primary.path),
    runGit(['diff', '--shortstat', '--no-ext-diff'], primary.path),
    runGit(['diff', '--cached', '--shortstat', '--no-ext-diff'], primary.path),
  ]);
  const changes = status.ok
    ? status.stdout.split(/\r?\n/u).map((line) => line.trimEnd()).filter(Boolean).map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3),
    }))
    : [];
  return {
    readable: status.ok,
    branch: branch.ok ? branch.stdout.trim() : primary.branch,
    head: head.ok ? head.stdout.trim() : null,
    dirty: !status.ok || changes.length > 0,
    changeCount: changes.length,
    trackedChangeCount: changes.filter((change) => change.status !== '??').length,
    untrackedChangeCount: changes.filter((change) => change.status === '??').length,
    changes: changes.slice(0, 50),
    changesTruncated: changes.length > 50,
    unstagedSummary: trackedDiff.ok ? trackedDiff.stdout.trim() : null,
    stagedSummary: stagedDiff.ok ? stagedDiff.stdout.trim() : null,
    guidance: 'Preserve all changes. Do not delete, stash, stage, or commit user work automatically.',
  };
}

function landCleanupTimeoutMs() {
  const configured = Number.parseInt(process.env.VIBE_HARNESS_LAND_CLEANUP_TIMEOUT_MS ?? '', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_LAND_CLEANUP_TIMEOUT_MS;
}


async function cleanupLand(projectDir, primary, settings, state, file, { deferParentSources = false } = {}) {
  const cleanupStartedAt = Date.now();
  const deadline = cleanupStartedAt + landCleanupTimeoutMs();
  const remainingMs = () => Math.max(1, deadline - Date.now());
  const cleanupGit = (args, cwd = projectDir) => runGit(args, cwd, { timeoutMs: remainingMs() });
  const cleanup = [];
  const timeoutItem = (id, reason = 'cleanup execution limit reached') => ({
    ...(id ? { id } : {}),
    status: 'blocked',
    code: 'LAND_CLEANUP_TIMEOUT',
    reason,
  });
  if (state.push) {
    for (const source of state.sources) {
      const previous = state.cleanup?.find((item) => item.id === source.id);
      if (previous?.status === 'passed' && previous.portBlockReleased) { cleanup.push(previous); continue; }
      const item = { id: source.id, status: 'passed', branchDeleted: false, portBlockReleased: false };
      if (deferParentSources && source.executionBatch) {
        cleanup.push({ ...item, status: 'deferred', reason: 'retain Parent workspace until Linear sync; then run cleanup --batch' });
        continue;
      }
      if (Date.now() >= deadline) {
        cleanup.push(timeoutItem(source.id));
        continue;
      }
      const sourceHead = await cleanupGit(['rev-parse', '--verify', `refs/heads/${source.branch}`]);
      if (sourceHead.ok && sourceHead.stdout.trim() !== source.head) {
        cleanup.push({ ...item, status: 'blocked', reason: 'source HEAD changed' }); continue;
      }
      if (existsSync(source.path)) {
        const currentEntries = await worktreeEntries(projectDir, { timeoutMs: remainingMs() });
        const owned = currentEntries.entries.some((entry) => !entry.primary && !entry.detached
          && entry.branch === source.branch && pathKey(entry.path) === pathKey(source.path));
        const checkedHead = await cleanupGit(['rev-parse', 'HEAD'], source.path);
        if (currentEntries.reason || !owned || !checkedHead.ok || checkedHead.stdout.trim() !== source.head) {
          cleanup.push({ ...item, status: 'blocked', reason: 'source worktree identity changed' }); continue;
        }
        const stopped = await teardownServices(projectDir, source.path, true, { timeoutMs: remainingMs() });
        const sourceStatus = await cleanupGit(['status', '--porcelain=v1', '--untracked-files=all'], source.path);
        if (stopped.status !== 'passed' || !sourceStatus.ok || sourceStatus.stdout.trim() || Date.now() >= deadline) {
          releaseServiceTeardown(projectDir, source.path);
          cleanup.push(Date.now() >= deadline ? timeoutItem(source.id)
            : { ...item, status: 'blocked', reason: 'source dirty or services still occupied' }); continue;
        }
        state.sourceCleanup ??= {};
        state.sourceCleanup[source.id] = { path: source.path, head: source.head, stopped: true };
        saveBatchState(file, state);
        removeWorktreeLinks(projectDir, source.path, settings);
        const removed = await cleanupGit(['worktree', 'remove', source.path]);
        releaseServiceTeardown(projectDir, source.path);
        if (!removed.ok) {
          cleanup.push({ ...item, status: 'blocked', reason: 'worktree removal failed; resource allocation retained' }); continue;
        }
      } else {
        const stopped = await teardownServices(projectDir, source.path, true, { timeoutMs: remainingMs() });
        releaseServiceTeardown(projectDir, source.path);
        if (stopped.status !== 'passed') {
          cleanup.push({ ...item, status: 'blocked', reason: 'missing source has unconfirmed services' }); continue;
        }
      }
      if (sourceHead.ok) {
        // The primary checkout may intentionally lag the published target when
        // it is dirty. In that case -d would reject a branch that is already
        // contained in the exact candidate confirmed on the remote. Prove that
        // ancestry first, then use -D without weakening the no-unmerged rule.
        const containedInPublished = state.pushConfirmed === true
          && (await cleanupGit(['merge-base', '--is-ancestor', source.head,
            state.remoteConfirmedHead ?? state.candidateHead], primary.path)).ok;
        const deleted = await cleanupGit(['branch', containedInPublished ? '-D' : '-d', source.branch], primary.path);
        if (!deleted.ok) { cleanup.push({ ...item, status: 'blocked', reason: 'branch deletion failed' }); continue; }
      }
      item.branchDeleted = true;
      const released = await releasePortRegistryEntry(projectDir, source.id, { timeoutMs: remainingMs(), expectedPath: source.path });
      const registryAfter = readPortRegistry(projectDir);
      item.portBlockReleased = released.released === true
        || !registryAfter.error && (registryAfter.registry === null
          || !registryAfter.registry.entries.some((entry) => entry.id === source.id));
      if (!item.portBlockReleased) Object.assign(item, { status: 'blocked', reason: 'resource registry release unconfirmed' });
      cleanup.push(item);
      state.cleanup = [...cleanup, ...(state.cleanup ?? []).filter((entry) => !cleanup.some((done) => done.id === entry.id))];
      saveBatchState(file, state);
    }
  }
  const candidateCleanup = [];
  for (const candidate of [state.candidate, ...(state.previousCandidates ?? [])]) {
    if (!existsSync(candidate)) {
      const context = await readCandidateResources(projectDir, candidate);
      if (context && context.phase !== 'cleaned') {
        if (context.phase !== 'stopped') {
          candidateCleanup.push({ removed: false, residual: normalizeSlashes(candidate), reason: 'resource stop unconfirmed' });
          continue;
        }
        await releasePortRegistryEntry(projectDir, context.id, { expectedPath: candidate });
        const registry = readPortRegistry(projectDir);
        if (registry.error || registry.registry?.entries.some((entry) => entry.id === context.id)) {
          candidateCleanup.push({ removed: false, residual: normalizeSlashes(candidate), reason: 'resource registry release unconfirmed' });
          continue;
        }
        await saveCandidateResources(projectDir, candidate, { ...context, phase: 'cleaned' });
      }
      continue;
    }
    if (Date.now() >= deadline) {
      candidateCleanup.push({ removed: false, residual: normalizeSlashes(candidate), reason: 'cleanup execution limit reached' });
      continue;
    }
    const dirtyCandidate = await cleanupGit(['status', '--porcelain=v1', '--untracked-files=all'], candidate);
    candidateCleanup.push(dirtyCandidate.ok && !dirtyCandidate.stdout.trim()
      ? await cleanupLandCandidate(projectDir, candidate, { settings, timeoutMs: remainingMs() })
      : { removed: false, residual: normalizeSlashes(candidate), reason: 'candidate dirty' });
  }
  const pending = cleanup.some((item) => item.status !== 'passed') || candidateCleanup.some((item) => !item.removed);
  state.phase = pending ? 'cleanup_pending' : 'cleaned';
  state.integrationStatus = pending ? 'integrated_cleanup_pending' : 'integrated';
  state.cleanup = cleanup;
  saveBatchState(file, state);
  if (!pending) {
    state.cleanedAt = new Date().toISOString();
    saveBatchState(file, state);
  }
  return {
    integrationStatus: pending ? 'integrated_cleanup_pending' : 'integrated',
    ...(pending ? { code: 'LAND_BATCH_CLEANUP_INCOMPLETE', warnings: [{ code: 'LAND_CLEANUP_PENDING', message: '已集成、待清理；重试只清理，残留资源保持占用。' }] } : {}),
    cleanup,
    candidateCleanup,
    timingsMs: { cleanupMs: Date.now() - cleanupStartedAt },
    candidatePath: existsSync(state.candidate) ? normalizeSlashes(state.candidate) : null,
  };
}
async function batchSourcesStillValid(projectDir, state) {
  for (const source of state.sources) {
    const [head, dirty] = await Promise.all([
      runGit(['rev-parse', `refs/heads/${source.branch}`], projectDir),
      runGit(['status', '--porcelain=v1', '--untracked-files=all'], source.path),
    ]);
    if (!head.ok || head.stdout.trim() !== source.head || !dirty.ok || dirty.stdout.trim() !== '') return false;
    if (source.executionBatch) {
      const evidence = await taskParentBatchEvidence(source.path, source.id);
      if (!evidence.ok || evidence.membershipDigest !== source.executionBatch.membershipDigest
        || evidence.unmappedCommits.length || evidence.externalPending.length
        || evidence.members.some((id) => !evidence.localCompleted.includes(id))
        || evidence.units.some((unit) => unit.status !== 'done')) return false;
      const current = await readTaskAnchor(source.path, source.id);
      if (current.anchor.planDigest !== source.executionBatch.planDigest) return false;
    }
  }
  return true;
}
async function batchMergeNext(projectDir, state, file) {
  while (state.next < state.sources.length) {
    const source = state.sources[state.next];
    const merged = await runGit(['merge-base', '--is-ancestor', source.head, 'HEAD'], state.candidate);
    if (!merged.ok) {
      const result = await runIsolatedGit(projectDir, ['merge', '--no-ff', '--no-edit', '--no-verify', source.head], state.candidate);
      if (!result.ok) {
        const unresolved = await runGit(['diff', '--name-only', '--diff-filter=U'], state.candidate);
        const mergeHead = await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], state.candidate);
        if (!mergeHead.ok || !unresolved.ok || unresolved.stdout.trim() === '') {
          return batchFailure('LAND_BATCH_MERGE_FAILED', boundedOutput(result.stderr || result.error?.message || 'merge failed', projectDir),
            { batchId: state.id, candidatePath: normalizeSlashes(state.candidate) });
        }
        state.phase = 'conflict';
        state.conflicts.push({ task: source.id, files: unresolved.stdout.trim().split(/\r?\n/u), at: new Date().toISOString() });
        saveBatchState(file, state);
        return batchFailure('LAND_BATCH_CONFLICT', 'Resolve the conflict in the candidate, stage the resolution, then rerun worktree stage with --resume <batchId> --write. No target ref moved.',
          { batchId: state.id, candidatePath: normalizeSlashes(state.candidate), task: source.id, files: state.conflicts.at(-1).files, resumable: true });
      }
    }
    state.next += 1;
    state.phase = 'merging';
    saveBatchState(file, state);
  }
  state.phase = 'merged';
  saveBatchState(file, state);
  return null;
}
async function batchResumeConflict(projectDir, state, file) {
  const unresolved = await runGit(['diff', '--name-only', '--diff-filter=U'], state.candidate);
  if (!unresolved.ok || unresolved.stdout.trim()) return batchFailure('LAND_BATCH_CONFLICT_UNRESOLVED',
    'Unmerged index entries remain', { batchId: state.id, candidatePath: normalizeSlashes(state.candidate),
      files: unresolved.ok ? unresolved.stdout.trim().split(/\r?\n/u) : [] });
  const marker = await runGit(['grep', '-n', '-I', '-E', '^(<<<<<<< |=======|>>>>>>> )', '--', '.'], state.candidate);
  if (marker.ok) return batchFailure('LAND_BATCH_CONFLICT_MARKERS', 'Conflict markers remain in tracked files',
    { batchId: state.id, candidatePath: normalizeSlashes(state.candidate), detail: boundedOutput(marker.stdout, projectDir) });
  const stagedCheck = await runGit(['diff', '--cached', '--check'], state.candidate);
  if (!stagedCheck.ok) return batchFailure('LAND_BATCH_RESOLUTION_DIFF', 'Staged resolution fails git diff --check',
    { batchId: state.id, candidatePath: normalizeSlashes(state.candidate), detail: boundedOutput(stagedCheck.stdout || stagedCheck.stderr, projectDir) });
  // A clean index is not proof of semantic correctness. The agent must inspect
  // both sides and the resulting behavior; final verification runs only after
  // all merges and resolutions have been committed.
  const mergeHead = await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], state.candidate);
  if (!mergeHead.ok || mergeHead.stdout.trim() !== state.sources[state.next]?.head) {
    return batchFailure('LAND_BATCH_MERGE_STATE_CHANGED', 'The pending MERGE_HEAD does not match the frozen source',
      { batchId: state.id, candidatePath: normalizeSlashes(state.candidate) });
  }
  const committed = await runIsolatedGit(projectDir, ['commit', '--no-verify', '--no-edit'], state.candidate);
  if (!committed.ok) return batchFailure('LAND_BATCH_RESOLUTION_COMMIT_FAILED',
    boundedOutput(committed.stderr || committed.error?.message || 'merge commit failed', projectDir),
    { batchId: state.id, candidatePath: normalizeSlashes(state.candidate) });
  state.resolved += 1;
  const conflict = state.conflicts.at(-1);
  if (conflict && !conflict.resolvedAt) {
    conflict.resolvedAt = new Date().toISOString();
    conflict.resolutionMs = Date.parse(conflict.resolvedAt) - Date.parse(conflict.at);
  }
  state.next += 1;
  state.phase = 'merging';
  saveBatchState(file, state);
  return null;
}
async function prepareBatchCandidate(projectDir, state, settings, { existing = false } = {}) {
  if (!existing) {
    const added = await runIsolatedGit(projectDir, ['worktree', 'add', '--detach', state.candidate, state.baseHead]);
    if (!added.ok) return boundedOutput(added.stderr || added.error?.message || 'worktree add failed', projectDir);
  }
  try {
    const changes = await Promise.all(state.sources.map((source) => runGit(['diff', '--name-only',
      '--no-renames', state.riskBaseHead ?? state.baseHead, source.head, '--'], projectDir)));
    if (state.riskBaseHead && state.riskBaseHead !== state.baseHead) {
      changes.push(await runGit(['diff', '--name-only', '--no-renames', state.riskBaseHead, state.baseHead, '--'], projectDir));
    }
    const config = await readProjectConfig(projectDir);
    const dependencyChanged = changes.some((changed) => !changed.ok
      || /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/mu.test(changed.stdout));
    const declaredCommands = Object.values(config.validationCommands ?? {}).flatMap((value) =>
      typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flat() : [])
      .filter((value) => typeof value === 'string');
    const isolateDependencies = settings.dependencyMode === 'isolated'
      || config.worktree?.dependencyMode !== 'shared-immutable'
      || dependencyChanged
      || changes.some((changed) => /(?:^|\/)vibe-harness\.config\.json$/mu.test(changed.stdout))
      || settings.provision.candidateSetupCommands.length > 0
      || declaredCommands.some((command) => /\b(?:install|add|update|generate|codegen|build)\b/u.test(command))
      || config.validationCommands?.checks?.some((check) => check.writesDependencies === true);
    const dependencyPaths = new Set([...settings.dependencyRoots.map((root) => `${root}/node_modules`),
      ...(existsSync(path.join(projectDir, 'node_modules')) ? ['node_modules'] : [])]);
    if (isolateDependencies) {
      for (const relative of dependencyPaths) {
        const source = path.join(projectDir, relative);
        if (existsSync(source)) copyIsolatedModules(source, path.join(state.candidate, relative));
      }
      for (const root of settings.dependencyRoots) {
        for (const local of packagesForRoot(settings, root)) {
          const destination = safeWorktreeFile(state.candidate, `${root}/node_modules/${local.name}`, 'isolated local dependency');
          if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
          mkdirSync(path.dirname(destination), { recursive: true });
          linkDirectory(path.join(state.candidate, local.dir), destination);
        }
      }
    } else {
      for (const root of settings.dependencyRoots) linkDependencyRoot(projectDir, state.candidate, settings, root);
      linkPackageRoots(projectDir, state.candidate, settings);
    }
    const mirrors = isolateDependencies ? settings.mirrors.filter((item) => !/(?:^|\/)node_modules(?:\/|$)/u.test(item)) : settings.mirrors;
    if (mirrors.length) linkOrCopyMirrors(projectDir, state.candidate, mirrors);
    for (const relative of new Set(settings.provision.envFiles.filter((file) => file !== settings.ports.envFile))) {
      const source = safeWorktreeFile(state.sources[0].path, relative, 'batch candidate env');
      const target = safeWorktreeFile(state.candidate, relative, 'batch candidate env');
      if (existsSync(source)) {
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
    }
    const id = candidateResourceId(state.candidate);
    let context = { schemaVersion: 1, id, batchId: state.id, path: state.candidate,
      namespace: `vh_${id.replaceAll('-', '_')}`, ports: {},
      dependencyMode: isolateDependencies ? 'isolated' : 'shared-immutable',
      requiresInstall: dependencyChanged,
      setupCommands: settings.provision.candidateSetupCommands,
      teardownCommands: settings.provision.candidateTeardownCommands,
      setup: 'pending', setupNext: 0, teardownNext: 0, phase: 'allocating' };
    context = await saveCandidateResources(projectDir, state.candidate, context);
    const allocated = await withPortRegistryLock(projectDir, () => {
      const assignment = planPortAssignment(projectDir, settings, { id, branch: null, path: state.candidate });
      if (assignment.error) return assignment;
      writePortRegistry(projectDir, assignment.registry);
      return assignment;
    });
    if (allocated.error) return allocated.error;
    context = { ...context, ports: allocated.ports, phase: 'allocated' };
    const directory = path.join(state.candidate, '.vibe-harness');
    mkdirSync(directory, { recursive: true });
    await saveCandidateResources(projectDir, state.candidate, context);
    const envFile = safeWorktreeFile(state.candidate, settings.ports.envFile, 'candidate env');
    mkdirSync(path.dirname(envFile), { recursive: true });
    writeFileSync(envFile, renderWorktreeEnv({ block: allocated.block, id, ports: allocated.ports }));
    state.resources = { id, path: state.candidate, ports: allocated.ports };
  } catch (error) {
    return error.message;
  }
  return null;
}
/** Ordinary pushes provision the exact detached object using the same resource protocol. */
export async function prepareNativePushCandidate(projectDir, candidate) {
  const config = await readProjectConfig(candidate);
  const settings = resolveWorktreeSettings(projectDir, config, {});
  if (settings.error) throw new Error(settings.error);
  settings.dependencyMode = 'isolated';
  settings.mirrors = [];
  const head = await runGit(['rev-parse', 'HEAD'], candidate);
  if (!head.ok) throw new Error('Native push candidate HEAD unavailable');
  const primaryHead = await runGit(['rev-parse', 'HEAD'], projectDir);
  const state = { id: randomUUID(), candidate, sources: [{ path: projectDir, head: head.stdout.trim() }],
    baseHead: primaryHead.ok ? primaryHead.stdout.trim() : head.stdout.trim() };
  const error = await prepareBatchCandidate(projectDir, state, settings, { existing: true });
  if (error) throw new Error(error);
  const setup = await setupCandidateEnvironment(projectDir, candidate, 120000);
  if (!setup.ok) throw new Error(setup.error);
  return settings;
}
export async function cleanupNativePushCandidate(projectDir, candidate, settings = null) {
  return cleanupLandCandidate(projectDir, candidate, { settings });
}
async function setupCandidateEnvironment(projectDir, candidate, timeoutMs) {
  const context = await readCandidateResources(projectDir, candidate);
  const { environment } = candidateEnvironment(candidate);
  if (!context || context.setup === 'passed') return { ok: true };
  if (context.setup === 'pending') {
    const settings = resolveWorktreeSettings(candidate, await readProjectConfig(candidate), {});
    if (settings.error) return { ok: false, error: settings.error };
    context.setupCommands = settings.provision.candidateSetupCommands;
    context.teardownCommands = settings.provision.candidateTeardownCommands;
    if (context.requiresInstall && !context.setupCommands.length) {
      return { ok: false, error: 'Dependency inputs changed: declare paired candidate setup/teardown with a frozen install' };
    }
    if (context.setupCommands.length && context.dependencyMode !== 'isolated') {
      return { ok: false, error: 'Candidate setup requires isolated dependencies' };
    }
  }
  context.setup = 'running';
  await saveCandidateResources(projectDir, candidate, context);
  for (let index = context.setupNext ?? 0; index < context.setupCommands.length; index++) {
    context.pendingStep = `setup:${index}`;
    await saveCandidateResources(projectDir, candidate, context);
    const result = await executeCommand(context.setupCommands[index], candidate, timeoutMs, candidate,
      { ...environment, VIBE_HARNESS_RESOURCE_STEP: context.pendingStep });
    if (result.status !== 'passed') return { ok: false, error: 'candidate setup failed', result };
    context.setupNext = index + 1;
    context.pendingStep = null;
    await saveCandidateResources(projectDir, candidate, context);
  }
  context.setup = 'passed';
  await saveCandidateResources(projectDir, candidate, context);
  return { ok: true };
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
async function rebaseBatchCandidate(projectDir, state, file, settings, targetHead) {
  if (!targetHead.ok || !targetHead.stdout.trim()) {
    return batchFailure('LAND_BATCH_BASELINE_CHANGED', 'Target HEAD cannot be resolved',
      { batchId: state.id, candidatePath: normalizeSlashes(state.candidate) });
  }
  const oldCandidate = state.candidate;
  const newCandidate = path.join(path.dirname(settings.root), `.vibe-harness-land-batch-${randomUUID()}`);
  const next = { ...state, baseHead: targetHead.stdout.trim(), candidate: newCandidate, next: 0,
    resolved: 0, conflicts: [],
    phase: 'merging', previousCandidates: [...(state.previousCandidates ?? []), oldCandidate],
    replayCount: (state.replayCount ?? 0) + 1 };
  const error = await prepareBatchCandidate(projectDir, next, settings);
  if (error) return batchFailure('LAND_BATCH_REBASE_SETUP_FAILED', error,
    { batchId: state.id, candidatePath: normalizeSlashes(oldCandidate) });
  Object.assign(state, next);
  saveBatchState(file, state);
  return null;
}
function stagedStateReport(state, extra = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'stage',
    status: 'passed',
    commandStatus: 'passed',
    integrationStatus: 'local_staged',
    remoteValidation: 'not_required',
    localRefSync: state.localRefSync ?? 'not_attempted',
    phase: state.phase,
    batchId: state.id,
    batch: !state.single,
    targetBranch: state.target,
    sourceBranch: state.sources[0].branch,
    sourceHead: state.sources[0].head,
    targetBefore: state.baseHead,
    targetAfter: state.candidateHead,
    candidateHead: state.candidateHead,
    stagedRef: state.stagedRef ?? stagedRef(state.id),
    candidatePath: existsSync(state.candidate) ? normalizeSlashes(state.candidate) : null,
    integration: state.integration,
    queue: state.queue ?? null,
    ...extra,
  };
}
async function stageBatchCandidate(projectDir, state, file, settings, verification, args) {
  const candidateHead = await runGit(['rev-parse', 'HEAD'], state.candidate);
  if (!candidateHead.ok || !/^[0-9a-f]{40,64}$/iu.test(candidateHead.stdout.trim())) {
    return batchFailure('LAND_BATCH_CANDIDATE_HEAD_UNRESOLVED',
      'Cannot resolve the verified candidate before staging', {
        batchId: state.id,
        candidatePath: normalizeSlashes(state.candidate),
      });
  }
  const head = candidateHead.stdout.trim();
  const reference = stagedRef(state.id);
  const updated = await runGit(['update-ref', reference, head], projectDir);
  if (!updated.ok) {
    return batchFailure('LAND_STAGE_REF_FAILED', 'Cannot persist the verified candidate reference', {
      batchId: state.id,
      candidatePath: normalizeSlashes(state.candidate),
    });
  }
  state.candidateHead = head;
  state.integration = state.integration ?? {
    schemaVersion: 1,
    kind: 'integration',
    target: state.target,
    before: state.baseHead,
    head,
    tasks: state.sources.map(({ id, branch, head: sourceHead }) => ({ id, branch, head: sourceHead })),
    tier: state.tier,
    verificationId: verification.verification.id,
    fingerprint: verification.verification.fingerprint,
    selectedChecks: verification.selectedChecks,
    passedChecks: Object.entries(verification.checks ?? {})
      .filter(([, check]) => ['passed', 'reused'].includes(check.status))
      .map(([id]) => id),
    deferredChecks: verification.deferredChecks?.map((check) => check.name ?? check.id) ?? [],
    completion: 'integration_only', // Optional checks do not imply CI has run or is pending.,
    conflicts: state.conflicts,
  };
  state.phase = 'staged';
  state.stagedRef = reference;
  state.commandStatus = 'passed';
  state.integrationStatus = 'local_staged';
  state.remoteValidation = 'not_required';
  state.localRefSync = 'not_attempted';
  // The staged ref is the delivery boundary. Candidate teardown is cleanup and
  // must not keep the repository FIFO occupied.
  await releaseDeliveryGate(args, state, file, 'completed');

  const candidateCleanup = [];
  // Keep the current environment for the native pre-push proof consumer.
  for (const candidate of state.previousCandidates ?? []) {
    if (!existsSync(candidate)) continue;
    const dirty = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], candidate);
    if (!dirty.ok || dirty.stdout.trim()) {
      candidateCleanup.push({
        removed: false,
        residual: normalizeSlashes(candidate),
        reason: 'candidate dirty or unreadable',
      });
      continue;
    }
    candidateCleanup.push(await cleanupLandCandidate(projectDir, candidate, { settings }));
  }
  state.candidateCleanup = candidateCleanup;
  saveBatchState(file, state);
  const pending = candidateCleanup.some((item) => !item.removed);
  return stagedStateReport(state, {
    candidateCleanup,
    ...(pending ? {
      code: 'LAND_STAGE_CLEANUP_INCOMPLETE',
      warnings: [{ code: 'LAND_STAGE_CLEANUP_PENDING', message: '本地候选已暂存；残留候选需单独清理。' }],
    } : {}),
  });
}
// Only a run that produced failing evidence indicts the candidate. Any other
// non-pass status (blocked, stale, snapshot drift, nothing executed) means the
// environment never delivered evidence, so the same candidate can be resumed
// without rebuilding it.
function verifyFailureClassification(verification) {
  const candidateFailed = verification.status === 'failed';
  const comparison = verification.verification?.snapshotComparison ?? null;
  const failureType = candidateFailed ? 'checks-failed'
    : comparison === 'changed' ? 'snapshot-drift'
    : comparison === 'unknown' ? 'snapshot-unknown'
    : verification.status === 'blocked' ? 'blocked'
    : verification.status === 'stale' ? 'stale'
    : 'not-run';
  return {
    code: candidateFailed ? 'LAND_VERIFY_FAILED' : 'LAND_VERIFY_ENVIRONMENT_FAILED',
    failureType,
    candidateFailed,
    at: new Date().toISOString(),
    status: verification.status ?? null,
    detail: verification.code ?? null,
  };
}
// Verification runs outside the repository FIFO. Only the owner releases its
// activity lease; a redundant candidate can stop cooperatively between checks.
async function runCandidateVerification(projectDir, state, args, verifyArgs) {
  const setup = await setupCandidateEnvironment(projectDir, state.candidate, 120000);
  if (!setup.ok) return { status: 'blocked', code: 'LAND_CANDIDATE_SETUP_FAILED', checks: {}, selectedChecks: [] };
  const changed = await runGit(['diff', '--name-only', '-z', '--no-renames',
    state.riskBaseHead ?? state.baseHead, 'HEAD', '--'], state.candidate);
  if (!changed.ok) return { status: 'blocked', code: 'LAND_RISK_SCOPE_UNAVAILABLE', checks: {}, selectedChecks: [] };
  const config = await readProjectConfig(state.candidate);
  const policy = deliveryRiskPolicy(changed.stdout.split('\0').filter(Boolean), {
    config, tier: state.tier, fullRisk: state.sources.some((source) => source.risk === 'full'),
  });
  state.risk = policy;
  state.tier = policy.selectedTier;
  verifyArgs = { ...verifyArgs, tier: policy.selectedTier };
  const lease = await acquireLandCandidateActivityLease(projectDir, state.id);
  if (!lease.held) {
    return {
      status: 'blocked',
      code: lease.code ?? 'LAND_CANDIDATE_LOCK_UNAVAILABLE',
      error: `candidate activity lease unavailable: ${lease.blockers?.[0] ?? 'lock is held'}`,
      checks: {},
      selectedChecks: [],
    };
  }
  try {
    // A committed candidate has no diff against its own HEAD. Bind affected
    // checks (and selection-scoped cache keys) to the frozen integration base.
    const verification = await verifyProject(state.candidate, { ...verifyArgs, base: state.baseHead,
      deliveryEvidence: true, riskPaths: changed.stdout.split('\0').filter(Boolean),
      fullRisk: state.sources.some((source) => source.risk === 'full'), onProgress: args.onProgress });
    const proofStarted = Date.now();
    state.pushProof = await createPushVerification(projectDir, state, verification);
    state.proofTimingsMs = { ...(state.proofTimingsMs ?? {}),
      inputFingerprint: verification.timingsMs?.inputFingerprint ?? null,
      create: Date.now() - proofStarted };
    return verification;
  } finally {
    lease.stopHeartbeat();
    releaseLease(lease.lockPath);
  }
}
async function worktreeBatchLandReport(projectDir, args) {
  if (!args.write) return worktreeBatchLandReportLocked(projectDir, args);
  const common = await gitCommonDir(projectDir);
  if (!common.ok) return batchFailure('LAND_BATCH_COMMON_DIR', common.error);
  let ids = args.task.map((item) => parseWorktreeTask(item).id);
  if (args.resume !== undefined) {
    try { ids = JSON.parse(readFileSync(batchStatePath(common.path, args.resume), 'utf8')).sources.map((item) => item.id); }
    catch { return batchFailure('LAND_BATCH_NOT_FOUND', 'Retained transaction is missing'); }
  }
  const locks = [];
  const heartbeats = [];
  try {
    for (const id of [...new Set(ids)].sort()) {
      const file = path.join(common.path, `vibe-harness-land-source-${createHash('sha256').update(id).digest('hex')}.lock`);
      const lease = await acquireLeaseWithRetry(file, { timeoutMs: landLockTimeoutMs(), retryMs: LAND_LOCK_RETRY_MS, leaseMs: DEFAULT_LEASE_MS });
      if (!lease.ok) return batchFailure('LAND_SOURCE_BUSY', 'A source task is already being integrated');
      locks.push(file);
      heartbeats.push(...startLeaseHeartbeats([file], DEFAULT_LEASE_MS));
    }
    // Stage owns no baseline-changed retry here: a resumed batch re-reads its
    // baseline inside the engine and rebuilds the candidate inline when the
    // local target advanced, so one pass through the engine is enough.
    return await worktreeBatchLandReportLocked(projectDir, args);
  } finally {
    for (const heartbeat of heartbeats) heartbeat.stop();
    for (const file of locks) releaseLease(file);
  }
}
async function worktreeBatchLandReportLocked(projectDir, args) {
  if (!args.batch || args.verify === false || args.targetMode === 'remote' || args.delivery && args.delivery !== 'local-land') {
    return batchFailure('LAND_BATCH_OPTIONS', 'Batch stage requires --batch, verification and local-land in primary target mode');
  }
  if (args.resume !== undefined && (!args.write || args.task.length > 0)) {
    return batchFailure('LAND_BATCH_RESUME_OPTIONS', '--resume requires --write and no --task');
  }
  if (args.resume === undefined && (!args.task.length || args.task.length > 32
    || new Set(args.task.map((item) => parseWorktreeTask(item).id)).size !== args.task.length)) {
    return batchFailure('LAND_BATCH_TASKS', 'Batch stage needs 1–32 distinct --task values');
  }
  const common = await gitCommonDir(projectDir);
  if (!common.ok) return batchFailure('LAND_BATCH_COMMON_DIR', common.error);
  if (!args.write) return worktreeBatchLandUnlocked(projectDir, args, common.path);
  if (args.resume === undefined) {
    const ids = args.task.map((item) => parseWorktreeTask(item).id).sort().join('\0');
    const retained = readdirSync(common.path).filter((name) => /^vibe-harness-land-batch-.*\.json$/u.test(name))
      .map((name) => { try { return JSON.parse(readFileSync(path.join(common.path, name), 'utf8')); } catch { return null; } })
      .filter((state) => state?.sources?.map((source) => source.id).sort().join('\0') === ids);
    if (retained.length > 1) return batchFailure('LAND_STATE_AMBIGUOUS', 'Multiple retained transactions match; select --resume explicitly');
    if (retained.length === 1) args = { ...args, resume: retained[0].id, task: [] };
    else return worktreeBatchLandUnlocked(projectDir, args, common.path);
  }
  // A resumed batch has a stable identity, so only another attempt to resume
  // that same batch is serialized. Different candidates build, verify and stage
  // concurrently; publish serializes only its seconds-scale finalize in the
  // repository FIFO.
  const lockPath = `${batchStatePath(common.path, args.resume)}.lock`;
  const lease = await acquireLeaseWithRetry(lockPath, {
    timeoutMs: landLockTimeoutMs(), retryMs: LAND_LOCK_RETRY_MS, leaseMs: DEFAULT_LEASE_MS,
  });
  if (!lease.ok) return batchFailure('LAND_BATCH_LOCK', 'Another agent is resuming this batch',
    { batchId: args.resume });
  const heartbeat = startLeaseHeartbeats([lockPath], DEFAULT_LEASE_MS)[0];
  try {
    return await worktreeBatchLandUnlocked(projectDir, args, common.path);
  } finally {
    heartbeat.stop();
    releaseLease(lockPath);
  }
}
async function worktreeBatchLandUnlocked(projectDir, args, commonDir) {
  const setupStartedAt = Date.now();
  const config = await readProjectConfig(projectDir);
  const delivery = resolveDelivery(config, args.delivery);
  if (delivery.merge !== 'no-ff') return batchFailure('LAND_BATCH_DELIVERY', 'Batch land requires no-ff delivery');
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return batchFailure('LAND_BATCH_SETTINGS', settings.error);
  const { entries, reason } = await worktreeEntries(projectDir);
  if (reason) return batchFailure('LAND_BATCH_WORKTREES', reason);
  const primary = entries.find((item) => item.primary);
  const stageOnly = Boolean(args.stageOnly);
  const target = args.baseRef ?? 'develop';
  if (!primary?.path || target !== 'develop' || isLandProtectedBranch(target)) {
    return batchFailure('LAND_BATCH_TARGET', 'Stage requires the develop integration target');
  }
  let pushTarget = null;
  if (args.resume === undefined) {
    // Local config only, no network: stage anchors the push endpoint so publish
    // can detect that the effective remote changed before finalize.
    pushTarget = await landPushTarget(projectDir, target);
    if (pushTarget.error) {
      pushTarget = { remote: 'origin', ref: 'refs/heads/develop', unavailable: true };
    }
  }
  let state;
  let file;
  if (args.resume !== undefined) {
    try {
      file = batchStatePath(commonDir, args.resume);
      state = JSON.parse(readFileSync(file, 'utf8'));
    } catch { return batchFailure('LAND_BATCH_NOT_FOUND', 'Batch state is missing or unreadable'); }
    if (![4, LAND_TRANSACTION_SCHEMA_VERSION].includes(state.schemaVersion) || state.id !== args.resume || !Array.isArray(state.sources)
      || state.sources.length === 0 || state.sources.length > 32
      || !Number.isInteger(state.next) || state.next < 0 || state.next > state.sources.length
      || state.target !== target || !/^\.vibe-harness-land-batch-[0-9a-f-]+$/iu.test(path.basename(state.candidate))
      || pathKey(path.dirname(state.candidate)) !== pathKey(path.dirname(settings.root))) {
      return batchFailure('LAND_BATCH_STATE_INVALID', 'Batch candidate or target changed; inspect the retained state');
    }
    if (!['queued', 'conflict', 'merging', 'merged', 'staged'].includes(state.phase)) {
      return batchFailure('LAND_STAGE_PHASE_INVALID',
        state.phase === 'archived_integrated'
          ? 'This transaction was archived after its frozen sources were proven integrated'
          : state.phase === 'recovery_required'
            ? 'A failed verification needs fixed sources and a new stage run'
            : `Phase ${String(state.phase)} belongs to the publish lifecycle; rerun worktree publish`,
        { batchId: state.id, archive: state.archive ?? null });
    }
    if (state.sources.some((source) => source.executionBatch) && !await batchSourcesStillValid(projectDir, state)) {
      return batchFailure('LAND_BATCH_SOURCE_CHANGED', 'Parent scope, plan or local completion changed after stage; retain this transaction and restage explicitly',
        { batchId: state.id });
    }
    if (state.phase === 'staged') {
      const reference = await runGit(['rev-parse', stagedRef(state.id)], projectDir);
      if (!reference.ok || reference.stdout.trim() !== state.candidateHead) {
        return batchFailure('LAND_STAGE_REF_INVALID',
          'The staged candidate reference is missing or no longer matches its transaction', {
            batchId: state.id,
            stagedRef: stagedRef(state.id),
          });
      }
      return stagedStateReport(state);
    }
    if (state.sources.some((source) => !entries.some((entry) => !entry.primary && !entry.detached
      && entry.branch === source.branch && pathKey(entry.path) === pathKey(source.path)))) {
      return batchFailure('LAND_BATCH_STATE_INVALID', 'A source worktree disappeared; inspect the retained state');
    }
    if (!await batchSourcesStillValid(projectDir, state)) {
      return batchFailure('LAND_BATCH_SOURCE_CHANGED', 'A source branch or worktree changed; inspect and restart the batch',
        { batchId: state.id, candidatePath: normalizeSlashes(state.candidate) });
    }
    // Stage tracks only the local integration target; publish owns the remote
    // baseline, so a resume never reads the network here.
    const sync = await localLandBaseline(projectDir, target);
    if (sync.error) return batchFailure('LAND_LOCAL_TARGET_UNAVAILABLE', sync.error);
    const anchor = await landPushTarget(projectDir, target);
    state.pushTarget = anchor.error ? { remote: 'origin', ref: 'refs/heads/develop', unavailable: true } : anchor;
    const currentTarget = { ok: true, stdout: sync.sha };
    if (currentTarget.stdout.trim() !== state.baseHead) {
      const rebased = await rebaseBatchCandidate(projectDir, state, file, settings, currentTarget);
      if (rebased) return rebased;
    }
    if (state.phase === 'conflict') {
      const resolved = await batchResumeConflict(projectDir, state, file);
      if (resolved) return resolved;
    }
  } else {
    const sources = [];
    const blockers = [];
    for (const raw of args.task) {
      const task = parseWorktreeTask(raw);
      const entry = entries.find((item) => !item.primary && !item.prunable && !item.detached
        && typeof item.branch === 'string'
        && (pathKey(item.path) === pathKey(task.path ?? path.join(settings.root, task.id))
          || task.branch !== null && task.branch === item.branch || path.basename(item.path) === task.id));
      if (!entry || entry.branch === target || sources.some((item) => item.branch === entry.branch || pathKey(item.path) === pathKey(entry.path))) {
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
          || evidence.members.some((id) => !evidence.localCompleted.includes(id))) {
          blockers.push(`Parent ${task.id} is not fully locally complete: ${evidence.reason ?? 'missing member evidence or multiple sources'}`);
        }
        executionBatch = {
          parentId: task.id, membershipDigest: evidence.membershipDigest,
          planDigest: anchorInfo.anchor.planDigest,
          members: anchorInfo.anchor.units.map(({ id, kind, localCompletion }) => ({
            id, kind, commit: localCompletion?.commit ?? null, commits: localCompletion?.commits ?? [], tree: localCompletion?.tree ?? null,
            verifiedCommit: localCompletion?.verifiedCommit ?? null,
            verificationId: localCompletion?.receipt?.verification?.id ?? null,
            checkDefinitionsDigest: localCompletion?.checkDefinitionsDigest ?? null,
          })),
        };
      }
      if (!head.ok || !dirty.ok || dirty.stdout.trim()) blockers.push(`task ${task.id} does not have a clean committed source`);
      // The candidate links dependency roots from the main checkout, so stage
      // gates on it alone; an adopted host worktree may keep its own roots.
      if (dependencyRootBlockers(projectDir, entry.path, settings, { locations: ['main checkout'] }).length) {
        blockers.push(`task ${task.id} has missing dependency roots`);
      }
      if (anchorInfo.exists && (anchorInfo.anchor?.blockers?.length
        || anchorInfo.anchor?.units?.some((unit) => unit.status !== 'done'))) blockers.push(`task ${task.id} has unfinished anchor units or blockers`);
      if (typeof anchorInfo.anchor?.planFile === 'string') {
        const plan = await taskPlanCheckReport(anchorInfo === sourceAnchor ? entry.path : projectDir, task.id);
        if (plan.status !== 'passed') blockers.push(`task ${task.id} plan check is ${plan.status}`);
      }
      if (head.ok) sources.push({ id: task.id, branch: entry.branch, path: entry.path,
        head: head.stdout.trim(), risk: anchorInfo.anchor?.riskLevel ?? null,
        ...(executionBatch ? { executionBatch } : {}) });
    }
    if (sources.length !== args.task.length || blockers.length) return batchFailure('LAND_BATCH_PREFLIGHT', blockers.join('; '));
    const changedPaths = new Set();
    for (const source of sources) {
      const changed = await runGit(['diff', '--name-only', `${target}...${source.head}`], projectDir);
      if (!changed.ok) return batchFailure('LAND_BATCH_DIFF_UNAVAILABLE', `Cannot classify changed paths for ${source.id}`);
      const paths = changed.stdout.trim().split(/\r?\n/u).filter(Boolean);
      for (const item of paths) changedPaths.add(item);
    }
    const risk = deliveryRiskPolicy([...changedPaths], {
      config, tier: args.tier === undefined ? null : parseVerifyTier(args.tier),
      fullRisk: sources.some((item) => item.risk === 'full'),
    });
    const tier = risk.selectedTier;
    if (risk.insufficientRequestedTier) return batchFailure('LAND_BATCH_RISK_TIER', 'High-risk task paths or anchors require at least standard verification', { risk });
    const configured = configuredChecks(config, projectDir);
    if (configured.error) return batchFailure('LAND_BATCH_CHECKS', configured.error);
    const selected = buildDeliveryVerificationPlan({ changedPaths: [...changedPaths], config, projectDir, tier,
      fullRisk: sources.some((item) => item.risk === 'full') });
    const reviewed = resolveReviewedChecks(args.reviewed, selected.selectedNames);
    // The batch produces an integration receipt; deferred checks are an honest
    // CI obligation, not grounds to silently promote quick to deep.
    const id = randomUUID();
    const candidate = path.join(path.dirname(settings.root), `.vibe-harness-land-batch-${id}`);
    if (!args.write) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'stage',
      status: 'planned', batch: true, targetBranch: target, tier, sources, selectedChecks: selected.selectedNames,
      warnings: reviewed.warnings.map((message) => ({ code: 'LAND_REVIEW_METADATA_IGNORED', message })),
      deferredCount: selected.deferredChecks.length, risk, write: false };
    // Stage never holds the repository FIFO: the baseline is a local snapshot
    // and verification runs outside any queue turn.
    const sync = await localLandBaseline(projectDir, target);
    if (sync.error) {
      return batchFailure('LAND_LOCAL_TARGET_UNAVAILABLE', sync.error);
    }
    if (pushTarget) pushTarget.baseHead = sync.sha;
    state = { schemaVersion: LAND_TRANSACTION_SCHEMA_VERSION, id, target, baseHead: sync.sha, riskBaseHead: sync.sha, risk, sources, tier,
      selectedChecks: selected.selectedNames, reviewed: reviewed.ids, reviewWarnings: reviewed.warnings,
      candidate, next: 0, resolved: 0, conflicts: [], phase: 'merging',
      startedAt: new Date().toISOString(), single: Boolean(args.single), push: false,
      stageOnly: Boolean(args.stageOnly), pushTarget,
      queue: null,
      commandStatus: 'planned', integrationStatus: 'not_integrated',
      remoteValidation: 'not_required', localRefSync: 'not_attempted' };
    file = batchStatePath(commonDir, id);
    saveBatchState(file, state);
    const candidateError = await prepareBatchCandidate(projectDir, state, settings);
    if (candidateError) return batchFailure('LAND_BATCH_CANDIDATE_SETUP', candidateError, { batchId: id, candidatePath: normalizeSlashes(candidate) });
    saveBatchState(file, state);
  }
  const mergeStartedAt = Date.now();
  const mergeResult = await batchMergeNext(projectDir, state, file);
  if (mergeResult) return mergeResult;
  const clean = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], state.candidate);
  if (!clean.ok || clean.stdout.trim()) return batchFailure('LAND_BATCH_CANDIDATE_DIRTY',
    'Candidate contains uncommitted changes; inspect before verification', { batchId: state.id, candidatePath: normalizeSlashes(state.candidate) });
  const candidateHead = await runGit(['rev-parse', 'HEAD'], state.candidate);
  const mergeMs = Date.now() - mergeStartedAt;
  const verifyStartedAt = Date.now();
  const verification = await runCandidateVerification(projectDir, state, args, {
    tier: state.tier,
    task: [],
    only: null,
    reuse: true,
    allowManual: false,
    reviewed: state.reviewed,
    reviewPolicy: delivery.reviewPolicy,
    targetBranch: target,
  });
  const timingsMs = { setupMs: mergeStartedAt - setupStartedAt, mergeMs, verifyMs: Date.now() - verifyStartedAt,
    checks: Object.entries(verification.checks ?? {}).map(([id, check]) => ({
      id, status: check?.status ?? null, durationMs: check?.durationMs ?? null,
    })),
    conflictCount: state.conflicts.length, resolvedCount: state.resolved,
    conflictResolutionMs: state.conflicts.reduce((total, item) => total + (item.resolutionMs ?? 0), 0),
    baselineReplayCount: state.replayCount ?? 0,
    totalMs: Date.now() - Date.parse(state.startedAt) };
  if (!PASS_STATUSES.includes(verification.status) || verification.selectedChecks?.length === 0
    || verification.verification?.snapshotComparison !== 'match') {
    const failure = verifyFailureClassification(verification);
    state.phase = failure.candidateFailed ? 'recovery_required' : state.phase;
    state.commandStatus = 'failed';
    state.verifyFailure = failure;
    state.verification = {
      status: verification.status ?? null,
      code: verification.code ?? null,
      verificationId: verification.verification?.id ?? null,
      failedAt: failure.at,
    };
    saveBatchState(file, state);
    return batchFailure(failure.code,
      failure.candidateFailed
        ? 'Final candidate verification failed; fix the sources and start a new stage run'
        : 'Verification produced no evidence (blocked, stale or not run); rerun worktree stage --resume to verify the same candidate',
      { batchId: state.id, candidatePath: normalizeSlashes(state.candidate), verification, timingsMs,
        failureType: failure.failureType });
  }
  const verifiedHead = await runGit(['rev-parse', 'HEAD'], state.candidate);
  if (!verifiedHead.ok) {
    return batchFailure('LAND_BATCH_CANDIDATE_HEAD_UNRESOLVED', 'Cannot resolve verified candidate HEAD', {
      batchId: state.id,
      candidatePath: normalizeSlashes(state.candidate),
    });
  }
  const receipt = {
    schemaVersion: 1,
    kind: 'integration',
    target,
    before: state.baseHead,
    head: verifiedHead.stdout.trim(),
    tasks: state.sources.map(({ id, branch, head }) => ({ id, branch, head })),
    tier: state.tier,
    verificationId: verification.verification.id,
    fingerprint: verification.verification.fingerprint,
    selectedChecks: verification.selectedChecks,
    passedChecks: Object.entries(verification.checks ?? {})
      .filter(([, check]) => ['passed', 'reused'].includes(check.status)).map(([id]) => id),
    deferredChecks: verification.deferredChecks?.map((check) => check.name ?? check.id) ?? [],
    completion: 'integration_only', // Optional checks do not imply CI has run or is pending.,
    conflicts: state.conflicts,
  };
  state.integration = receipt;
  state.verifiedFingerprint = verification.verification.fingerprint;
  state.verifiedWriteFingerprint = verification.verification.writeFingerprint;
  return stageBatchCandidate(projectDir, state, file, settings, verification, args);
}

function transactionFailure(subcommand, code, error, extra = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand,
    status: 'blocked',
    commandStatus: 'blocked',
    integrationStatus: 'not_integrated',
    remoteValidation: 'not_required',
    localRefSync: 'not_attempted',
    code,
    error,
    ...extra,
  };
}
async function readLandTransaction(projectDir, batchId) {
  if (!batchId || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(batchId)) {
    return { error: transactionFailure('status', 'WORKTREE_BATCH_ID_INVALID', 'A valid --batch id is required') };
  }
  const common = await gitCommonDir(projectDir);
  if (!common.ok) return { error: transactionFailure('status', 'LAND_BATCH_COMMON_DIR', common.error) };
  let file;
  let state;
  try {
    file = batchStatePath(common.path, batchId);
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { error: transactionFailure('status', 'LAND_BATCH_NOT_FOUND', 'Batch state is missing or unreadable') };
  }
  const shaPattern = /^[0-9a-f]{40,64}$/iu;
  const validSources = Array.isArray(state.sources) && state.sources.length > 0
    && state.sources.length <= 32 && state.sources.every((source) => source
      && typeof source.id === 'string' && source.id !== ''
      && typeof source.branch === 'string' && source.branch !== ''
      && typeof source.path === 'string' && source.path !== ''
      && typeof source.head === 'string' && shaPattern.test(source.head));
  if (state.id !== batchId || ![1, 2, 3, 4, LAND_TRANSACTION_SCHEMA_VERSION].includes(state.schemaVersion)
    || state.target !== 'develop' || typeof state.baseHead !== 'string' || !shaPattern.test(state.baseHead)
    || !validSources || typeof state.candidate !== 'string'
    || !/^\.vibe-harness-land-batch-[0-9a-f-]+$/iu.test(path.basename(state.candidate))
    || state.candidateHead !== undefined && (typeof state.candidateHead !== 'string'
      || !shaPattern.test(state.candidateHead))
    || state.remoteConfirmedHead !== undefined && state.remoteConfirmedHead !== null
      && (typeof state.remoteConfirmedHead !== 'string' || !shaPattern.test(state.remoteConfirmedHead))) {
    return { error: transactionFailure('status', 'LAND_BATCH_STATE_INVALID',
      'Batch state identity or contract is invalid', { batchId }) };
  }
  return { commonDir: common.path, file, state };
}
function transactionCandidateMatchesSettings(state, settings) {
  return pathKey(path.dirname(state.candidate)) === pathKey(path.dirname(settings.root));
}
async function worktreeStageReport(projectDir, args) {
  if (args.push) return transactionFailure('stage', 'LAND_STAGE_PUSH_INVALID',
    'stage never publishes; pass --push to publish instead');
  const result = await worktreeBatchLandReport(projectDir, {
    ...args,
    _: ['worktree', 'stage'],
    batch: true,
    stageOnly: true,
    progressCommand: 'worktree stage',
    delivery: args.delivery ?? 'local-land',
  });
  return {
    ...result,
    subcommand: 'stage',
    commandStatus: result.status === 'passed' ? 'passed'
      : result.status === 'planned' ? 'planned' : result.commandStatus ?? result.status,
    integrationStatus: result.status === 'passed' ? 'local_staged'
      : result.integrationStatus ?? 'not_integrated',
    localRefSync: result.localRefSync ?? 'not_attempted',
    remoteValidation: result.remoteValidation ?? 'not_required',
  };
}
async function fetchRemoteBaseline(projectDir, state, endpoint) {
  const snapshot = remoteSnapshotRef(state.id);
  const fetched = await runGit(['fetch', '--no-tags', '--', endpoint.url,
    `${endpoint.ref}:${snapshot}`], projectDir);
  if (!fetched.ok) {
    return { error: 'Cannot fetch the exact remote target for the staged transaction' };
  }
  const head = await runGit(['rev-parse', snapshot], projectDir);
  return head.ok && /^[0-9a-f]{40,64}$/iu.test(head.stdout.trim())
    ? { sha: head.stdout.trim(), snapshot }
    : { error: 'Cannot resolve the fetched remote target' };
}
function publishReceipt(state, verification, head) {
  return {
    schemaVersion: 1,
    kind: 'integration',
    target: state.target,
    before: state.baseHead,
    head,
    tasks: state.sources.map(({ id, branch, head: sourceHead, executionBatch }) => ({
      id, branch, head: sourceHead, ...(executionBatch ? { executionBatch } : {}),
    })),
    tier: state.tier,
    verificationId: verification.verification.id,
    fingerprint: verification.verification.fingerprint,
    selectedChecks: verification.selectedChecks,
    passedChecks: Object.entries(verification.checks ?? {})
      .filter(([, check]) => ['passed', 'reused'].includes(check.status)).map(([id]) => id),
    deferredChecks: verification.deferredChecks?.map((check) => check.name ?? check.id) ?? [],
    completion: 'integration_only', // Optional checks do not imply CI has run or is pending.,
    conflicts: state.conflicts ?? [],
  };
}
async function remoteContainsCandidate(projectDir, state, endpoint, remoteHead) {
  const fetched = await fetchRemoteBaseline(projectDir, state, endpoint);
  if (fetched.error) return fetched;
  if (fetched.sha !== remoteHead) {
    return { error: 'The exact remote target changed while its candidate ancestry was checked' };
  }
  const contained = await runGit([
    'merge-base', '--is-ancestor', state.candidateHead, fetched.sha,
  ], projectDir);
  return contained.ok
    ? { contained: true, remoteHead: fetched.sha }
    : { contained: false, remoteHead: fetched.sha };
}
async function inspectRemoteIntegration(projectDir, state, endpoint, remoteHead) {
  const fetched = await fetchRemoteBaseline(projectDir, state, endpoint);
  if (fetched.error) return fetched;
  if (fetched.sha !== remoteHead) {
    return { error: 'The exact remote target changed while integration ancestry was checked' };
  }
  const candidateContained = typeof state.candidateHead === 'string'
    && (await runGit(['merge-base', '--is-ancestor', state.candidateHead, fetched.sha], projectDir)).ok;
  const integratedSourceHeads = [];
  const missingSourceHeads = [];
  for (const source of state.sources) {
    const contained = await runGit(['merge-base', '--is-ancestor', source.head, fetched.sha], projectDir);
    const item = { id: source.id, branch: source.branch, head: source.head };
    (contained.ok ? integratedSourceHeads : missingSourceHeads).push(item);
  }
  return {
    ok: true,
    remoteHead: fetched.sha,
    candidateContained,
    sourcesIntegrated: missingSourceHeads.length === 0,
    integratedSourceHeads,
    missingSourceHeads,
  };
}
function recordReconcile(state, { kind, remoteHead, toCandidateHead = null }) {
  const entry = {
    at: new Date().toISOString(),
    kind,
    fromPhase: state.phase,
    remoteHead,
    fromCandidateHead: state.candidateHead ?? null,
    toCandidateHead,
  };
  state.reconcileHistory = [...(state.reconcileHistory ?? []), entry];
  return entry;
}
function copyVerificationReceipts(fromCandidate, toCandidate) {
  try {
    const source = path.join(fromCandidate, '.vibe-harness', 'verification', 'receipts');
    if (!existsSync(source)) return false;
    cpSync(source, path.join(toCandidate, '.vibe-harness', 'verification', 'receipts'), {
      recursive: true,
    });
    return true;
  } catch {
    // A missing or unreadable receipt store only costs cache reuse.
    return false;
  }
}
async function rebuildPublishedCandidate(projectDir, state, file, settings, delivery, remoteHead, args) {
  if (!await batchSourcesStillValid(projectDir, state)) {
    return transactionFailure('publish', 'LAND_BATCH_SOURCE_CHANGED',
      'A source branch or worktree changed after stage; discard or restage explicitly', {
        batchId: state.id,
      });
  }
  const oldCandidate = existsSync(state.candidate) ? state.candidate : null;
  const resumeCandidate = oldCandidate && state.phase === 'merging'
    && state.baseHead === remoteHead && state.next === state.sources.length
    && state.verifyFailure?.candidateFailed === false && state.verification?.candidateHead;
  if (resumeCandidate) {
    const [head, dirty] = await Promise.all([
      runGit(['rev-parse', 'HEAD'], oldCandidate),
      runGit(['status', '--porcelain=v1', '--untracked-files=all'], oldCandidate),
    ]);
    if (!head.ok || head.stdout.trim() !== state.verification.candidateHead || !dirty.ok || dirty.stdout.trim()) {
      return transactionFailure('publish', 'LAND_SNAPSHOT_CHANGED',
        'The retained candidate changed after interrupted verification; inspect it before retrying', { batchId: state.id });
    }
  }
  const candidate = resumeCandidate ? oldCandidate
    : path.join(path.dirname(settings.root), `.vibe-harness-land-batch-${randomUUID()}`);
  const next = {
    ...state,
    baseHead: remoteHead,
    candidate,
    next: resumeCandidate ? state.next : 0,
    resolved: resumeCandidate ? state.resolved : 0,
    conflicts: resumeCandidate ? state.conflicts : [],
    phase: 'merging',
    previousCandidates: [...(state.previousCandidates ?? []), ...(oldCandidate && !resumeCandidate ? [oldCandidate] : [])],
    replayCount: (state.replayCount ?? 0) + (resumeCandidate ? 0 : 1),
  };
  // Persist candidate identity before provisioning, including partial failure.
  Object.assign(state, next);
  saveBatchState(file, state);
  const prepared = resumeCandidate ? null : await prepareBatchCandidate(projectDir, next, settings);
  if (prepared) {
    return transactionFailure('publish', 'LAND_BATCH_REBUILD_SETUP_FAILED', prepared, {
      batchId: state.id,
      candidatePath: normalizeSlashes(candidate),
    });
  }
  // Preserve available receipts as an optimization. Cross-tree reuse still
  // requires explicitly deterministic checks and matching whole-tree inputs;
  // a changed tree must be verified again.
  if (oldCandidate && !resumeCandidate) copyVerificationReceipts(oldCandidate, candidate);
  Object.assign(state, next);
  saveBatchState(file, state);
  const merged = await batchMergeNext(projectDir, state, file);
  if (merged) return merged;
  const verification = await runCandidateVerification(projectDir, state, args, {
    tier: state.tier,
    task: [],
    only: null,
    reuse: true,
    allowManual: false,
    reviewed: state.reviewed,
    reviewPolicy: delivery.reviewPolicy,
    targetBranch: state.target,
  });
  const head = await runGit(['rev-parse', 'HEAD'], state.candidate);
  if (!PASS_STATUSES.includes(verification.status) || verification.selectedChecks?.length === 0
    || verification.verification?.snapshotComparison !== 'match' || !head.ok) {
    const failure = verifyFailureClassification(verification);
    state.phase = failure.candidateFailed ? 'recovery_required' : 'merging';
    state.commandStatus = 'failed';
    state.verifyFailure = failure;
    state.verification = {
      status: verification.status ?? null,
      code: verification.code ?? null,
      verificationId: verification.verification?.id ?? null,
      candidateHead: head.ok ? head.stdout.trim() : null,
      failedAt: failure.at,
    };
    saveBatchState(file, state);
    return transactionFailure('publish', failure.code,
      failure.candidateFailed
        ? 'The rebuilt candidate failed verification; fix the sources and start a new stage run'
        : 'The rebuild verification produced no evidence (blocked, stale or not run); rerun worktree publish',
      {
        batchId: state.id,
        candidatePath: normalizeSlashes(state.candidate),
        verification,
        failureType: failure.failureType,
      });
  }
  state.candidateHead = head.stdout.trim();
  state.integration = publishReceipt(state, verification, state.candidateHead);
  state.verifiedFingerprint = verification.verification.fingerprint;
  state.verifiedWriteFingerprint = verification.verification.writeFingerprint;
  state.phase = 'staged';
  state.stagedRef = stagedRef(state.id);
  state.remoteBaseHead = remoteHead;
  state.commandStatus = 'passed';
  state.integrationStatus = 'local_staged';
  state.remoteValidation = 'not_required';
  const updated = await runGit(['update-ref', state.stagedRef, state.candidateHead], projectDir);
  if (!updated.ok) {
    return transactionFailure('publish', 'LAND_STAGE_REF_FAILED',
      'Cannot update the verified staged candidate reference', { batchId: state.id });
  }
  const pendingRebuild = state.reconcileHistory?.findLast((entry) => entry.kind === 'rebuilt'
    && entry.toCandidateHead === null);
  if (pendingRebuild) pendingRebuild.toCandidateHead = state.candidateHead;
  saveBatchState(file, state);
  return { state };
}
async function syncLocalTargetAfterPublish(projectDir, primary, state, publishedHead) {
  const checkout = await inspectPrimaryCheckout(primary);
  if (checkout.branch !== state.target) {
    return {
      status: 'deferred',
      reason: `Primary checkout is on ${checkout.branch ?? 'detached HEAD'}, not ${state.target}`,
      primaryCheckout: checkout,
    };
  }
  if (checkout.dirty) {
    return {
      status: 'deferred',
      reason: 'Primary checkout has user changes; the verified local ref was not modified',
      primaryCheckout: checkout,
    };
  }
  const current = await runGit(['rev-parse', `refs/heads/${state.target}`], primary.path);
  if (!current.ok) {
    return { status: 'deferred', reason: 'Cannot resolve the local target ref', primaryCheckout: checkout };
  }
  const currentHead = current.stdout.trim();
  if (currentHead === publishedHead) {
    return { status: 'updated', head: currentHead, primaryCheckout: checkout };
  }
  if ((await runGit(['merge-base', '--is-ancestor', publishedHead, currentHead], primary.path)).ok) {
    return {
      status: 'diverged',
      head: currentHead,
      reason: 'Local target contains commits beyond the published candidate',
      primaryCheckout: checkout,
    };
  }
  const updated = await runIsolatedGit(projectDir, ['merge', '--ff-only', publishedHead], primary.path);
  if (!updated.ok) {
    return {
      status: 'diverged',
      head: currentHead,
      reason: 'Local target contains unrelated commits or cannot fast-forward to the published candidate',
      primaryCheckout: checkout,
    };
  }
  const after = await runGit(['rev-parse', 'HEAD'], primary.path);
  return { status: 'updated', head: after.ok ? after.stdout.trim() : publishedHead, primaryCheckout: checkout };
}
async function deleteTransactionRefs(projectDir, state) {
  for (const reference of [stagedRef(state.id), remoteSnapshotRef(state.id)]) {
    await runGit(['update-ref', '-d', reference], projectDir);
  }
}
async function cleanupConfirmedPublish(projectDir, primary, settings, state, file, args) {
  if (state.phase === 'cleaned') {
    await deleteTransactionRefs(projectDir, state);
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree',
    subcommand: 'publish', status: 'passed', integrationStatus: 'integrated', batchId: state.id,
    cleaned: true, alreadyCleaned: true, pushed: false, pushConfirmed: true, cleanup: state.cleanup ?? [] };
  }
  const publishedHead = state.remoteConfirmedHead ?? state.candidateHead;
  const localRefSync = await syncLocalTargetAfterPublish(projectDir, primary, state, publishedHead);
  state.localRefSync = localRefSync.status;
  // Publish confirmation and the safe local ff-only attempt are inside the
  // same turn. Cleanup of source/candidate residue happens after release.
  await releaseDeliveryGate(args, state, file, 'completed');
  const cleaned = await cleanupLand(projectDir, primary, settings, state, file, {
    deferParentSources: args?._?.[1] !== 'cleanup',
  });
  // Keep the staged candidate discoverable until the transaction is fully
  // closed. A cleanup-pending transaction still needs status/recovery evidence.
  if (cleaned.integrationStatus === 'integrated') await deleteTransactionRefs(projectDir, state);
  // Baseline advancement alone does not supersede independent work.
  const supersededCandidates = await cancelSupersededCandidates(projectDir, {
    publishedHead,
    batchId: state.id,
    pushTarget: state.pushTarget,
  });
  return {
    ...cleaned,
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'publish',
    status: 'passed',
    commandStatus: 'passed',
    integrationStatus: cleaned.integrationStatus,
    remoteValidation: 'not_required',
    localRefSync: localRefSync.status,
    batchId: state.id,
    stagedRef: stagedRef(state.id),
    candidateHead: state.candidateHead,
    targetAfter: publishedHead,
    remoteHead: publishedHead,
    remoteAdvanced: publishedHead !== state.candidateHead,
    pushed: true,
    pushConfirmed: true,
    localSync: localRefSync,
    reconcileHistory: state.reconcileHistory ?? [],
    supersededCandidates,
    queue: args?._deliveryGate?.report('completed') ?? null,
  };
}
// Only frozen sources already integrated at the same endpoint make a live
// candidate redundant. Never kill its owner (which may host other work), or
// release a live lease before the owner has actually stopped.
async function cancelSupersededCandidates(projectDir, { publishedHead, batchId, pushTarget }) {
  const common = await gitCommonDir(projectDir);
  if (!common.ok || !pushTarget?.fingerprint) return [];
  const { entries, reason } = await worktreeEntries(projectDir);
  if (reason) return [];
  const results = [];
  for (const name of readdirSync(common.path)) {
    const match = /^vibe-harness-land-candidate-([0-9a-f]{8}-[0-9a-f-]{27,})\.lock$/iu.exec(name);
    if (!match || match[1] === batchId) continue;
    const lockPath = path.join(common.path, name);
    const lease = readLease(lockPath);
    if (!lease.record || !lease.alive) continue;
    let state = null;
    try {
      state = JSON.parse(readFileSync(
        path.join(common.path, `vibe-harness-land-batch-${match[1]}.json`), 'utf8'));
    } catch {
      state = null;
    }
    if (state?.id !== match[1]
      || state.pushTarget?.fingerprint !== pushTarget.fingerprint
      || state.pushTarget?.ref !== pushTarget.ref
      || !Array.isArray(state.sources) || state.sources.length === 0
      || !state.sources.every((source) => /^[0-9a-f]{40,64}$/iu.test(source?.head))
      || typeof state.candidate !== 'string'
      || !entries.some((entry) => entry.detached && pathKey(entry.path) === pathKey(state.candidate))) continue;
    const contained = await Promise.all(state.sources.map((source) =>
      runGit(['merge-base', '--is-ancestor', source.head, publishedHead], projectDir)));
    if (!contained.every((result) => result.ok)) continue;
    // The owner may have finished while ancestry was being checked.
    const currentLease = readLease(lockPath);
    if (!currentLease.alive || currentLease.pid !== lease.pid
      || currentLease.record?.startedAt !== lease.record.startedAt) continue;
    if (existsSync(state.candidate)) {
      try {
        const cancelDir = path.join(state.candidate, '.vibe-harness', 'verification');
        mkdirSync(cancelDir, { recursive: true });
        writeFileSync(path.join(cancelDir, 'CANCEL'), `${JSON.stringify({
          reason: 'superseded',
          publishedHead,
          publishedBy: batchId,
          at: new Date().toISOString(),
        })}\n`);
      } catch {
        // Failure to request cancellation only costs redundant verification.
        continue;
      }
      results.push({ batchId: match[1], pid: lease.pid, action: 'cancel-requested' });
    }
  }
  return results;
}
// Every frozen source head already lives in the remote target, so the
// transaction is done without this candidate ever publishing: archive it for
// audit, reclaim the candidate residue, and cancel superseded verification.
async function archiveIntegratedTransaction(projectDir, state, file, settings, {
  reason,
  remoteHead,
  integratedSourceHeads,
}) {
  recordReconcile(state, { kind: 'archived-integrated', remoteHead, toCandidateHead: null });
  state.phase = 'archived_integrated';
  state.push = true;
  state.pushConfirmed = true;
  state.integrationStatus = 'integrated';
  state.remoteValidation = 'not_required';
  state.remoteConfirmedHead = remoteHead;
  state.commandStatus = 'passed';
  state.archive = {
    at: new Date().toISOString(),
    reason,
    remoteHead,
    integratedSourceHeads: integratedSourceHeads ?? state.sources.map((source) => source.head),
  };
  saveBatchState(file, state);
  const { entries } = await worktreeEntries(projectDir);
  const primary = entries.find((entry) => entry.primary);
  const cleaned = await cleanupLand(projectDir, primary, settings, state, file, { deferParentSources: true });
  const candidateCleanup = cleaned.candidateCleanup;
  if (cleaned.integrationStatus === 'integrated') await deleteTransactionRefs(projectDir, state);
  const supersededCandidates = await cancelSupersededCandidates(projectDir, {
    publishedHead: remoteHead,
    batchId: state.id,
    pushTarget: state.pushTarget,
  });
  // The state file is intentionally retained: an archived transaction is the
  // audit record that its frozen sources were proven integrated.
  return {
    status: 'archived',
    report: {
      schemaVersion: SCHEMA_VERSION,
      command: 'worktree',
      subcommand: 'publish',
      status: 'passed',
      commandStatus: 'passed',
      integrationStatus: cleaned.integrationStatus,
      remoteValidation: 'not_required',
      localRefSync: state.localRefSync ?? 'not_attempted',
      batchId: state.id,
      archived: true,
      archive: state.archive,
      reconcileHistory: state.reconcileHistory ?? [],
      candidateCleanup,
      cleanup: cleaned.cleanup,
      supersededCandidates,
      queue: state.queue ?? null,
    },
  };
}
async function worktreeBatchCleanupReport(projectDir, args) {
  const loaded = await readLandTransaction(projectDir, args.batch);
  if (loaded.error) return { ...loaded.error, subcommand: 'cleanup' };
  const { state, file } = loaded;
  if (!state.pushConfirmed) return transactionFailure('cleanup', 'LAND_CLEANUP_UNCONFIRMED',
    'Cleanup requires confirmed remote integration', { batchId: state.id });
  if (!args.write) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'cleanup',
    status: 'planned', batchId: state.id, integrationStatus: state.integrationStatus, phase: state.phase, write: false };
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error || !transactionCandidateMatchesSettings(state, settings)) {
    return transactionFailure('cleanup', 'LAND_BATCH_STATE_INVALID', settings.error ?? 'Candidate identity changed');
  }
  const acquired = await acquireLeaseWithRetry(`${file}.lock`, { timeoutMs: landLockTimeoutMs(), retryMs: 50 });
  if (!acquired.ok) return transactionFailure('cleanup', 'LAND_BATCH_LOCK', 'Another operation owns this batch');
  const heartbeat = startLeaseHeartbeats([`${file}.lock`], DEFAULT_LEASE_MS)[0];
  try {
    const current = await readLandTransaction(projectDir, args.batch);
    if (current.error || !current.state.pushConfirmed) return transactionFailure('cleanup', 'LAND_CLEANUP_UNCONFIRMED', 'Integration changed');
    const { entries } = await worktreeEntries(projectDir);
    const primary = entries.find((entry) => entry.primary);
    const report = await cleanupConfirmedPublish(projectDir, primary, settings, current.state, file, args);
    return { ...report, subcommand: 'cleanup', pushed: false };
  } finally { heartbeat.stop(); releaseLease(`${file}.lock`); }
}
// Auto-reconciliation, outside the repository FIFO: prove what the exact
// remote target already contains before spending a finalize turn on it. A
// candidate already on the remote, a baseline that moved, sources integrated
// by someone else — every divergence is classified and resolved here.
async function reconcilePublishedBaseline(projectDir, settings, delivery, state, file, endpoint, args) {
  const staged = await runGit(['rev-parse', stagedRef(state.id)], projectDir);
  if (!staged.ok || staged.stdout.trim() !== state.candidateHead) {
    return transactionFailure('publish', 'LAND_STAGE_REQUIRED',
      'This transaction has no verified staged candidate; complete worktree stage first', { batchId: state.id });
  }
  const remote = await exactRemoteHead(projectDir, endpoint);
  if (!remote.ok) {
    return transactionFailure('publish', 'LAND_PUSH_UNCONFIRMED',
      'Cannot confirm the exact remote target; the next publish run reconciles it', { batchId: state.id });
  }
  if (remote.sha === state.candidateHead) {
    recordReconcile(state, { kind: 'integrated', remoteHead: remote.sha, toCandidateHead: state.candidateHead });
    state.phase = 'push_confirmed';
    state.push = true;
    state.pushConfirmed = true;
    state.integrationStatus = 'integrated';
    state.remoteValidation = 'not_required';
    state.remoteConfirmedHead = state.candidateHead;
    saveBatchState(file, state);
    return { status: 'confirmed' };
  }
  // A rebuild that crashed mid-way (phase 'merging' with a live staged ref)
  // skips the shortcuts: its recorded baseline is stale by definition.
  if (state.phase !== 'merging') {
    if (remote.sha === state.baseHead) return { status: 'current' };
    const integration = await inspectRemoteIntegration(projectDir, state, endpoint, remote.sha);
    if (integration.error) {
      return transactionFailure('publish', 'LAND_PUSH_UNCONFIRMED',
        'Cannot prove whether the remote contains the candidate or its sources; retry publish',
        { batchId: state.id, remoteHead: remote.sha });
    }
    if (integration.candidateContained) {
      recordReconcile(state, { kind: 'integrated', remoteHead: remote.sha, toCandidateHead: state.candidateHead });
      state.phase = 'push_confirmed';
      state.push = true;
      state.pushConfirmed = true;
      state.integrationStatus = 'integrated';
      state.remoteValidation = 'not_required';
      state.remoteConfirmedHead = remote.sha;
      saveBatchState(file, state);
      return { status: 'confirmed' };
    }
    if (integration.sourcesIntegrated) {
      return await archiveIntegratedTransaction(projectDir, state, file, settings, {
        reason: 'sources-integrated',
        remoteHead: remote.sha,
        integratedSourceHeads: integration.integratedSourceHeads,
      });
    }
    if (!await batchSourcesStillValid(projectDir, state)) {
      return transactionFailure('publish', 'LAND_BATCH_SOURCE_CHANGED',
        'A source branch or worktree changed after stage; discard or restage explicitly', { batchId: state.id });
    }
    recordReconcile(state, { kind: 'rebuilt', remoteHead: remote.sha });
    state.phase = 'merging';
    state.push = false;
    state.pushConfirmed = false;
    state.integrationStatus = 'local_staged';
    state.remoteConfirmedHead = null;
    saveBatchState(file, state);
  }
  const fetched = await fetchRemoteBaseline(projectDir, state, endpoint);
  if (fetched.error) {
    return transactionFailure('publish', 'LAND_REMOTE_FETCH_FAILED', fetched.error, { batchId: state.id });
  }
  const rebuilt = await rebuildPublishedCandidate(projectDir, state, file, settings, delivery, fetched.sha, args);
  if (rebuilt.error) return rebuilt;
  return { status: 'rebuilt', remoteHead: fetched.sha };
}
async function worktreePublishReport(projectDir, args) {
  if (!args.write) return transactionFailure('publish', 'LAND_WRITE_REQUIRED', 'publish requires --write');
  if (!args.batch) return transactionFailure('publish', 'LAND_BATCH_ID_REQUIRED', 'publish requires --batch <batch-id>');
  const loaded = await readLandTransaction(projectDir, args.batch);
  if (loaded.error) return { ...loaded.error, subcommand: 'publish' };
  const { file } = loaded;
  let { state } = loaded;
  const config = await readProjectConfig(projectDir);
  const delivery = resolveDelivery(config, args.delivery ?? 'local-land');
  if (delivery.merge !== 'no-ff') {
    return transactionFailure('publish', 'LAND_PUBLISH_DELIVERY', 'publish requires the local-land no-ff profile');
  }
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return transactionFailure('publish', 'LAND_SETTINGS', settings.error);
  if (!transactionCandidateMatchesSettings(state, settings)) {
    return transactionFailure('publish', 'LAND_BATCH_STATE_INVALID',
      'The transaction candidate path is outside the configured worktree root', { batchId: state.id });
  }
  const { entries, reason } = await worktreeEntries(projectDir);
  if (reason) return transactionFailure('publish', 'LAND_BATCH_WORKTREES', reason);
  const primary = entries.find((entry) => entry.primary);
  if (!primary?.path) return transactionFailure('publish', 'LAND_BATCH_TARGET', 'No primary checkout found');
  if (!(state.pushConfirmed === true || ['staged', 'publishing', 'push_uncertain', 'merging'].includes(state.phase))
    || state.stageOnly !== true) {
    return transactionFailure('publish', 'LAND_STAGE_REQUIRED',
      'This transaction is not a staged local candidate; create it with worktree stage', {
        batchId: state.id,
      });
  }
  const lockFile = `${file}.lock`;
  const batchLease = await acquireLeaseWithRetry(lockFile, {
    timeoutMs: landLockTimeoutMs(),
    retryMs: LAND_LOCK_RETRY_MS,
    leaseMs: DEFAULT_LEASE_MS,
  });
  if (!batchLease.ok) return transactionFailure('publish', 'LAND_BATCH_LOCK', 'Another operation owns this batch');
  const batchHeartbeat = startLeaseHeartbeats([lockFile], DEFAULT_LEASE_MS)[0];
  try {
    // Re-read the transaction only after the batch lease is held so recovery
    // decisions always use the latest persisted phase and remote evidence
    // fields. The repository FIFO turn is taken later, for the finalize
    // section only, so no queue time is paid before this point.
    const current = await readLandTransaction(projectDir, args.batch);
    if (current.error) return { ...current.error, subcommand: 'publish' };
    state = current.state;
    if (!(state.pushConfirmed === true || ['staged', 'publishing', 'push_uncertain', 'merging'].includes(state.phase))
      || state.stageOnly !== true) {
      return transactionFailure('publish', 'LAND_STAGE_REQUIRED',
        'This transaction is not a staged local candidate; create it with worktree stage', {
          batchId: state.id,
        });
    }
    if (!transactionCandidateMatchesSettings(state, settings)) {
      return transactionFailure('publish', 'LAND_BATCH_STATE_INVALID',
        'The transaction candidate path is outside the configured worktree root', { batchId: state.id });
    }
    if (state.pushConfirmed) {
      return { ...await cleanupConfirmedPublish(projectDir, primary, settings, state, file, args), pushed: false };
    }
    let endpoint = await resolveStoredPushTarget(projectDir, state, state.target);
    if (endpoint.error) {
      return transactionFailure('publish', endpoint.code ?? 'LAND_PUSH_TARGET_INVALID', endpoint.error, {
        batchId: state.id,
      });
    }
    let attempts = 0;
    for (;;) {
      // Auto-reconciliation runs before any FIFO turn is taken: confirming a
      // completed push, archiving an integrated transaction or rebuilding
      // onto a moved baseline all pay zero queue time. Only the seconds-scale
      // finalize section below holds the repository FIFO turn.
      const reconciled = await reconcilePublishedBaseline(projectDir, settings, delivery, state, file, endpoint, args);
      if (reconciled.error) return reconciled;
      if (reconciled.status === 'confirmed') {
        return cleanupConfirmedPublish(projectDir, primary, settings, state, file, args);
      }
      if (reconciled.status === 'archived') {
        return reconciled.report;
      }
      if (reconciled.status === 'rebuilt') {
        attempts += 1;
        if (attempts >= LAND_MAX_ATTEMPTS) {
          return transactionFailure('publish', 'LAND_BATCH_BASELINE_CHANGED',
            'Remote target kept advancing; the staged candidate was preserved', {
              batchId: state.id,
              remoteHead: reconciled.remoteHead ?? null,
            });
        }
        args.onProgress?.({
          kind: 'vibe-harness.progress',
          command: 'worktree publish',
          phase: 'baseline-rebuilt',
          at: new Date().toISOString(),
          attempt: attempts,
        });
        continue;
      }
      // reconciled.status === 'current': the remote still points at the staged
      // baseline, so take the repository FIFO turn and finalize under it.
      const proofStarted = Date.now();
      let pushAttempt = await preparePushAttempt(projectDir, state.pushProof, endpoint);
      state.proofTimingsMs = { ...(state.proofTimingsMs ?? {}), inspect: Date.now() - proofStarted };
      if (!pushAttempt.ok) {
        if (!existsSync(state.candidate)) {
          const prepared = await prepareBatchCandidate(projectDir, { ...state, baseHead: state.candidateHead }, settings);
          if (prepared) return transactionFailure('publish', 'LAND_CANDIDATE_SETUP_FAILED', prepared);
        }
        const verification = await runCandidateVerification(projectDir, state, args, {
          tier: state.tier, task: [], only: null, reuse: true, allowManual: false,
          reviewed: state.reviewed, reviewPolicy: delivery.reviewPolicy, targetBranch: state.target,
        });
        if (!PASS_STATUSES.includes(verification.status) || verification.verification?.snapshotComparison !== 'match') {
          return transactionFailure('publish', 'LAND_VERIFY_ENVIRONMENT_FAILED', 'Candidate evidence expired; verification did not pass', { verification });
        }
        saveBatchState(file, state);
        pushAttempt = await preparePushAttempt(projectDir, state.pushProof, endpoint, { fresh: true });
        if (!pushAttempt.ok) return transactionFailure('publish', pushAttempt.code, 'Cannot authenticate the verified push inputs');
      }
      const turn = await args._deliveryGate?.ensure();
      if (turn && !turn.ok) return queueBlockedFailure('publish', turn);
      if (turn) state.queue = deliveryQueueTransaction(turn) ?? state.queue ?? null;
      saveBatchState(file, state);
      let turnStatus = 'cancelled';
      try {
        // The effective push URL is mutable local configuration. Re-resolve it
        // inside the FIFO turn so the push uses the endpoint whose freshness
        // was just proven, and refuse on drift.
        const freshEndpoint = await resolveStoredPushTarget(projectDir, state, state.target);
        if (freshEndpoint.error) {
          return transactionFailure('publish', 'LAND_PUSH_TARGET_CHANGED',
            'The effective push endpoint changed before publish', {
              batchId: state.id,
            });
        }
        endpoint = freshEndpoint;
        const [freshRemote, staged, sourceValid] = await Promise.all([
          exactRemoteHead(projectDir, endpoint),
          runGit(['rev-parse', stagedRef(state.id)], projectDir),
          batchSourcesStillValid(projectDir, state),
        ]);
        if (!freshRemote.ok || !staged.ok || staged.stdout.trim() !== state.candidateHead
          || !sourceValid || batchHeartbeat.lost) {
          return transactionFailure('publish', 'LAND_SNAPSHOT_CHANGED',
            'Remote target, staged candidate, source, endpoint, or lease changed before publish', {
              batchId: state.id,
            });
        }
        if (freshRemote.sha !== state.baseHead) {
          // The remote moved between reconciliation and the turn; release the
          // turn and reconcile the newer baseline outside the queue.
          attempts += 1;
          if (attempts >= LAND_MAX_ATTEMPTS) {
            return transactionFailure('publish', 'LAND_BATCH_BASELINE_CHANGED',
              'Remote target kept advancing; the staged candidate was preserved', {
                batchId: state.id,
                remoteHead: freshRemote.sha,
              });
          }
          continue;
        }
        state.phase = 'publishing';
        state.push = true;
        state.pushConfirmed = false;
        saveBatchState(file, state);
        const pushed = await runGit(['push', '--no-force', '--no-mirror', '--no-follow-tags',
          '--recurse-submodules=no', '--', endpoint.url,
          `${state.candidateHead}:${endpoint.ref}`], projectDir, {
          env: { VIBE_HARNESS_PUSH_PROOF: pushAttempt.id, VIBE_HARNESS_MANAGED_PUSH: '1' },
        });
        if (!pushed.ok && /PUSH_PROOF_/u.test(pushed.stderr ?? '')) {
          state.push = false;
          state.phase = 'staged';
          state.pushProof = null;
          saveBatchState(file, state);
          if (++attempts >= LAND_MAX_ATTEMPTS) return transactionFailure('publish', 'LAND_PUSH_PROOF_STALE',
            'Push inputs kept changing; retained the candidate for retry', { detail: boundedOutput(pushed.stderr, projectDir) });
          continue;
        }
        const after = await exactRemoteHead(projectDir, endpoint);
        if (!after.ok) {
          state.phase = 'push_uncertain';
          saveBatchState(file, state);
          return transactionFailure('publish', 'LAND_PUSH_UNCONFIRMED',
            'Push result is unknown; the transaction is preserved and the next publish run reconciles it', {
              batchId: state.id,
              remoteHead: null,
            });
        }
        if (after.sha !== state.candidateHead) {
          const ancestry = await remoteContainsCandidate(projectDir, state, endpoint, after.sha);
          if (ancestry.error) {
            state.phase = 'push_uncertain';
            saveBatchState(file, state);
            return transactionFailure('publish', 'LAND_PUSH_UNCONFIRMED',
              'Push result is unknown; the transaction is preserved and the next publish run reconciles it', {
                batchId: state.id,
                remoteHead: after.sha,
              });
          }
          if (ancestry.contained) {
            state.phase = 'push_confirmed';
            state.pushConfirmed = true;
            state.integrationStatus = 'integrated';
            state.remoteValidation = 'not_required';
            state.remoteConfirmedHead = after.sha;
            turnStatus = 'completed';
            saveBatchState(file, state);
          } else if (!pushed.ok && after.sha !== state.baseHead) {
            // The push command was rejected and the remote no longer points at
            // the staged baseline. Treat the candidate as unpublished so the
            // next pass reconciles and rebuilds from this newer baseline.
            state.phase = 'staged';
            state.push = false;
            state.pushConfirmed = false;
            state.integrationStatus = 'local_staged';
            state.remoteConfirmedHead = null;
            saveBatchState(file, state);
            attempts += 1;
            if (attempts >= LAND_MAX_ATTEMPTS) {
              return transactionFailure('publish', 'LAND_REMOTE_DIVERGED',
                'Push was rejected and the remote advanced; the staged candidate remains unpublished', {
                  batchId: state.id,
                  remoteHead: after.sha,
                });
            }
            continue;
          } else {
            const unchanged = after.sha === state.baseHead;
            state.phase = 'push_uncertain';
            saveBatchState(file, state);
            return transactionFailure('publish',
              unchanged && !pushed.ok ? 'LAND_PUSH_FAILED'
                : unchanged ? 'LAND_PUSH_UNCONFIRMED' : 'LAND_REMOTE_DIVERGED',
              'Push was not confirmed; the staged candidate and sources are preserved and the next publish run reconciles the remote', {
                batchId: state.id,
                remoteHead: after.sha,
              });
          }
        }
        state.phase = 'push_confirmed';
        state.pushConfirmed = true;
        state.integrationStatus = 'integrated';
        state.remoteValidation = 'not_required';
        state.remoteConfirmedHead = after.sha;
        turnStatus = 'completed';
        saveBatchState(file, state);
      } finally {
        await args._deliveryGate?.release(turnStatus);
      }
      return cleanupConfirmedPublish(projectDir, primary, settings, state, file, args);
    }
  } finally {
    batchHeartbeat.stop();
    releaseLease(lockFile);
  }
}
async function worktreeStageStatusReport(projectDir, args) {
  if (!args.batch) return transactionFailure('status', 'LAND_BATCH_ID_REQUIRED', 'status requires --batch <batch-id>');
  const loaded = await readLandTransaction(projectDir, args.batch);
  if (loaded.error) return { ...loaded.error, subcommand: 'status' };
  const { state } = loaded;
  const staged = await runGit(['rev-parse', stagedRef(state.id)], projectDir);
  const sourceStates = [];
  for (const source of state.sources) {
    const head = await runGit(['rev-parse', `refs/heads/${source.branch}`], projectDir);
    sourceStates.push({
      id: source.id,
      branch: source.branch,
      head: head.ok ? head.stdout.trim() : null,
      unchanged: head.ok && head.stdout.trim() === source.head,
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'status',
    status: 'passed',
    commandStatus: state.commandStatus ?? 'passed',
    integrationStatus: state.phase === 'archived_integrated' ? 'integrated'
      : state.phase === 'cleanup_pending' ? 'integrated_cleanup_pending'
      : state.pushConfirmed ? 'integrated'
      : state.phase === 'staged' ? 'local_staged' : state.integrationStatus ?? 'not_integrated',
    remoteValidation: state.remoteValidation ?? 'not_required',
    localRefSync: state.localRefSync ?? 'not_attempted',
    phase: state.phase,
    batchId: state.id,
    targetBranch: state.target,
    targetBefore: state.baseHead,
    candidateHead: state.candidateHead,
    stagedRef: stagedRef(state.id),
    stagedRefValid: staged.ok && staged.stdout.trim() === state.candidateHead,
    candidatePath: existsSync(state.candidate) ? normalizeSlashes(state.candidate) : null,
    previousCandidates: (state.previousCandidates ?? [])
      .filter((candidate) => existsSync(candidate))
      .map(normalizeSlashes),
    candidateCleanup: state.candidateCleanup ?? [],
    cleanup: state.cleanup ?? [],
    cleanupPending: state.phase === 'cleanup_pending'
      || (state.cleanup ?? []).some((item) => item.status !== 'passed')
      || (state.candidateCleanup ?? []).some((item) => item.removed !== true),
    sources: sourceStates,
    integration: state.integration,
    queue: state.queue ?? null,
    reconcileHistory: state.reconcileHistory ?? [],
    verifyFailure: state.verifyFailure ?? null,
    archive: state.archive ?? null,
  };
}
async function worktreeDiscardReport(projectDir, args) {
  if (!args.write) return transactionFailure('discard', 'LAND_WRITE_REQUIRED', 'discard requires --write');
  if (!args.batch) return transactionFailure('discard', 'LAND_BATCH_ID_REQUIRED', 'discard requires --batch <batch-id>');
  const loaded = await readLandTransaction(projectDir, args.batch);
  if (loaded.error) return { ...loaded.error, subcommand: 'discard' };
  const { file, state } = loaded;
  if (state.pushConfirmed || state.phase === 'push_confirmed' || state.phase === 'cleanup_pending'
    || state.phase === 'archived_integrated') {
    return transactionFailure('discard', 'LAND_ALREADY_INTEGRATED',
      'The candidate is already published; use status or cleanup recovery instead', {
        batchId: state.id,
      });
  }
  if (state.phase === 'push_uncertain') {
    return transactionFailure('discard', 'LAND_DISCARD_PUSH_UNCERTAIN',
      'A prior push may have succeeded; inspect the exact remote with status and retry publish before discarding', {
        batchId: state.id,
      });
  }
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return transactionFailure('discard', 'LAND_SETTINGS', settings.error);
  if (!transactionCandidateMatchesSettings(state, settings)) {
    return transactionFailure('discard', 'LAND_BATCH_STATE_INVALID',
      'The transaction candidate path is outside the configured worktree root', { batchId: state.id });
  }
  const lockFile = `${file}.lock`;
  const lease = await acquireLeaseWithRetry(lockFile, {
    timeoutMs: landLockTimeoutMs(),
    retryMs: LAND_LOCK_RETRY_MS,
    leaseMs: DEFAULT_LEASE_MS,
  });
  if (!lease.ok) return transactionFailure('discard', 'LAND_BATCH_LOCK', 'Another operation owns this batch');
  const heartbeat = startLeaseHeartbeats([lockFile], DEFAULT_LEASE_MS)[0];
  try {
    const candidateCleanup = [];
    for (const candidate of [state.candidate, ...(state.previousCandidates ?? [])]) {
      if (!existsSync(candidate)) continue;
      const dirty = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], candidate);
      if (!dirty.ok || dirty.stdout.trim()) {
        return transactionFailure('discard', 'LAND_DISCARD_CANDIDATE_DIRTY',
          'A candidate worktree contains changes; inspect it before discarding', {
            batchId: state.id,
            candidatePath: normalizeSlashes(candidate),
          });
      }
      candidateCleanup.push(await cleanupLandCandidate(projectDir, candidate, { settings }));
    }
    if (candidateCleanup.some((item) => !item.removed)) {
      return transactionFailure('discard', 'LAND_DISCARD_CLEANUP_INCOMPLETE',
        'Candidate cleanup did not complete; the transaction was retained', {
          batchId: state.id,
          candidateCleanup,
        });
    }
    await deleteTransactionRefs(projectDir, state);
    rmSync(file);
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'worktree',
      subcommand: 'discard',
      status: 'passed',
      commandStatus: 'passed',
      integrationStatus: 'not_integrated',
      remoteValidation: 'not_required',
      localRefSync: 'not_attempted',
      queue: state.queue ?? null,
      batchId: state.id,
      discarded: true,
      candidateCleanup,
      sourcesRetained: state.sources.map(({ id, branch, path: sourcePath }) => ({
        id,
        branch,
        path: normalizeSlashes(sourcePath),
      })),
    };
  } finally {
    heartbeat.stop();
    releaseLease(lockFile);
  }
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
  if (args.batch !== undefined || args.archiveIntegrated) {
    return transactionFailure('recover', 'WORKTREE_RECOVER_OPTIONS',
      'recover no longer takes --batch or --archive-integrated; publish auto-reconciles and archives integrated transactions');
  }
  if (args.task.length > 1) {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'recover', status: 'failed',
      code: 'WORKTREE_RECOVER_SCOPE_INVALID', error: 'recover accepts at most one --task; use --all for an explicit global write' };
  }
  if (args.all && args.task.length > 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'recover', status: 'failed',
      code: 'WORKTREE_RECOVER_SCOPE_INVALID', error: 'recover cannot combine --all with --task' };
  }
  if (args.write && !args.all && args.task.length === 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'recover', status: 'failed',
      code: 'WORKTREE_RECOVER_SCOPE_REQUIRED', error: 'recover --write requires --task <id>; use --all only for an explicit global recovery' };
  }
  return worktreeRecoverReportUnlocked(projectDir, args);
}
async function worktreeRecoverReportUnlocked(projectDir, args) {
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'recover', status: 'failed', error: settings.error };
  const { entries, reason } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'recover', status: 'unavailable', error: reason };
  const registry = readPortRegistry(projectDir).registry ?? null;
  const taskId = args.task.length === 0 ? null : parseWorktreeTask(args.task[0]).id;
  const inScope = (item = {}) => taskId === null
    || item.id === taskId
    || (item.path && path.basename(item.path) === taskId)
    || item.branch === taskId;
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

  const prunable = entries.filter((entry) => !entry.primary && entry.prunable && inScope(entry));
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
  const queueInventory = await inspectDeliveryQueue(projectDir);
  const activeQueueBatchIds = new Set(queueInventory.ok
    ? queueInventory.active
      .filter((ticket) => ['queued', 'running'].includes(ticket.state) && ticket.batchId)
      .map((ticket) => ticket.batchId)
    : []);
  const activeUnidentifiedDelivery = queueInventory.ok
    && queueInventory.active.some((ticket) => ['queued', 'running'].includes(ticket.state)
      && !ticket.batchId && ticket.operation === 'publish');
  const transactionFiles = candidateCommon.ok
    ? readdirSync(candidateCommon.path)
      .filter((name) => /^vibe-harness-land-batch-[0-9a-f-]+\.json$/iu.test(name))
      .sort()
    : [];
  const transactionStateIds = new Set();
  const transactions = [];
  for (const name of transactionFiles) {
    const file = path.join(candidateCommon.path, name);
    let state;
    try {
      state = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      transactions.push({
        file: normalizeSlashes(file),
        status: 'blocked',
        reason: `transaction state is unreadable: ${error.message}`,
      });
      continue;
    }
    if (typeof state?.id !== 'string') continue;
    transactionStateIds.add(state.id);
    const sourceIds = Array.isArray(state.sources) ? state.sources.map((source) => source.id) : [];
    if (taskId !== null && !sourceIds.includes(taskId) && state.id !== taskId) continue;
    const batchLease = readLease(`${file}.lock`);
    const activeQueue = activeQueueBatchIds.has(state.id);
    const terminalArchived = ['archived_integrated', 'cleaned'].includes(state.phase);
    // A publish-domain 'merging' transaction crashed during a baseline rebuild
    // and keeps its candidate, so publish must resume it. A stage-domain
    // 'merging' transaction died before any candidate existed and is safely
    // collectable.
    const mergingPublishResume = state.phase === 'merging' && typeof state.candidateHead === 'string';
    const protectedPhase = ['staged', 'publishing', 'push_uncertain', 'push_confirmed', 'cleanup_pending']
      .includes(state.phase) || mergingPublishResume;
    const collectablePhase = ['queued', 'conflict', 'merged', 'recovery_required'].includes(state.phase)
      || (state.phase === 'merging' && !mergingPublishResume);
    const candidatePaths = [state.candidate, ...(Array.isArray(state.previousCandidates) ? state.previousCandidates : [])]
      .filter((value) => typeof value === 'string' && value);
    const candidatesClean = [];
    let unsafeCandidate = null;
    for (const candidate of candidatePaths) {
      if (!existsSync(candidate)) continue;
      const status = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], candidate);
      const clean = status.ok && status.stdout.trim() === '';
      candidatesClean.push({ path: candidate, clean });
      if (!clean && unsafeCandidate === null) unsafeCandidate = candidate;
    }
    const active = !batchLease.stale || activeQueue;
    const item = {
      id: state.id,
      phase: state.phase ?? null,
      schemaVersion: state.schemaVersion ?? null,
      file: normalizeSlashes(file),
      candidatePaths: candidatePaths.map(normalizeSlashes),
      active,
      protected: protectedPhase,
      archived: terminalArchived,
      archive: state.archive ?? null,
      status: 'planned',
    };
    if (active) {
      transactions.push({ ...item, status: 'blocked', reason: 'transaction has an active lease or FIFO ticket' });
      continue;
    }
    if (terminalArchived) {
      transactions.push({ ...item, status: 'passed', reason: 'frozen sources are integrated; archive retained for audit' });
      continue;
    }
    if (protectedPhase) {
      transactions.push({ ...item, status: 'preserved', reason: `phase ${state.phase} requires its delivery command` });
      continue;
    }
    if (!collectablePhase) {
      transactions.push({ ...item, status: 'blocked', reason: `phase ${String(state.phase)} is not safely collectable` });
      continue;
    }
    if (unsafeCandidate) {
      transactions.push({
        ...item,
        status: 'blocked',
        reason: `candidate is dirty or unreadable: ${normalizeSlashes(unsafeCandidate)}`,
      });
      continue;
    }
    if (!args.write || !args.all) {
      transactions.push(item);
      continue;
    }
    const candidateCleanup = [];
    for (const candidate of candidatesClean.map((entry) => entry.path)) {
      candidateCleanup.push(await cleanupLandCandidate(projectDir, candidate, { settings }));
    }
    if (candidateCleanup.some((entry) => !entry.removed)) {
      transactions.push({
        ...item,
        candidateCleanup,
        status: 'failed',
        code: 'WORKTREE_RECOVER_TRANSACTION_CLEANUP_FAILED',
        reason: 'transaction was retained because candidate cleanup did not complete',
      });
      continue;
    }
    await deleteTransactionRefs(projectDir, state);
    rmSync(file, { force: true });
    transactions.push({ ...item, candidateCleanup, status: 'passed', reconciled: true });
  }
  const queueReconcile = await reconcileDeliveryQueue(projectDir, { write: Boolean(args.write && args.all) });
  const candidates = [];
  for (const entry of liveEntries) {
    if (!entry.detached || !entry.path || pathKey(path.dirname(entry.path)) !== pathKey(candidateRoot)) continue;
    const batch = /^\.vibe-harness-land-batch-([0-9a-f-]{36})$/iu.exec(path.basename(entry.path));
    if (batch) {
      if (taskId !== null || transactionStateIds.has(batch[1])) continue;
      if (activeUnidentifiedDelivery) {
        candidates.push({
          path: entry.path,
          id: `batch-${batch[1]}`,
          clean: false,
          activeLand: true,
          orphanedTransactionCandidate: true,
          status: 'blocked',
          reason: 'an unidentified publish ticket is active; candidate ownership is not provable',
        });
        continue;
      }
      const state = await runGit(['status', '--porcelain=v1'], entry.path);
      candidates.push({
        path: entry.path,
        id: `batch-${batch[1]}`,
        clean: state.ok && state.stdout.trim() === '',
        activeLand: false,
        orphanedTransactionCandidate: true,
        status: 'planned',
      });
      continue;
    }
    const match = candidatePattern.exec(path.basename(entry.path));
    if (!match || (taskId !== null && match[1] !== taskId)
      || !(registry?.entries ?? []).some((item) => item.id === match[1])) continue;
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
    if (!inScope({ id: registryEntry?.id ?? path.basename(entry.path), path: entry.path, branch: entry.branch })) continue;
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
      if (!inScope({ branch })) continue;
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
    if (!inScope(item)) continue;
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
  if (args.write && args.all && (prunable.length > 0 || incomplete.length > 0)) {
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

  const failed = [...results, ...candidateResults, ...branchResults, ...registryResults, ...transactions]
    .some((item) => item.status === 'failed' || item.status === 'blocked')
    || !queueInventory.ok || !queueReconcile.ok
    || (args.write && prunable.length > 0 && pruned !== true);
  const summary = [
    `status: ${failed ? 'failed' : args.write ? 'passed' : 'planned'} (write: ${Boolean(args.write)})`,
    `prunable residue: ${prunable.length}${prunable.length > 0 ? ` (${prunable.map((item) => item.path).join(', ')})` : ''}`,
    ...candidateResults.map((item) => `land candidate: ${item.path} ${item.status}${item.reason ? ` (${item.reason})` : ''}`),
    ...results.map((item) => `incomplete: ${item.path} branch ${item.branch} ${item.status}`),
    ...branchResults.map((item) => `branch: ${item.branch} ${item.status}${item.evidence ? ` [${item.evidence}]` : ''}${item.error ? ` (${item.error})` : ''}`),
    ...registryResults.map((item) => `registry entry: ${item.id} ${item.status}`),
    ...transactions.map((item) => `transaction: ${item.id ?? item.file} ${item.status}${item.reason ? ` (${item.reason})` : ''}`),
    `delivery queue: ${queueInventory.ok ? `${queueInventory.active.length} active, ${queueInventory.tickets.length} retained` : 'unavailable'}`,
    ...(queueReconcile.expired ?? []).map((item) => `queue ticket: ${item.id} expired`),
    ...(queueReconcile.removed ?? []).map((id) => `queue ticket: ${id} removed after retention`),
  ].join('\n');
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'recover',
    status: failed ? 'failed' : args.write ? 'passed' : 'planned',
    baseRef: settings.baseRef,
    candidates: candidateResults,
    transactions,
    queueInventory: queueInventory.ok ? queueInventory.tickets : [],
    queueReconciliation: queueReconcile.ok ? queueReconcile : {
      ok: false,
      code: queueReconcile.code,
      error: queueReconcile.error,
    },
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
async function dispatchWorktreeReport(projectDir, subcommand, args) {
  if (subcommand === 'list') return worktreeListReport(projectDir);
  if (subcommand === 'check') return worktreeCheckReport(projectDir, args);
  if (subcommand === 'bootstrap') return worktreeBootstrapReport(projectDir, args);
  if (subcommand === 'stage') return worktreeStageReport(projectDir, args);
  if (subcommand === 'publish') return worktreePublishReport(projectDir, args);
  if (subcommand === 'status') return worktreeStageStatusReport(projectDir, args);
  if (subcommand === 'discard') return worktreeDiscardReport(projectDir, args);
  if (subcommand === 'cleanup') return worktreeCleanupReport(projectDir, args);
  if (subcommand === 'recover') return worktreeRecoverReport(projectDir, args);
  throw new Error(`Unknown worktree subcommand: ${subcommand} (expected list, check, bootstrap, stage, publish, status, discard, cleanup or recover)`);
}
export async function worktreeReport(projectDir, args) {
  const subcommand = args._[1] ?? 'check';
  if (subcommand === 'cleanup' && typeof args.batch === 'string') return worktreeBatchCleanupReport(projectDir, args);
  if ((args.batch || args.resume !== undefined)
    && !['stage', 'publish', 'status', 'discard'].includes(subcommand)) {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand, status: 'failed',
      code: 'WORKTREE_BATCH_INVALID', error: '--batch and --resume are only supported by stage, publish, status and discard' };
  }
  if (args.targetMode !== undefined && subcommand !== 'stage') {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand, status: 'failed',
      code: 'WORKTREE_TARGET_MODE_INVALID', error: '--target-mode is only supported by worktree stage' };
  }
  // Only publish takes a repository FIFO turn, and only for its seconds-scale
  // finalize section; every other subcommand runs entirely outside the queue.
  if (!(args.write && subcommand === 'publish')) {
    return dispatchWorktreeReport(projectDir, subcommand, args);
  }
  const deliveryGate = createDeliveryGate(projectDir, args, subcommand, args.batch ?? args.resume ?? null);
  const queuedArgs = { ...args, _deliveryGate: deliveryGate };
  let report = null;
  try {
    report = await dispatchWorktreeReport(projectDir, subcommand, queuedArgs);
    return report;
  } finally {
    // Publish manages its own turn; this release is the defensive leftover for
    // an exception path, and the queue evidence keeps the ticket's own
    // terminal state instead of assuming success.
    const queueStatus = report?.status === 'passed' ? 'completed' : 'cancelled';
    await deliveryGate.release(queueStatus);
    const queue = deliveryGate.report(queueStatus);
    if (report && queue) report.queue = queue;
    if (report?.batchId && queue) {
      try {
        const common = await gitCommonDir(projectDir);
        if (common.ok) {
          const file = batchStatePath(common.path, report.batchId);
          const state = JSON.parse(readFileSync(file, 'utf8'));
          state.queue = deliveryQueueTransaction(queue);
          saveBatchState(file, state);
        }
      } catch {
        // The transaction may have completed cleanup or be intentionally
        // unreadable. Its delivery ticket is still released by this finally.
      }
    }
  }
}
