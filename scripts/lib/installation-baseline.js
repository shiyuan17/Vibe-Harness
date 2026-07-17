import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { hashFile } from './install-state.js';
import { assertInsideDir, assertSafePathInside, pathExists } from './manifest.js';

const instructionFiles = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.github/copilot-instructions.md',
];

function portableTimestamp(date = new Date()) {
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.', '');
}

async function collectRegularFiles(targetDir, relativeDir) {
  const directory = path.join(targetDir, relativeDir);
  if (!(await pathExists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDir.replaceAll('\\', '/'), entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...await collectRegularFiles(targetDir, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

export async function createBaselinePlan({ baseline, date, targetDir }) {
  if (baseline?.id) {
    return { actions: [], baseline, baselineId: baseline.id, targetDir };
  }

  const candidates = [];
  for (const relativePath of instructionFiles) {
    const source = path.join(targetDir, relativePath);
    if (await pathExists(source) && (await lstat(source)).isFile()) candidates.push(relativePath);
  }
  candidates.push(...await collectRegularFiles(targetDir, 'docs'));
  const baselineId = portableTimestamp(date);
  const root = path.join(targetDir, '.agents', 'backup', baselineId);
  const actions = [...new Set(candidates)].sort().map((source) => ({
    source,
    target: path.posix.join('.agents/backup', baselineId, 'files', source),
  }));

  return {
    actions,
    baseline: null,
    baselineId,
    manifestTarget: path.posix.join('.agents/backup', baselineId, 'manifest.json'),
    root,
    targetDir,
  };
}

export async function applyBaselinePlan(plan) {
  if (plan.baseline) return plan.baseline;
  const files = [];
  try {
    for (const action of plan.actions) {
      const source = path.join(plan.targetDir, action.source);
      const target = path.join(plan.targetDir, action.target);
      assertInsideDir(plan.targetDir, source, 'baseline source');
      assertInsideDir(path.join(plan.targetDir, '.agents', 'backup'), target, 'baseline target');
      await assertSafePathInside(plan.targetDir, source, 'baseline source');
      await assertSafePathInside(plan.targetDir, target, 'baseline target');
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      files.push({
        backup: action.target,
        hash: await hashFile(source),
        size: (await lstat(source)).size,
        source: action.source,
      });
    }
    const manifest = {
      createdAt: new Date().toISOString(),
      files,
      id: plan.baselineId,
      schemaVersion: 1,
    };
    const manifestTarget = path.join(plan.targetDir, plan.manifestTarget);
    await assertSafePathInside(plan.targetDir, manifestTarget, 'baseline manifest');
    await mkdir(path.dirname(manifestTarget), { recursive: true });
    await writeFile(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return {
      id: plan.baselineId,
      manifest: plan.manifestTarget,
    };
  } catch (error) {
    await rm(plan.root, { force: true, recursive: true });
    throw error;
  }
}

export async function readBaselineManifest(targetDir, baseline) {
  if (!baseline?.manifest) return null;
  return JSON.parse(await readFile(path.join(targetDir, baseline.manifest), 'utf8'));
}
