import path from 'node:path';
import { readdir } from 'node:fs/promises';

import { pathExists } from './manifest.js';
import { productIdentity } from './product-identity.js';

function conflict(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function resolveProjectConfigLocation(projectDir) {
  const canonicalPath = path.join(projectDir, productIdentity.configFile);
  const legacyPath = path.join(projectDir, productIdentity.legacy.configFile);
  const [canonicalExists, legacyExists] = await Promise.all([
    pathExists(canonicalPath),
    pathExists(legacyPath),
  ]);
  if (canonicalExists && legacyExists) {
    throw conflict('COGNIS_CONFIG_CONFLICT', `Both ${productIdentity.configFile} and ${productIdentity.legacy.configFile} exist.`);
  }
  if (canonicalExists) return { legacy: false, namespace: 'cognis', path: canonicalPath };
  if (legacyExists) return { legacy: true, namespace: 'loopengine', path: legacyPath };
  return null;
}

export async function resolveProjectStateLocation(projectDir) {
  const canonicalDir = path.join(projectDir, productIdentity.stateDir);
  const legacyDir = path.join(projectDir, productIdentity.legacy.stateDir);
  const canonicalPath = path.join(canonicalDir, 'install-state.json');
  const legacyPath = path.join(legacyDir, 'install-state.json');
  const [canonicalExists, legacyExists] = await Promise.all([
    pathExists(canonicalPath),
    pathExists(legacyPath),
  ]);
  if (canonicalExists && legacyExists) {
    throw conflict('COGNIS_STATE_CONFLICT', `Both ${productIdentity.stateDir} and ${productIdentity.legacy.stateDir} contain install state.`);
  }
  if (canonicalExists) return { dir: canonicalDir, legacy: false, namespace: 'cognis', path: canonicalPath };
  if (legacyExists) return { dir: legacyDir, legacy: true, namespace: 'loopengine', path: legacyPath };
  return null;
}

export async function projectStateDir(projectDir) {
  const state = await resolveProjectStateLocation(projectDir);
  if (state) return state.dir;

  const canonicalDir = path.join(projectDir, productIdentity.stateDir);
  const legacyDir = path.join(projectDir, productIdentity.legacy.stateDir);
  const [canonicalActive, legacyActive] = await Promise.all([
    hasTransactionActivity(canonicalDir),
    hasTransactionActivity(legacyDir),
  ]);
  if (canonicalActive && legacyActive) {
    throw conflict('COGNIS_STATE_CONFLICT', `Both ${productIdentity.stateDir} and ${productIdentity.legacy.stateDir} contain active transactions.`);
  }
  if (legacyActive) return legacyDir;
  return canonicalDir;
}

async function hasTransactionActivity(stateDir) {
  if (await pathExists(path.join(stateDir, 'transaction.lock'))) return true;
  try {
    return (await readdir(path.join(stateDir, 'transactions'))).length > 0;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
