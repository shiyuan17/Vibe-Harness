import path from 'node:path';

import {
  loadAllManifests,
  readJson,
  validateAllManifestShapes,
  validateInstallMapShape,
  validateManifestSources,
} from './manifest.js';
import { scanForForbiddenTerms } from './redaction.js';

const forbiddenTerms = ['SYBaseProjectWeb', 'SYBaseProject', 'D:\\Github\\JW', 'T-019', 'T-024', '患者', '病理', '医疗'];
const redactionDirs = ['rules', 'templates', 'skills/core', 'workflows', 'adapters/codex', 'manifests', 'schemas'];

export async function validatePack(rootDir) {
  const manifests = await loadAllManifests(rootDir);
  validateAllManifestShapes(manifests);

  const knownGroups = new Set(manifests.profiles.items.flatMap((item) => item.groups));
  for (const profile of manifests.profiles.items) {
    const installMap = await readJson(path.join(rootDir, profile.installMap));
    validateInstallMapShape(installMap, knownGroups);
  }

  const missing = await validateManifestSources(rootDir, manifests);
  const leaks = await scanForForbiddenTerms({
    forbiddenTerms,
    includeDirs: redactionDirs,
    rootDir,
  });

  return {
    leaks,
    missing,
    ok: missing.length === 0 && leaks.length === 0,
  };
}
