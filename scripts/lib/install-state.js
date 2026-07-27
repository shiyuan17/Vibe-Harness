import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assertInsideDir,
  assertPortableRelativePath,
  assertSafePathInside,
  pathExists,
  readJson,
} from './manifest.js';
import { canonicalProfile } from './project-config.js';
import { extractManagedInstructionBlock, removeManagedInstructionBlock } from './template-renderer.js';
import {
  extractManagedCbmIgnoreBlock,
  extractManagedMcpBlock,
  removeManagedCbmIgnoreBlock,
  removeManagedMcpBlock,
} from './tool-provisioning.js';
import { beginFileTransaction } from './file-transaction.js';
import { productIdentity } from './product-identity.js';

const stateFileName = 'install-state.json';
const isManagedInstruction = (strategy) => ['managed-block', 'managed-instruction-block'].includes(strategy);
const isManagedToml = (strategy) => ['managed-mcp-block', 'managed-toml-block'].includes(strategy);
const isManagedIgnore = (strategy) => strategy === 'managed-ignore-block';

export function toTargetPath(targetDir, filePath) {
  const relative = path.relative(targetDir, filePath).replaceAll('\\', '/');
  assertPortableRelativePath(relative, 'target path');
  return relative;
}

export function stateFilePath(targetDir) {
  const canonical = path.join(targetDir, productIdentity.stateDir, stateFileName);
  const legacy = path.join(targetDir, productIdentity.legacy.stateDir, stateFileName);
  if (existsSync(canonical) && existsSync(legacy)) {
    throw Object.assign(new Error('Both .cognis and .loopengine contain install state.'), {
      code: 'COGNIS_STATE_CONFLICT',
    });
  }
  return existsSync(legacy) ? legacy : canonical;
}

function stateDirNameFor(targetDir) {
  return path.basename(path.dirname(stateFilePath(targetDir)));
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
  const state = await readJson(filePath);
  return { adapter: 'codex', ...state, profile: canonicalProfile(state.profile) };
}

export async function writeInstallState(targetDir, state) {
  const filePath = stateFilePath(targetDir);
  await assertSafePathInside(targetDir, filePath, 'install state');
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    const storageNamespace = stateDirNameFor(targetDir) === productIdentity.legacy.stateDir
      ? 'loopengine'
      : 'cognis';
    await writeFile(temporaryPath, `${JSON.stringify({
      ...state,
      product: 'cognis',
      stateVersion: 4,
      storageNamespace,
    }, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function registerGeneratedFile(targetDir, relativeTarget) {
  assertPortableRelativePath(relativeTarget, 'generated file');
  const target = path.join(targetDir, relativeTarget);
  assertInsideDir(targetDir, target, 'generated file');
  await assertSafePathInside(targetDir, target, 'generated file');
  if (!(await pathExists(target))) return;
  const state = await readInstallState(targetDir);
  if (!state) throw new Error('Cannot register generated file without install state.');
  const generatedFiles = (state.generatedFiles ?? []).filter((file) => file.target !== relativeTarget);
  generatedFiles.push({ target: relativeTarget, targetHash: await hashFile(target) });
  await writeInstallState(targetDir, { ...state, generatedFiles });
}

export function createBackupId(date = new Date()) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

export async function backupFile({ backupId, target, targetDir }) {
  const relativeTarget = toTargetPath(targetDir, target);
  const backupRelative = `${stateDirNameFor(targetDir)}/backups/${backupId}/${relativeTarget}`;
  const backupPath = path.join(targetDir, backupRelative);
  assertInsideDir(path.join(targetDir, stateDirNameFor(targetDir), 'backups'), backupPath, 'backup path');
  await assertSafePathInside(targetDir, backupPath, 'backup path');
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
    if ([productIdentity.stateDir, productIdentity.legacy.stateDir].some(
      (stateDir) => relative === stateDir || relative.startsWith(`${stateDir}/`),
    )) {
      continue;
    }
    if (relative === '.agents/backup' || relative.startsWith('.agents/backup/')) {
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

async function assertStateActionPathsSafe(targetDir, actions, label) {
  await assertSafePathInside(targetDir, stateFilePath(targetDir), `${label} state`);
  for (const action of actions) {
    for (const key of ['target', 'ownerTarget', 'restoreTarget', 'backup', 'baselineBackup']) {
      if (typeof action[key] !== 'string') continue;
      assertPortableRelativePath(action[key], `${label} ${key}`);
      await assertSafePathInside(targetDir, path.join(targetDir, action[key]), `${label} ${key}`);
    }
  }
}

export async function createRollbackPlan({ dryRun = true, redZoneConfirmed = false, targetDir }) {
  const state = await readInstallState(targetDir);
  if (!state) {
    throw new Error(`No Cognis install state found in ${targetDir}`);
  }

  const actions = [];
  for (const directory of state.generatedDirectories ?? []) {
    assertPortableRelativePath(directory.target, 'install-state generated directory');
    assertPortableRelativePath(directory.ownerTarget, 'install-state generated directory owner');
    const target = path.join(targetDir, directory.target);
    const ownerTarget = path.join(targetDir, directory.ownerTarget);
    if (directory.projectScoped) assertInsideDir(targetDir, target, 'generated directory');
    else assertInsideDir(path.dirname(ownerTarget), target, 'generated directory');
    const owner = state.files.find((file) => file.target === directory.ownerTarget);
    if (!owner) {
      throw new Error(`Generated directory owner is not managed: ${directory.ownerTarget}`);
    }
    actions.push({
      expectedOwnerHash: owner.targetHash,
      kind: 'delete-generated-directory',
      ownerTarget: directory.ownerTarget,
      projectScoped: Boolean(directory.projectScoped),
      redZone: false,
      target: directory.target,
    });
  }
  for (const file of state.generatedFiles ?? []) {
    assertPortableRelativePath(file.target, 'install-state generated file');
    const target = path.join(targetDir, file.target);
    assertInsideDir(targetDir, target, 'generated file');
    actions.push({
      expectedHash: file.targetHash,
      kind: 'delete-generated-file',
      redZone: false,
      target: file.target,
    });
  }
  for (const file of [...state.files].reverse()) {
    assertPortableRelativePath(file.target, 'install-state target');
    const target = path.join(targetDir, file.target);
    assertInsideDir(targetDir, target, 'install-state target');
    if (isManagedIgnore(file.contentStrategy)) {
      actions.push({
        created: Boolean(file.created),
        expectedManagedBlockHash: file.managedBlockHash,
        kind: 'remove-managed-ignore-block',
        redZone: Boolean(file.redZone),
        target: file.target,
      });
    } else if (isManagedToml(file.contentStrategy)) {
      actions.push({
        expectedManagedBlockHash: file.managedBlockHash,
        kind: 'remove-managed-mcp-block',
        redZone: Boolean(file.redZone),
        target: file.target,
      });
    } else if (file.backup) {
      assertPortableRelativePath(file.backup, 'install-state backup');
      const backupPath = path.join(targetDir, file.backup);
      assertInsideDir(path.join(targetDir, stateDirNameFor(targetDir), 'backups'), backupPath, 'install-state backup');
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
    assertInsideDir(path.join(targetDir, stateDirNameFor(targetDir), 'backups'), backupPath, 'install-state retired backup');
    actions.push({
      backup: file.backup,
      kind: 'restore-retired',
      redZone: Boolean(file.redZone),
      target: file.target,
    });
  }
  if (state.configMigration) {
    const migration = state.configMigration;
    assertPortableRelativePath(migration.from, 'install-state config migration source');
    assertPortableRelativePath(migration.to, 'install-state config migration target');
    assertPortableRelativePath(migration.backup, 'install-state config migration backup');
    const target = path.join(targetDir, migration.to);
    const restoreTarget = path.join(targetDir, migration.from);
    const backupPath = path.join(targetDir, migration.backup);
    assertInsideDir(targetDir, target, 'install-state config migration target');
    assertInsideDir(targetDir, restoreTarget, 'install-state config migration source');
    assertInsideDir(path.join(targetDir, stateDirNameFor(targetDir), 'backups'), backupPath, 'install-state config migration backup');
    actions.push({
      backup: migration.backup,
      expectedHash: migration.targetHash,
      kind: 'restore-config-migration',
      redZone: false,
      restoreTarget: migration.from,
      target: migration.to,
    });
  }

  await assertStateActionPathsSafe(targetDir, actions, 'rollback');

  return {
    actions,
    dryRun,
    redZoneConfirmed,
    targetDir,
    version: state.version,
  };
}

export async function applyRollbackPlan(plan, hooks = {}) {
  if (!plan.dryRun && !plan.redZoneConfirmed && plan.actions.some((action) => action.redZone)) {
    throw new Error('Refusing to rollback red-zone files without explicit red-zone confirmation.');
  }

  const applied = [];
  const skipped = [];
  await assertStateActionPathsSafe(plan.targetDir, plan.actions, 'rollback');
  if (plan.dryRun) {
    return { applied, skipped };
  }

  const transaction = await beginFileTransaction({
    operation: 'rollback',
    targetDir: plan.targetDir,
    trackedPaths: [
      ...plan.actions.map((action) => path.join(plan.targetDir, action.target)),
      ...plan.actions
        .filter((action) => action.restoreTarget)
        .map((action) => path.join(plan.targetDir, action.restoreTarget)),
      stateFilePath(plan.targetDir),
    ],
  });

  try {
  for (const action of plan.actions) {
    assertPortableRelativePath(action.target, 'rollback target');
    const target = path.join(plan.targetDir, action.target);
    assertInsideDir(plan.targetDir, target, 'rollback target');
    if (action.kind === 'delete-generated-directory') {
      assertPortableRelativePath(action.ownerTarget, 'rollback generated directory owner');
      const ownerTarget = path.join(plan.targetDir, action.ownerTarget);
      if (action.projectScoped) assertInsideDir(plan.targetDir, target, 'rollback generated directory');
      else assertInsideDir(path.dirname(ownerTarget), target, 'rollback generated directory');
      if (await pathExists(target)) {
        if (!(await pathExists(ownerTarget)) || await hashFile(ownerTarget) !== action.expectedOwnerHash) {
          skipped.push({ reason: 'owner-modified', target: action.target });
          continue;
        }
        await rm(target, { force: true, recursive: true });
        applied.push(action.target);
      }
    } else if (action.kind === 'delete-generated-file' && await pathExists(target)) {
      if (await hashFile(target) !== action.expectedHash) {
        skipped.push({ reason: 'target-modified', target: action.target });
        continue;
      }
      await rm(target, { force: true });
      applied.push(action.target);
    } else if (action.kind === 'remove-managed-ignore-block' && await pathExists(target)) {
      const content = await readFile(target, 'utf8');
      const block = extractManagedCbmIgnoreBlock(content);
      const blockHash = createHash('sha256').update(block).digest('hex');
      if (!block || blockHash !== action.expectedManagedBlockHash) {
        skipped.push({ reason: 'managed-block-modified', target: action.target });
        continue;
      }
      const remaining = removeManagedCbmIgnoreBlock(content);
      if (remaining) await writeFile(target, remaining, 'utf8');
      else if (action.created) await rm(target, { force: true });
      else await writeFile(target, '', 'utf8');
      applied.push(action.target);
    } else if (action.kind === 'remove-managed-mcp-block' && await pathExists(target)) {
      const content = await readFile(target, 'utf8');
      const block = extractManagedMcpBlock(content);
      const blockHash = createHash('sha256').update(block).digest('hex');
      if (!block || blockHash !== action.expectedManagedBlockHash) {
        skipped.push({ reason: 'managed-block-modified', target: action.target });
        continue;
      }
      const remaining = removeManagedMcpBlock(content);
      if (remaining) await writeFile(target, remaining, 'utf8');
      else await rm(target, { force: true });
      applied.push(action.target);
    } else if (action.kind === 'restore-retired') {
      if (await pathExists(target)) {
        skipped.push({ reason: 'target-recreated', target: action.target });
        continue;
      }
      assertPortableRelativePath(action.backup, 'rollback retired backup');
      const backupPath = path.join(plan.targetDir, action.backup);
      assertInsideDir(path.join(plan.targetDir, stateDirNameFor(plan.targetDir), 'backups'), backupPath, 'rollback retired backup');
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(backupPath, target);
      applied.push(action.target);
    } else if (action.kind === 'restore-config-migration') {
      if (await pathExists(target) && await hashFile(target) !== action.expectedHash) {
        skipped.push({ reason: 'target-modified', target: action.target });
        continue;
      }
      const restoreTarget = path.join(plan.targetDir, action.restoreTarget);
      assertInsideDir(plan.targetDir, restoreTarget, 'rollback config migration source');
      if (await pathExists(restoreTarget)) {
        skipped.push({ reason: 'restore-target-recreated', target: action.restoreTarget });
        continue;
      }
      assertPortableRelativePath(action.backup, 'rollback config migration backup');
      const backupPath = path.join(plan.targetDir, action.backup);
      assertInsideDir(path.join(plan.targetDir, stateDirNameFor(plan.targetDir), 'backups'), backupPath, 'rollback config migration backup');
      await mkdir(path.dirname(restoreTarget), { recursive: true });
      await copyFile(backupPath, restoreTarget);
      await rm(target, { force: true });
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
      assertInsideDir(path.join(plan.targetDir, stateDirNameFor(plan.targetDir), 'backups'), backupPath, 'rollback backup');
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
    await hooks.afterAction?.({ action, applied, skipped });
  }

  if (skipped.length > 0) {
    await transaction.rollback();
    return { applied: [], retainedState: true, skipped };
  }
  await rm(stateFilePath(plan.targetDir), { force: true });
  await transaction.commit();
  return { applied, retainedState: false, skipped };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function createUninstallPlan({ dryRun = true, redZoneConfirmed = false, targetDir }) {
  const state = await readInstallState(targetDir);
  if (!state) throw new Error(`No Cognis install state found in ${targetDir}`);
  const actions = [];
  const baselineBackups = new Map();
  if (state.baseline?.manifest) {
    assertPortableRelativePath(state.baseline.manifest, 'install baseline manifest');
    const manifestPath = path.join(targetDir, state.baseline.manifest);
    assertInsideDir(path.join(targetDir, '.agents', 'backup'), manifestPath, 'install baseline manifest');
    const manifest = await readJson(manifestPath);
    for (const file of manifest.files ?? []) {
      assertPortableRelativePath(file.source, 'install baseline source');
      assertPortableRelativePath(file.backup, 'install baseline backup');
      assertInsideDir(path.join(targetDir, '.agents', 'backup'), path.join(targetDir, file.backup), 'install baseline backup');
      baselineBackups.set(file.source, file.backup);
    }
  }
  for (const file of state.retiredFiles ?? []) {
    assertPortableRelativePath(file.target, 'install-state retired target');
    assertPortableRelativePath(file.backup, 'install-state retired backup');
    assertInsideDir(targetDir, path.join(targetDir, file.target), 'install-state retired target');
    assertInsideDir(path.join(targetDir, stateDirNameFor(targetDir), 'backups'), path.join(targetDir, file.backup), 'install-state retired backup');
    actions.push({
      backup: file.backup,
      kind: 'restore-retired',
      redZone: Boolean(file.redZone),
      target: file.target,
    });
  }

  for (const directory of state.generatedDirectories ?? []) {
    assertPortableRelativePath(directory.target, 'install-state generated directory');
    assertPortableRelativePath(directory.ownerTarget, 'install-state generated directory owner');
    const target = path.join(targetDir, directory.target);
    const ownerTarget = path.join(targetDir, directory.ownerTarget);
    if (directory.projectScoped) assertInsideDir(targetDir, target, 'generated directory');
    else assertInsideDir(path.dirname(ownerTarget), target, 'generated directory');
    const owner = state.files.find((file) => file.target === directory.ownerTarget);
    if (!owner) throw new Error(`Generated directory owner is not managed: ${directory.ownerTarget}`);
    actions.push({
      expectedOwnerHash: owner.targetHash,
      kind: 'delete-generated-directory',
      ownerTarget: directory.ownerTarget,
      projectScoped: Boolean(directory.projectScoped),
      redZone: false,
      target: directory.target,
    });
  }
  for (const file of state.generatedFiles ?? []) {
    assertPortableRelativePath(file.target, 'install-state generated file');
    assertInsideDir(targetDir, path.join(targetDir, file.target), 'generated file');
    actions.push({ expectedHash: file.targetHash, kind: 'delete-generated-file', redZone: false, target: file.target });
  }
  for (const file of [...state.files].reverse()) {
    assertPortableRelativePath(file.target, 'install-state target');
    assertInsideDir(targetDir, path.join(targetDir, file.target), 'install-state target');
    const originalBackup = Object.hasOwn(file, 'originalBackup') ? file.originalBackup : file.backup;
    const originalCreated = file.originalCreated ?? file.created;
    if (isManagedInstruction(file.contentStrategy)) {
      actions.push({
        baselineBackup: baselineBackups.get(file.target),
        created: Boolean(originalCreated),
        expectedHash: file.targetHash,
        expectedManagedBlockHash: file.managedBlockHash,
        kind: 'remove-managed-instruction-block',
        redZone: Boolean(file.redZone),
        target: file.target,
      });
    } else if (isManagedIgnore(file.contentStrategy)) {
      actions.push({
        created: Boolean(originalCreated),
        expectedManagedBlockHash: file.managedBlockHash,
        kind: 'remove-managed-ignore-block',
        redZone: Boolean(file.redZone),
        target: file.target,
      });
    } else if (isManagedToml(file.contentStrategy)) {
      actions.push({
        expectedManagedBlockHash: file.managedBlockHash,
        kind: 'remove-managed-mcp-block',
        redZone: Boolean(file.redZone),
        target: file.target,
      });
    } else if (originalBackup) {
      assertPortableRelativePath(originalBackup, 'install-state backup');
      assertInsideDir(path.join(targetDir, stateDirNameFor(targetDir), 'backups'), path.join(targetDir, originalBackup), 'install-state backup');
      actions.push({ backup: originalBackup, expectedHash: file.targetHash, kind: 'restore-backup', redZone: Boolean(file.redZone), target: file.target });
    } else if (originalCreated) {
      actions.push({ expectedHash: file.targetHash, kind: 'delete-created', redZone: Boolean(file.redZone), target: file.target });
    } else {
      actions.push({ kind: 'leave-existing', redZone: Boolean(file.redZone), target: file.target });
    }
  }

  await assertStateActionPathsSafe(targetDir, actions, 'uninstall');

  return { actions, dryRun, redZoneConfirmed, state, targetDir, version: state.version };
}

async function applyUninstallAction(plan, action) {
  assertPortableRelativePath(action.target, 'uninstall target');
  const target = path.join(plan.targetDir, action.target);
  assertInsideDir(plan.targetDir, target, 'uninstall target');
  await assertSafePathInside(plan.targetDir, target, 'uninstall target');

  if (action.kind === 'leave-existing') return null;
  if (action.kind === 'delete-generated-directory') {
    const ownerTarget = path.join(plan.targetDir, action.ownerTarget);
    if (action.projectScoped) assertInsideDir(plan.targetDir, target, 'generated directory');
    else assertInsideDir(path.dirname(ownerTarget), target, 'generated directory');
    if (!(await pathExists(target))) return null;
    if (!(await pathExists(ownerTarget)) || await hashFile(ownerTarget) !== action.expectedOwnerHash) return 'owner-modified';
    await rm(target, { force: true, recursive: true });
    return null;
  }
  if (action.kind === 'delete-generated-file') {
    if (!(await pathExists(target))) return null;
    if (await hashFile(target) !== action.expectedHash) return 'target-modified';
    await rm(target, { force: true });
    return null;
  }
  if (['remove-managed-agents-block', 'remove-managed-instruction-block'].includes(action.kind)) {
    if (!(await pathExists(target))) return null;
    const content = await readFile(target, 'utf8');
    const block = extractManagedInstructionBlock(content);
    const blockHash = createHash('sha256').update(block ?? '').digest('hex');
    if (!block || (action.expectedManagedBlockHash && blockHash !== action.expectedManagedBlockHash)) {
      return 'managed-block-modified';
    }
    if (!action.expectedManagedBlockHash && await hashFile(target) !== action.expectedHash) return 'target-modified';
    const remaining = removeManagedInstructionBlock(content);
    if (remaining) await writeFile(target, remaining, 'utf8');
    else if (action.baselineBackup) {
      const backupPath = path.join(plan.targetDir, action.baselineBackup);
      assertInsideDir(path.join(plan.targetDir, '.agents', 'backup'), backupPath, 'uninstall baseline backup');
      await copyFile(backupPath, target);
    } else if (action.created) await rm(target, { force: true });
    else await writeFile(target, '', 'utf8');
    return null;
  }
  if (action.kind === 'remove-managed-ignore-block') {
    if (!(await pathExists(target))) return null;
    const content = await readFile(target, 'utf8');
    const block = extractManagedCbmIgnoreBlock(content);
    const blockHash = createHash('sha256').update(block).digest('hex');
    if (!block || blockHash !== action.expectedManagedBlockHash) return 'managed-block-modified';
    const remaining = removeManagedCbmIgnoreBlock(content);
    if (remaining) await writeFile(target, remaining, 'utf8');
    else if (action.created) await rm(target, { force: true });
    else await writeFile(target, '', 'utf8');
    return null;
  }
  if (action.kind === 'remove-managed-mcp-block') {
    if (!(await pathExists(target))) return null;
    const content = await readFile(target, 'utf8');
    const block = extractManagedMcpBlock(content);
    const blockHash = createHash('sha256').update(block).digest('hex');
    if (!block || blockHash !== action.expectedManagedBlockHash) return 'managed-block-modified';
    const remaining = removeManagedMcpBlock(content);
    if (remaining) await writeFile(target, remaining, 'utf8');
    else await rm(target, { force: true });
    return null;
  }
  if (action.kind === 'restore-backup') {
    if (await pathExists(target) && await hashFile(target) !== action.expectedHash) return 'target-modified';
    const backupPath = path.join(plan.targetDir, action.backup);
    assertInsideDir(path.join(plan.targetDir, stateDirNameFor(plan.targetDir), 'backups'), backupPath, 'uninstall backup');
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(backupPath, target);
    return null;
  }
  if (action.kind === 'restore-retired') {
    if (await pathExists(target)) return 'target-recreated';
    const backupPath = path.join(plan.targetDir, action.backup);
    assertInsideDir(path.join(plan.targetDir, stateDirNameFor(plan.targetDir), 'backups'), backupPath, 'uninstall retired backup');
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(backupPath, target);
    return null;
  }
  if (action.kind === 'delete-created') {
    if (!(await pathExists(target))) return null;
    if (await hashFile(target) !== action.expectedHash) return 'target-modified';
    await rm(target, { force: true });
    return null;
  }
  throw new Error(`Unknown uninstall action: ${action.kind}`);
}

async function pruneEmptyAncestors(startDir, targetDir) {
  const root = path.resolve(targetDir);
  let current = path.resolve(startDir);
  assertInsideDir(root, current, 'uninstall directory cleanup');
  await assertSafePathInside(root, current, 'uninstall directory cleanup');
  while (current !== root) {
    try {
      await rmdir(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        current = path.dirname(current);
        continue;
      }
      if (error.code === 'ENOTEMPTY') return;
      throw error;
    }
    current = path.dirname(current);
  }
}

export async function applyUninstallPlan(plan, hooks = {}) {
  if (!plan.dryRun && !plan.redZoneConfirmed && plan.actions.some((action) => action.redZone)) {
    throw new Error('Refusing to uninstall red-zone files without explicit red-zone confirmation.');
  }
  if (plan.dryRun) return { applied: [], retainedState: true, skipped: [] };

  await assertStateActionPathsSafe(plan.targetDir, plan.actions, 'uninstall');

  const transaction = await beginFileTransaction({
    operation: 'uninstall',
    targetDir: plan.targetDir,
    trackedPaths: [
      ...plan.actions.map((action) => path.join(plan.targetDir, action.target)),
      stateFilePath(plan.targetDir),
    ],
  });

  try {
  const applied = [];
  const skipped = [];
  for (const action of plan.actions) {
    const reason = await applyUninstallAction(plan, action);
    if (reason) skipped.push({ reason, target: action.target });
    else if (action.kind !== 'leave-existing') {
      applied.push(action.target);
      await pruneEmptyAncestors(path.dirname(path.join(plan.targetDir, action.target)), plan.targetDir);
    }
    await hooks.afterAction?.({ action, applied, skipped });
  }

  if (skipped.length === 0) {
    await rm(stateFilePath(plan.targetDir), { force: true });
    await transaction.commit();
    return { applied, retainedState: false, skipped };
  }

  const remainingTargets = new Set(skipped.map((item) => item.target));
  for (const action of plan.actions) {
    if (remainingTargets.has(action.target) && action.ownerTarget) remainingTargets.add(action.ownerTarget);
  }
  const remainingState = {
    ...plan.state,
    files: (plan.state.files ?? []).filter((file) => remainingTargets.has(file.target)),
    generatedDirectories: (plan.state.generatedDirectories ?? []).filter((item) => remainingTargets.has(item.target)),
    generatedFiles: (plan.state.generatedFiles ?? []).filter((item) => remainingTargets.has(item.target)),
    retiredFiles: (plan.state.retiredFiles ?? []).filter((item) => remainingTargets.has(item.target)),
  };
  await writeInstallState(plan.targetDir, remainingState);
  await transaction.commit();
  return { applied, retainedState: true, skipped };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
