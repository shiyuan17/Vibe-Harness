import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { pathExists } from './manifest.js';
import { productIdentity } from './product-identity.js';

const legacyPaths = ['loopengine.config.json', '.loopengine', '.agents/loopengine'];
const legacyMarkerFiles = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.codex/config.toml'];

export async function findUnsupportedLegacyAssets(projectDir) {
  const assets = [];
  for (const relativePath of legacyPaths) {
    if (await pathExists(path.join(projectDir, relativePath))) assets.push(relativePath);
  }
  for (const relativePath of legacyMarkerFiles) {
    try {
      if (/LOOPENGINE(?::|\b)/u.test(await readFile(path.join(projectDir, relativePath), 'utf8'))) assets.push(relativePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return assets;
}

export async function assertNoUnsupportedLegacyAssets(projectDir) {
  const assets = await findUnsupportedLegacyAssets(projectDir);
  if (assets.length > 0) {
    throw Object.assign(new Error(`Unsupported LoopEngine assets found: ${assets.join(', ')}. Back up and remove them before initializing Cognis.`), {
      code: 'COGNIS_LEGACY_UNSUPPORTED',
    });
  }
}

export async function resolveProjectConfigLocation(projectDir) {
  const canonicalPath = path.join(projectDir, productIdentity.configFile);
  if (await pathExists(canonicalPath)) return { legacy: false, namespace: 'cognis', path: canonicalPath };
  return null;
}

export async function resolveProjectStateLocation(projectDir) {
  const canonicalDir = path.join(projectDir, productIdentity.stateDir);
  const canonicalPath = path.join(canonicalDir, 'install-state.json');
  if (await pathExists(canonicalPath)) return { dir: canonicalDir, legacy: false, namespace: 'cognis', path: canonicalPath };
  return null;
}

export async function projectStateDir(projectDir) {
  const state = await resolveProjectStateLocation(projectDir);
  if (state) return state.dir;
  return path.join(projectDir, productIdentity.stateDir);
}
