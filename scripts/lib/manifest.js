import { access, readFile } from 'node:fs/promises';

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
    workflows: await readJson(`${rootDir}/manifests/workflows.json`),
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

    if (['rules', 'skills', 'workflows'].includes(name)) {
      assertNonEmptyString(item.source, `${name}.items[${index}].source`);
    }
    if (name === 'skills') {
      assertNonEmptyString(item.metadata, `${name}.items[${index}].metadata`);
    }
    if (name === 'profiles') {
      assertNonEmptyString(item.installMap, `${name}.items[${index}].installMap`);
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

function isRedZoneTarget(target) {
  const normalized = target.replaceAll('\\', '/');
  return normalized.startsWith('.codex/') || normalized.includes('/.codex/') || normalized.endsWith('/hooks.json');
}

export function validateInstallMapShape(installMap, allowedGroups) {
  assertObject(installMap, 'install-map');
  assertNonEmptyString(installMap.adapter, 'install-map.adapter');
  if (!Array.isArray(installMap.entries)) {
    throw new Error('install-map.entries must be an array');
  }

  const targets = new Set();
  for (const [index, entry] of installMap.entries.entries()) {
    assertObject(entry, `install-map.entries[${index}]`);
    assertNonEmptyString(entry.group, `install-map.entries[${index}].group`);
    assertNonEmptyString(entry.source, `install-map.entries[${index}].source`);
    assertNonEmptyString(entry.target, `install-map.entries[${index}].target`);
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
  }
}

export async function validateManifestSources(rootDir, manifests) {
  const missing = [];
  for (const manifest of Object.values(manifests)) {
    for (const item of manifest.items ?? []) {
      const candidates = [item.source, item.path, item.template, item.metadata, item.installMap].filter(Boolean);
      for (const candidate of candidates) {
        if (!(await pathExists(`${rootDir}/${candidate}`))) {
          missing.push(candidate);
        }
      }
    }
  }
  return missing.sort();
}
