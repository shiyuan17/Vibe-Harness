import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { pathExists, readJson } from './manifest.js';

export async function createInstallPlan({ dryRun = true, force = false, profile = 'codex-internal', rootDir, targetDir }) {
  const profiles = await readJson(path.join(rootDir, 'manifests/profiles.json'));
  const selectedProfile = profiles.items.find((item) => item.id === profile);
  if (!selectedProfile) {
    throw new Error(`Unknown profile: ${profile}`);
  }

  const installMap = await readJson(path.join(rootDir, selectedProfile.installMap));
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
