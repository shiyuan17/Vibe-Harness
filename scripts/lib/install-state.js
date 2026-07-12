import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertInsideDir, assertPortableRelativePath, pathExists, readJson } from './manifest.js';

const stateDirName = '.loopengine';
const stateFileName = 'install-state.json';

export function toTargetPath(targetDir, filePath) {
  const relative = path.relative(targetDir, filePath).replaceAll('\\', '/');
  assertPortableRelativePath(relative, 'target path');
  return relative;
}

export function stateFilePath(targetDir) {
  return path.join(targetDir, stateDirName, stateFileName);
}

export async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export async function readInstallState(targetDir) {
  const filePath = stateFilePath(targetDir);
  if (!(await pathExists(filePath))) {
    return null;
  }
  return readJson(filePath);
}

export async function writeInstallState(targetDir, state) {
  const filePath = stateFilePath(targetDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function createBackupId(date = new Date()) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

export async function backupFile({ backupId, target, targetDir }) {
  const relativeTarget = toTargetPath(targetDir, target);
  const backupRelative = `${stateDirName}/backups/${backupId}/${relativeTarget}`;
  const backupPath = path.join(targetDir, backupRelative);
  assertInsideDir(path.join(targetDir, stateDirName, 'backups'), backupPath, 'backup path');
  await mkdir(path.dirname(backupPath), { recursive: true });
  await copyFile(target, backupPath);
  return backupRelative;
}

export async function collectTargetFiles(targetDir, currentDir = targetDir) {
  if (!(await pathExists(currentDir))) {
    return [];
  }

  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relative = toTargetPath(targetDir, fullPath);
    if (relative === stateDirName || relative.startsWith(`${stateDirName}/`)) {
      continue;
    }
    if (entry.isDirectory() && entry.name === 'node_modules') {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await collectTargetFiles(targetDir, fullPath));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

export async function createRollbackPlan({ dryRun = true, redZoneConfirmed = false, targetDir }) {
  const state = await readInstallState(targetDir);
  if (!state) {
    throw new Error(`No LoopEngine install state found in ${targetDir}`);
  }

  const actions = [];
  for (const directory of state.generatedDirectories ?? []) {
    assertPortableRelativePath(directory.target, 'install-state generated directory');
    assertPortableRelativePath(directory.ownerTarget, 'install-state generated directory owner');
    const target = path.join(targetDir, directory.target);
    const ownerTarget = path.join(targetDir, directory.ownerTarget);
    assertInsideDir(path.dirname(ownerTarget), target, 'generated directory');
    const owner = state.files.find((file) => file.target === directory.ownerTarget);
    if (!owner) {
      throw new Error(`Generated directory owner is not managed: ${directory.ownerTarget}`);
    }
    actions.push({
      expectedOwnerHash: owner.targetHash,
      kind: 'delete-generated-directory',
      ownerTarget: directory.ownerTarget,
      redZone: false,
      target: directory.target,
    });
  }
  for (const file of [...state.files].reverse()) {
    assertPortableRelativePath(file.target, 'install-state target');
    const target = path.join(targetDir, file.target);
    assertInsideDir(targetDir, target, 'install-state target');
    if (file.backup) {
      assertPortableRelativePath(file.backup, 'install-state backup');
      const backupPath = path.join(targetDir, file.backup);
      assertInsideDir(path.join(targetDir, stateDirName, 'backups'), backupPath, 'install-state backup');
      actions.push({
        backup: file.backup,
        expectedHash: file.targetHash,
        kind: 'restore-backup',
        redZone: Boolean(file.redZone),
        target: file.target,
      });
    } else if (file.created) {
      actions.push({
        expectedHash: file.targetHash,
        kind: 'delete-created',
        redZone: Boolean(file.redZone),
        target: file.target,
      });
    } else if (await pathExists(target)) {
      actions.push({
        expectedHash: file.targetHash,
        kind: 'leave-existing',
        redZone: Boolean(file.redZone),
        target: file.target,
      });
    }
  }
  for (const file of state.retiredFiles ?? []) {
    assertPortableRelativePath(file.target, 'install-state retired target');
    assertPortableRelativePath(file.backup, 'install-state retired backup');
    const target = path.join(targetDir, file.target);
    const backupPath = path.join(targetDir, file.backup);
    assertInsideDir(targetDir, target, 'install-state retired target');
    assertInsideDir(path.join(targetDir, stateDirName, 'backups'), backupPath, 'install-state retired backup');
    actions.push({
      backup: file.backup,
      kind: 'restore-retired',
      redZone: Boolean(file.redZone),
      target: file.target,
    });
  }

  return {
    actions,
    dryRun,
    redZoneConfirmed,
    targetDir,
    version: state.version,
  };
}

export async function applyRollbackPlan(plan) {
  if (!plan.dryRun && !plan.redZoneConfirmed && plan.actions.some((action) => action.redZone)) {
    throw new Error('Refusing to rollback red-zone files without explicit red-zone confirmation.');
  }

  const applied = [];
  const skipped = [];
  if (plan.dryRun) {
    return { applied, skipped };
  }

  for (const action of plan.actions) {
    assertPortableRelativePath(action.target, 'rollback target');
    const target = path.join(plan.targetDir, action.target);
    assertInsideDir(plan.targetDir, target, 'rollback target');
    if (action.kind === 'delete-generated-directory') {
      assertPortableRelativePath(action.ownerTarget, 'rollback generated directory owner');
      const ownerTarget = path.join(plan.targetDir, action.ownerTarget);
      assertInsideDir(path.dirname(ownerTarget), target, 'rollback generated directory');
      if (await pathExists(target)) {
        if (!(await pathExists(ownerTarget)) || await hashFile(ownerTarget) !== action.expectedOwnerHash) {
          skipped.push({ reason: 'owner-modified', target: action.target });
          continue;
        }
        await rm(target, { force: true, recursive: true });
        applied.push(action.target);
      }
    } else if (action.kind === 'restore-retired') {
      if (await pathExists(target)) {
        skipped.push({ reason: 'target-recreated', target: action.target });
        continue;
      }
      assertPortableRelativePath(action.backup, 'rollback retired backup');
      const backupPath = path.join(plan.targetDir, action.backup);
      assertInsideDir(path.join(plan.targetDir, stateDirName, 'backups'), backupPath, 'rollback retired backup');
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(backupPath, target);
      applied.push(action.target);
    } else if (action.kind === 'restore-backup') {
      if (await pathExists(target)) {
        const currentHash = await hashFile(target);
        if (currentHash !== action.expectedHash) {
          skipped.push({ reason: 'target-modified', target: action.target });
          continue;
        }
      }
      assertPortableRelativePath(action.backup, 'rollback backup');
      const backupPath = path.join(plan.targetDir, action.backup);
      assertInsideDir(path.join(plan.targetDir, stateDirName, 'backups'), backupPath, 'rollback backup');
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(backupPath, target);
      applied.push(action.target);
    } else if (action.kind === 'delete-created' && await pathExists(target)) {
      const currentHash = await hashFile(target);
      if (currentHash === action.expectedHash) {
        await rm(target, { force: true });
        applied.push(action.target);
      } else {
        skipped.push({ reason: 'target-modified', target: action.target });
      }
    }
  }

  await rm(stateFilePath(plan.targetDir), { force: true });
  return { applied, skipped };
}
