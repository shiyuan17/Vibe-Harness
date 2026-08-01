import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertInsideDir, assertSafePathInside, pathExists } from '../manifest.js';
import { projectStateDir } from '../project-layout.js';

export async function readToolState(targetDir) {
  const statePath = path.join(await projectStateDir(targetDir), 'tool-state/tools.json');
  assertInsideDir(targetDir, statePath, 'tool state');
  await assertSafePathInside(targetDir, statePath, 'tool state');
  if (!(await pathExists(statePath))) return null;
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeToolState(targetDir, tools, fingerprints) {
  const statePath = path.join(await projectStateDir(targetDir), 'tool-state/tools.json');
  assertInsideDir(targetDir, statePath, 'tool state');
  await assertSafePathInside(targetDir, statePath, 'tool state');
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ fingerprints, tools, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}

export async function writeProvisioningMarker(targetDir, marker) {
  const markerPath = path.join(await projectStateDir(targetDir), 'tool-state/provisioning.json');
  assertInsideDir(targetDir, markerPath, 'provisioning marker');
  await assertSafePathInside(targetDir, markerPath, 'provisioning marker');
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

export async function removeProvisioningMarker(targetDir) {
  const markerPath = path.join(await projectStateDir(targetDir), 'tool-state/provisioning.json');
  await assertSafePathInside(targetDir, markerPath, 'provisioning marker');
  await rm(markerPath, { force: true });
}

export async function inspectProvisioningMarker(targetDir) {
  const markerPath = path.join(await projectStateDir(targetDir), 'tool-state/provisioning.json');
  await assertSafePathInside(targetDir, markerPath, 'provisioning marker');
  if (!(await pathExists(markerPath))) return null;
  try {
    return JSON.parse(await readFile(markerPath, 'utf8'));
  } catch {
    return { code: 'PROVISIONING_MARKER_INVALID', status: 'invalid' };
  }
}
