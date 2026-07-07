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
    if (action.kind === 'restore-backup') {
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
