import path from 'node:path';

import { assertPortableRelativePath, readJson, validateCatalogManifest } from './manifest.js';

const skillRoots = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  gemini: '.gemini/skills',
};

const fullCapabilities = ['instructions', 'skills', 'hooks', 'policy', 'mcp', 'sandbox', 'memory'];

function supportLevel(value) {
  if (value === true) return 'stable';
  if (value === false || value === undefined) return 'unsupported';
  return value;
}

function normalizeAdapter(adapter) {
  return {
    ...adapter,
    capabilities: Object.fromEntries(Object.entries(adapter.capabilities).map(([name, value]) => [name, supportLevel(value)])),
  };
}

export async function loadAdapterCatalog(rootDir) {
  const catalog = await readJson(path.join(rootDir, 'manifests/adapters.json'));
  validateCatalogManifest('adapters', catalog);
  return { ...catalog, items: catalog.items.map(normalizeAdapter) };
}

export async function resolveAdapter(rootDir, id) {
  const catalog = await loadAdapterCatalog(rootDir);
  const adapter = catalog.items.find((item) => item.id === id);
  if (!adapter) throw new Error(`Unknown target: ${id}`);
  return adapter;
}

export function assertAdapterProfile(adapter, profile, { allowPreview = false } = {}) {
  if (!adapter.supportedProfiles.includes(profile)) {
    const missing = fullCapabilities.filter((capability) => supportLevel(adapter.capabilities[capability]) === 'unsupported');
    const capabilityNote = missing.length > 0 ? `; unavailable capabilities: ${missing.join(', ')}` : '';
    throw new Error(`${adapter.id} does not support profile ${profile}${capabilityNote}; use core or docs-only.`);
  }
  const required = profile === 'full' ? fullCapabilities : ['instructions', 'skills', 'policy'];
  const preview = required.filter((capability) => supportLevel(adapter.capabilities[capability]) === 'preview');
  if (preview.length > 0 && !allowPreview) {
    throw new Error(`${adapter.id} profile ${profile} includes preview capabilities: ${preview.join(', ')}; retry with --allow-preview.`);
  }
}

export function resolveAdapterEntry(adapter, entry) {
  if (entry.group === 'mcp-config' && supportLevel(adapter.capabilities.mcp) === 'unsupported') return null;
  if (entry.group === 'hooks' && supportLevel(adapter.capabilities.hooks) === 'unsupported') return null;
  if (entry.source?.endsWith('/agents/openai.yaml') && adapter.id !== 'codex') return null;

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
