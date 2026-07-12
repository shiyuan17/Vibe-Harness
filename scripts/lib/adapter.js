import path from 'node:path';

import { assertPortableRelativePath, readJson, validateCatalogManifest } from './manifest.js';

const skillRoots = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  gemini: '.gemini/skills',
};

export async function loadAdapterCatalog(rootDir) {
  const catalog = await readJson(path.join(rootDir, 'manifests/adapters.json'));
  validateCatalogManifest('adapters', catalog);
  return catalog;
}

export async function resolveAdapter(rootDir, id) {
  const catalog = await loadAdapterCatalog(rootDir);
  const adapter = catalog.items.find((item) => item.id === id);
  if (!adapter) throw new Error(`Unknown target: ${id}`);
  return adapter;
}

export function assertAdapterProfile(adapter, profile) {
  if (!adapter.supportedProfiles.includes(profile)) {
    const missing = ['mcp', 'hooks'].filter((capability) => !adapter.capabilities[capability]);
    const capabilityNote = missing.length > 0 ? `; unavailable capabilities: ${missing.join(', ')}` : '';
    throw new Error(`${adapter.id} does not support profile ${profile}${capabilityNote}; use core or docs-only.`);
  }
}

export function resolveAdapterEntry(adapter, entry) {
  if (entry.group === 'mcp-config' && !adapter.capabilities.mcp) return null;
  if (entry.group === 'hooks' && !adapter.capabilities.hooks) return null;

  let source = entry.source;
  let target = entry.target.replaceAll('\\', '/');
  if (entry.group === 'agents') {
    const name = path.posix.basename(adapter.instructionTarget, '.md');
    source = `adapters/${adapter.id}/${name}.template.md`;
    target = adapter.instructionTarget;
  } else if (target.startsWith('.agents/skills/')) {
    target = `${skillRoots[adapter.id]}/${target.slice('.agents/skills/'.length)}`;
  }
  if (target.startsWith('.codex/') && adapter.id !== 'codex') return null;
  if (source) assertPortableRelativePath(source, 'adapter install source');
  assertPortableRelativePath(target, 'adapter install target');
  const redZone = Boolean(entry.redZone)
    || adapter.redZonePrefixes.some((prefix) => target.startsWith(prefix.replaceAll('\\', '/')));
  return { ...entry, redZone, source, target };
}
