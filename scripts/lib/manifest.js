import { access, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { validateJsonAgainstSchema } from './schema-validation.js';
import { safeJsonParse } from './safe-json.js';
import { CONTENT_STRATEGIES } from './managed-block.js';

export { validateJsonAgainstSchema };

export async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return safeJsonParse(raw);
}

export async function loadAllManifests(rootDir) {
  return {
    adapters: await readJson(`${rootDir}/manifests/adapters.json`),
    profiles: await readJson(`${rootDir}/manifests/profiles.json`),
    rules: await readJson(`${rootDir}/manifests/rules.json`),
    skills: await readJson(`${rootDir}/manifests/skills.json`),
  };
}

export async function loadAllManifestSchemas(rootDir) {
  return {
    adapters: await readJson(`${rootDir}/schemas/adapter-pack.schema.json`),
    profiles: await readJson(`${rootDir}/schemas/profile-pack.schema.json`),
    rules: await readJson(`${rootDir}/schemas/rule-pack.schema.json`),
    skills: await readJson(`${rootDir}/schemas/skill-pack.schema.json`),
  };
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
}

export function assertPortableRelativePath(value, label) {
  assertNonEmptyString(value, label);
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || path.posix.isAbsolute(value)
    || /^[a-zA-Z]:/u.test(value)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} must be a portable relative path without . or .. segments: ${value}`);
  }
}

export function assertInsideDir(baseDir, candidatePath, label) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`${label} must stay inside ${resolvedBase}: ${resolvedCandidate}`);
}

function normalizePathForComparison(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInsideResolvedDir(baseDir, candidatePath) {
  const relative = path.relative(baseDir, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function assertSafePathInside(baseDir, candidatePath, label) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(candidatePath);
  assertInsideDir(resolvedBase, resolvedCandidate, label);

  let existingBase = resolvedBase;
  let baseInfo;
  while (!baseInfo) {
    try {
      baseInfo = await lstat(existingBase);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existingBase);
      if (parent === existingBase) throw error;
      existingBase = parent;
    }
  }
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) {
    throw new Error(`${label} base directory must not be a symbolic link, junction, or reparse point: ${existingBase}`);
  }

  const canonicalBase = await realpath(existingBase);
  const relative = path.relative(existingBase, resolvedCandidate);
  const segments = relative === '' ? [] : relative.split(path.sep);
  let lexicalPath = existingBase;
  let expectedCanonicalPath = canonicalBase;

  for (const segment of segments) {
    lexicalPath = path.join(lexicalPath, segment);
    expectedCanonicalPath = path.join(expectedCanonicalPath, segment);
    let info;
    try {
      info = await lstat(lexicalPath);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`${label} must not traverse a symbolic link, junction, or reparse point: ${lexicalPath}`);
    }
    const canonicalPath = await realpath(lexicalPath);
    if (
      !isInsideResolvedDir(canonicalBase, canonicalPath)
      || normalizePathForComparison(canonicalPath) !== normalizePathForComparison(expectedCanonicalPath)
    ) {
      throw new Error(`${label} must not traverse a symbolic link, junction, or reparse point: ${lexicalPath}`);
    }
  }

  return resolvedCandidate;
}

export function validateCatalogManifest(name, manifest) {
  assertObject(manifest, name);
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) {
    throw new Error(`${name}.schemaVersion must be a positive integer`);
  }
  if (!Array.isArray(manifest.items)) {
    throw new Error(`${name}.items must be an array`);
  }

  const ids = new Set();
  for (const [index, item] of manifest.items.entries()) {
    assertObject(item, `${name}.items[${index}]`);
    assertNonEmptyString(item.id, `${name}.items[${index}].id`);
    if (ids.has(item.id)) {
      throw new Error(`Duplicate manifest id: ${item.id}`);
    }
    ids.add(item.id);

    if (['rules', 'skills'].includes(name)) {
      assertNonEmptyString(item.source, `${name}.items[${index}].source`);
      assertPortableRelativePath(item.source, `${name}.items[${index}].source`);
    }
    if (name === 'skills') {
      assertNonEmptyString(item.metadata, `${name}.items[${index}].metadata`);
      assertPortableRelativePath(item.metadata, `${name}.items[${index}].metadata`);
    }
    if (name === 'profiles') {
      if (!Array.isArray(item.groups) || item.groups.length === 0) {
        throw new Error(`${name}.items[${index}].groups must be a non-empty array`);
      }
      for (const [groupIndex, group] of item.groups.entries()) {
        assertNonEmptyString(group, `${name}.items[${index}].groups[${groupIndex}]`);
      }
    }
    if (name === 'adapters') {
      assertNonEmptyString(item.installMap, `${name}.items[${index}].installMap`);
      assertPortableRelativePath(item.installMap, `${name}.items[${index}].installMap`);
      assertPortableRelativePath(item.instructionTarget, `${name}.items[${index}].instructionTarget`);
    }
  }
}

export function validateAllManifestShapes(manifests) {
  for (const [name, manifest] of Object.entries(manifests)) {
    validateCatalogManifest(name, manifest);
  }
}

export function validateAllManifestSchemas(manifests, schemas) {
  const errors = [];
  for (const [name, manifest] of Object.entries(manifests)) {
    errors.push(...validateJsonAgainstSchema(manifest, schemas[name], name));
  }
  return errors.sort();
}

// Unified red-zone predicate. This must stay aligned with the runtime hook's
// `projectRedZonePattern` (runtime/hooks/lib/policy.mjs): any install target
// that the hook treats as a project red-zone must also be flagged red-zone at
// install time so --confirm-red-zone gates it. Covers global Agent config
// (.codex/, .claude/, etc.), CI/CD workflows, environment files, and auth/ci
// directories.
const RED_ZONE_PATTERNS = [
  /(?:^|\/)\.codex\//u,
  /(?:^|\/)\.claude\//u,
  /(?:^|\/)\.gemini\//u,
  /(?:^|\/)\.github\/workflows\//u,
  /(?:^|\/)\.env(?:\.[^/]+)?$/u,
  /(?:^|\/)auth(?:\/|$)/u,
  /(?:^|\/)ci\/cd(?:\/|$)/u,
  /\/hooks\.json$/u,
];

export function isRedZoneTarget(target) {
  const normalized = target.replaceAll('\\', '/');
  return RED_ZONE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function validateInstallMapShape(installMap, allowedGroups) {
  assertObject(installMap, 'install-map');
  const allowedTopLevelKeys = new Set(['adapter', 'entries', 'retiredEntries']);
  for (const key of Object.keys(installMap)) {
    if (!allowedTopLevelKeys.has(key)) {
      throw new Error(`install-map.${key} is not allowed`);
    }
  }
  assertNonEmptyString(installMap.adapter, 'install-map.adapter');
  if (!Array.isArray(installMap.entries)) {
    throw new Error('install-map.entries must be an array');
  }

  const targets = new Set();
  for (const [index, entry] of installMap.entries.entries()) {
    assertObject(entry, `install-map.entries[${index}]`);
    const allowedEntryKeys = new Set(['contentStrategy', 'executable', 'group', 'redZone', 'source', 'target']);
    for (const key of Object.keys(entry)) {
      if (!allowedEntryKeys.has(key)) {
        throw new Error(`install-map.entries[${index}].${key} is not allowed`);
      }
    }
    assertNonEmptyString(entry.group, `install-map.entries[${index}].group`);
    assertNonEmptyString(entry.source, `install-map.entries[${index}].source`);
    assertNonEmptyString(entry.target, `install-map.entries[${index}].target`);
    if (!CONTENT_STRATEGIES.includes(entry.contentStrategy)) {
      throw new Error(`install-map.entries[${index}].contentStrategy is invalid`);
    }
    assertPortableRelativePath(entry.source, `install-map.entries[${index}].source`);
    assertPortableRelativePath(entry.target, `install-map.entries[${index}].target`);
    if (!allowedGroups.has(entry.group)) {
      throw new Error(`Unknown install-map group: ${entry.group}`);
    }
    if (targets.has(entry.target)) {
      throw new Error(`Duplicate install target: ${entry.target}`);
    }
    targets.add(entry.target);
    if (isRedZoneTarget(entry.target) && entry.redZone !== true) {
      throw new Error(`Red-zone target must be marked redZone: ${entry.target}`);
    }
    if (Object.hasOwn(entry, 'executable') && typeof entry.executable !== 'boolean') {
      throw new Error(`install-map.entries[${index}].executable must be boolean`);
    }
  }

  if (installMap.retiredEntries !== undefined && !Array.isArray(installMap.retiredEntries)) {
    throw new Error('install-map.retiredEntries must be an array');
  }
  const retiredTargets = new Set();
  for (const [index, entry] of (installMap.retiredEntries ?? []).entries()) {
    assertObject(entry, `install-map.retiredEntries[${index}]`);
    const allowedEntryKeys = new Set(['group', 'redZone', 'target']);
    for (const key of Object.keys(entry)) {
      if (!allowedEntryKeys.has(key)) {
        throw new Error(`install-map.retiredEntries[${index}].${key} is not allowed`);
      }
    }
    assertNonEmptyString(entry.group, `install-map.retiredEntries[${index}].group`);
    assertNonEmptyString(entry.target, `install-map.retiredEntries[${index}].target`);
    assertPortableRelativePath(entry.target, `install-map.retiredEntries[${index}].target`);
    if (!allowedGroups.has(entry.group)) {
      throw new Error(`Unknown retired install-map group: ${entry.group}`);
    }
    if (targets.has(entry.target)) {
      throw new Error(`Retired install target conflicts with active install target: ${entry.target}`);
    }
    if (retiredTargets.has(entry.target)) {
      throw new Error(`Duplicate retired install target: ${entry.target}`);
    }
    retiredTargets.add(entry.target);
    if (isRedZoneTarget(entry.target) && entry.redZone !== true) {
      throw new Error(`Red-zone retired target must be marked redZone: ${entry.target}`);
    }
    if (Object.hasOwn(entry, 'redZone') && typeof entry.redZone !== 'boolean') {
      throw new Error(`install-map.retiredEntries[${index}].redZone must be boolean`);
    }
  }
}

export async function validateManifestSources(rootDir, manifests) {
  const missing = [];
  for (const manifest of Object.values(manifests)) {
    for (const item of manifest.items ?? []) {
      const candidates = [item.source, item.path, item.template, item.metadata, item.installMap].filter(Boolean);
      for (const candidate of candidates) {
        assertPortableRelativePath(candidate, 'manifest source');
        const candidatePath = path.join(rootDir, candidate);
        assertInsideDir(rootDir, candidatePath, 'manifest source');
        if (!(await pathExists(candidatePath))) {
          missing.push(candidate);
        }
      }
    }
  }
  return missing.sort();
}
