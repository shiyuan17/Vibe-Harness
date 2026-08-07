import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { pathExists } from './manifest.js';

const excludedDirectories = new Set([
  '.cache', '.git', '.hg', '.next', '.svn', '.turbo',
  '.agents', '.claude', '.codex', '.cursor', '.gemini', '.opencode', '.qoder', '.zcode',
  'build', 'coverage', 'dist', 'node_modules', 'out', 'target', 'vendor',
]);

async function describeNestedInstall(projectDir, statePath) {
  let state = {};
  let valid = true;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    valid = false;
  }
  const targets = Array.isArray(state.targets)
    ? state.targets
    : typeof state.adapter === 'string' ? [state.adapter] : [];
  return {
    duplicateIndex: await pathExists(path.join(projectDir, '.vibe-harness', 'tool-state', 'codebase-memory-mcp')),
    duplicateRuntime: await pathExists(path.join(projectDir, '.agents', 'runtime')),
    path: projectDir,
    statePath,
    stateVersion: Number.isInteger(state.stateVersion) ? state.stateVersion : null,
    targets,
    valid,
    version: typeof state.version === 'string' ? state.version : null,
  };
}

export async function findNestedInstallations(rootDir) {
  const root = path.resolve(rootDir);
  const found = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (excludedDirectories.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (entry.name === '.vibe-harness') {
        if (directory !== root) {
          const statePath = path.join(child, 'install-state.json');
          if (await pathExists(statePath)) found.push(await describeNestedInstall(directory, statePath));
        }
        continue;
      }
      await visit(child);
    }
  }

  await visit(root);
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

export function nestedInstallMigrationCommands(rootDir, nestedInstalls) {
  const quote = (value) => '"' + value + '"';
  const root = quote(path.resolve(rootDir));
  const commands = [
    'vibe-harness install --project ' + root + ' --upgrade --dry-run',
    'vibe-harness install --project ' + root + ' --upgrade --write',
    'vibe-harness validate --project ' + root,
  ];
  for (const item of nestedInstalls) {
    commands.push('vibe-harness uninstall --project ' + quote(item.path) + ' --all-targets --write');
  }
  return commands;
}
