import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { pathExists, readJson, validateCatalogManifest, validateInstallMapShape } from './manifest.js';

async function loadProfileInstallMap({ profile, rootDir }) {
  const profiles = await readJson(path.join(rootDir, 'manifests/profiles.json'));
  validateCatalogManifest('profiles', profiles);

  const selectedProfile = profiles.items.find((item) => item.id === profile);
  if (!selectedProfile) {
    throw new Error(`Unknown profile: ${profile}`);
  }

  const installMap = await readJson(path.join(rootDir, selectedProfile.installMap));
  const knownGroups = new Set(profiles.items.flatMap((item) => item.groups));
  validateInstallMapShape(installMap, knownGroups);

  return { installMap, selectedProfile };
}

export async function createInstallPlan({ dryRun = true, force = false, profile = 'codex-internal', rootDir, targetDir }) {
  const { installMap, selectedProfile } = await loadProfileInstallMap({ profile, rootDir });
  const allowedGroups = new Set(selectedProfile.groups);
  const actions = [];

  for (const entry of installMap.entries) {
    if (!allowedGroups.has(entry.group)) {
      continue;
    }
    const source = path.resolve(rootDir, entry.source);
    const target = path.resolve(targetDir, entry.target);
    const exists = await pathExists(target);
    actions.push({
      group: entry.group,
      kind: exists && !force ? 'conflict' : 'write',
      redZone: Boolean(entry.redZone),
      source,
      target,
    });
  }

  return {
    dryRun,
    force,
    profile,
    redZoneConfirmed: false,
    targetDir: path.resolve(targetDir),
    actions,
  };
}

export async function inspectTargetInstall({ profile = 'codex-internal', rootDir, targetDir }) {
  const { installMap, selectedProfile } = await loadProfileInstallMap({ profile, rootDir });
  const allowedGroups = new Set(selectedProfile.groups);
  const expected = [];
  const installed = [];
  const missing = [];
  const conflicts = [];
  const redZone = [];

  for (const entry of installMap.entries) {
    if (!allowedGroups.has(entry.group)) {
      continue;
    }
    const target = path.resolve(targetDir, entry.target);
    const source = path.resolve(rootDir, entry.source);
    const item = {
      group: entry.group,
      redZone: Boolean(entry.redZone),
      source,
      target,
    };
    expected.push(item);

    if (await pathExists(target)) {
      installed.push(item);
      const [sourceContent, targetContent] = await Promise.all([
        readFile(source, 'utf8'),
        readFile(target, 'utf8'),
      ]);
      if (sourceContent !== targetContent) {
        conflicts.push(item);
      }
      if (item.redZone) {
        redZone.push({ ...item, status: 'present' });
      }
    } else {
      missing.push(item);
      if (item.redZone) {
        redZone.push({ ...item, status: 'missing' });
      }
    }
  }

  return {
    conflicts,
    expected,
    installed,
    missing,
    ok: missing.length === 0 && conflicts.length === 0,
    profile,
    redZone,
    targetDir: path.resolve(targetDir),
  };
}

export async function applyInstallPlan(plan) {
  if (!plan.force) {
    const conflict = plan.actions.find((action) => action.kind === 'conflict');
    if (conflict) {
      throw new Error(`Refusing to overwrite existing file: ${conflict.target}`);
    }
  }

  if (!plan.dryRun && !plan.redZoneConfirmed && plan.actions.some((action) => action.redZone)) {
    throw new Error('Refusing to write red-zone files without explicit red-zone confirmation.');
  }

  const written = [];
  if (plan.dryRun) {
    return { written };
  }

  for (const action of plan.actions) {
    await mkdir(path.dirname(action.target), { recursive: true });
    await copyFile(action.source, action.target);
    written.push(action.target);
  }

  return { written };
}
