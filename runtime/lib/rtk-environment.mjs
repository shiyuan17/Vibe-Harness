import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export function resolveRtkStatePaths(projectRoot) {
  const stateDir = path.join(path.resolve(projectRoot), '.vibe-harness', 'tool-state', 'rtk');
  return {
    databasePath: path.join(stateDir, 'history.db'),
    stateDir,
    teeDir: path.join(stateDir, 'tee'),
  };
}

export function buildRtkRuntimeEnvironment(projectRoot, env = process.env) {
  const paths = resolveRtkStatePaths(projectRoot);
  return {
    ...env,
    RTK_DB_PATH: paths.databasePath,
    RTK_TEE: '0',
    RTK_TEE_DIR: paths.teeDir,
    RTK_TELEMETRY_DISABLED: '1',
  };
}

export async function prepareRtkRuntimeEnvironment(projectRoot, env = process.env) {
  const paths = resolveRtkStatePaths(projectRoot);
  await Promise.all([
    mkdir(paths.stateDir, { recursive: true }),
    mkdir(paths.teeDir, { recursive: true }),
  ]);
  return buildRtkRuntimeEnvironment(projectRoot, env);
}
