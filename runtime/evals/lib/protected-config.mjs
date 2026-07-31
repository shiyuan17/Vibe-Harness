import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

function candidates({ codexHome, userHome }) {
  return [
    ['codex-hooks', path.join(codexHome, 'hooks.json')],
    ['home-codex-config', path.join(userHome, '.codex', 'config.toml')],
    ['home-codex-hooks', path.join(userHome, '.codex', 'hooks.json')],
    ['claude-settings', path.join(userHome, '.claude', 'settings.json')],
    ['gemini-settings', path.join(userHome, '.gemini', 'settings.json')],
    ['cursor-hooks', path.join(userHome, '.cursor', 'hooks.json')],
  ];
}

async function metadata(filePath) {
  try {
    const details = await stat(filePath);
    if (!details.isFile()) return { exists: true, kind: details.isDirectory() ? 'directory' : 'other' };
    const content = await readFile(filePath);
    return {
      exists: true,
      hash: createHash('sha256').update(content).digest('hex'),
      kind: 'file',
      size: details.size,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

export async function snapshotProtectedConfig(roots) {
  const snapshot = {};
  for (const [label, filePath] of candidates(roots)) snapshot[label] = await metadata(filePath);
  return snapshot;
}

export function protectedConfigChanged(before, after) {
  return Object.keys(before).some((label) => JSON.stringify(before[label]) !== JSON.stringify(after[label]));
}
