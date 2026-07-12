import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

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
  return JSON.parse(raw);
}

export async function loadAllManifests(rootDir) {
  return {
    profiles: await readJson(`${rootDir}/manifests/profiles.json`),
    rules: await readJson(`${rootDir}/manifests/rules.json`),
    skills: await readJson(`${rootDir}/manifests/skills.json`),
  };
}

export async function loadAllManifestSchemas(rootDir) {
  return {
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
      assertNonEmptyString(item.installMap, `${name}.items[${index}].installMap`);
      assertPortableRelativePath(item.installMap, `${name}.items[${index}].installMap`);
      if (!Array.isArray(item.groups) || item.groups.length === 0) {
        throw new Error(`${name}.items[${index}].groups must be a non-empty array`);
      }
      for (const [groupIndex, group] of item.groups.entries()) {
        assertNonEmptyString(group, `${name}.items[${index}].groups[${groupIndex}]`);
      }
    }
  }
}

export function validateAllManifestShapes(manifests) {
  for (const [name, manifest] of Object.entries(manifests)) {
    validateCatalogManifest(name, manifest);
  }
}

function schemaTypeMatches(value, type) {
  if (type === 'array') {
    return Array.isArray(value);
  }
  if (type === 'integer') {
    return Number.isInteger(value);
  }
  if (type === 'object') {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }
  return typeof value === type;
}

export function validateJsonAgainstSchema(value, schema, label = 'value') {
  const errors = [];

  function visit(currentValue, currentSchema, currentLabel) {
    if (Array.isArray(currentSchema.anyOf)) {
      const variants = currentSchema.anyOf.map((candidate) => validateJsonAgainstSchema(currentValue, candidate, currentLabel));
      if (!variants.some((variantErrors) => variantErrors.length === 0)) {
        errors.push(...variants[0]);
      }
      return;
    }
    if (currentSchema.type && !schemaTypeMatches(currentValue, currentSchema.type)) {
      errors.push(`${currentLabel} must be ${currentSchema.type}`);
      return;
    }

    if (Array.isArray(currentSchema.enum) && !currentSchema.enum.includes(currentValue)) {
      errors.push(`${currentLabel} must be one of ${currentSchema.enum.join(', ')}`);
      return;
    }

    if (currentSchema.type === 'object') {
      const required = currentSchema.required ?? [];
      for (const key of required) {
        if (!Object.hasOwn(currentValue, key)) {
          errors.push(`${currentLabel}.${key} is required`);
        }
      }

      const properties = currentSchema.properties ?? {};
      if (currentSchema.additionalProperties === false) {
        for (const key of Object.keys(currentValue)) {
          if (!Object.hasOwn(properties, key)) {
            errors.push(`${currentLabel}.${key} is not allowed`);
          }
        }
      }

      for (const [key, propertySchema] of Object.entries(properties)) {
        if (Object.hasOwn(currentValue, key)) {
          visit(currentValue[key], propertySchema, `${currentLabel}.${key}`);
        }
      }
    }

    if (currentSchema.type === 'array') {
      if (currentSchema.minItems !== undefined && currentValue.length < currentSchema.minItems) {
        errors.push(`${currentLabel} must contain at least ${currentSchema.minItems} item(s)`);
      }
      if (currentSchema.uniqueItems) {
        const serialized = currentValue.map((item) => JSON.stringify(item));
        if (new Set(serialized).size !== serialized.length) {
          errors.push(`${currentLabel} must contain unique items`);
        }
      }
      if (currentSchema.items) {
        currentValue.forEach((item, index) => visit(item, currentSchema.items, `${currentLabel}[${index}]`));
      }
    }

    if (currentSchema.type === 'string' && currentSchema.minLength !== undefined && currentValue.length < currentSchema.minLength) {
      errors.push(`${currentLabel} must have length >= ${currentSchema.minLength}`);
    }

    if (currentSchema.type === 'integer' && currentSchema.minimum !== undefined && currentValue < currentSchema.minimum) {
      errors.push(`${currentLabel} must be >= ${currentSchema.minimum}`);
    }
  }

  visit(value, schema, label);
  return errors;
}

export function validateAllManifestSchemas(manifests, schemas) {
  const errors = [];
  for (const [name, manifest] of Object.entries(manifests)) {
    errors.push(...validateJsonAgainstSchema(manifest, schemas[name], name));
  }
  return errors.sort();
}

function isRedZoneTarget(target) {
  const normalized = target.replaceAll('\\', '/');
  return normalized.startsWith('.codex/') || normalized.includes('/.codex/') || normalized.endsWith('/hooks.json');
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
    const allowedEntryKeys = new Set(['executable', 'group', 'redZone', 'source', 'target']);
    for (const key of Object.keys(entry)) {
      if (!allowedEntryKeys.has(key)) {
        throw new Error(`install-map.entries[${index}].${key} is not allowed`);
      }
    }
    assertNonEmptyString(entry.group, `install-map.entries[${index}].group`);
    assertNonEmptyString(entry.source, `install-map.entries[${index}].source`);
    assertNonEmptyString(entry.target, `install-map.entries[${index}].target`);
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
