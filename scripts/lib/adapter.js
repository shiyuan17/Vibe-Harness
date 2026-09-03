import path from 'node:path';

import { assertPortableRelativePath, readPackJson, validateCatalogManifest } from './manifest.js';

// All AGENTS.md targets (codex, cursor, qoder, zcode, opencode) share one canonical
// instruction template. Per-adapter AGENTS.template.md files MUST NOT diverge from it;
// the cross-platform single-source test enforces byte-identity. Only the codex copy is
// the source of truth; the others were removed to prevent silent drift.
export const canonicalAgentsTemplate = 'adapters/codex/AGENTS.template.md';

const fullCapabilities = ['instructions', 'skills', 'hooks', 'policy', 'mcp', 'sandbox', 'memory', 'subagents'];

function supportLevel(value) {
  if (value === true) return 'stable';
  if (value === false || value === undefined) return 'unsupported';
  return value;
}

function normalizeAdapter(adapter) {
  return {
    ...adapter,
    capabilities: Object.fromEntries(Object.entries(adapter.capabilities).map(([name, value]) => [name, supportLevel(value)])),
    ...(adapter.projectConfig ? {
      projectConfig: Object.fromEntries(Object.entries(adapter.projectConfig).map(([kind, definition]) => [kind, {
        alternateTargets: [],
        syntax: 'json',
        serverFormat: 'command-args-env',
        ...definition,
      }])),
    } : {}),
  };
}

export async function loadAdapterCatalog(rootDir) {
  const catalog = await readPackJson(path.join(rootDir, 'manifests/adapters.json'));
  validateCatalogManifest('adapters', catalog);
  return { ...catalog, items: catalog.items.map(normalizeAdapter) };
}

// Skill roots for adapters that actually install skills. Derived from the adapter
// catalog so adding/removing a target never requires editing hardcoded regexes.
// Adapters whose `capabilities.skills` is `unsupported` (e.g. zcode) are excluded.
export function skillRootPrefixes(adapters) {
  const items = Array.isArray(adapters) ? adapters : adapters.items;
  const roots = items
    .filter((adapter) => supportLevel(adapter.capabilities.skills) !== 'unsupported')
    .map((adapter) => adapter.skillRoot);
  return [...new Set(roots)].sort();
}

// Builds a predicate that tests whether a relative target lives under any adapter
// skill root. Callers pass the result of `skillRootPrefixes` once and reuse the
// predicate, replacing the three previously-duplicated hardcoded regexes.
export function skillRootMatcher(skillRoots) {
  const escaped = skillRoots.map((root) => root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const pattern = new RegExp(`^(?:${escaped.join('|')})/`, 'u');
  return (target) => pattern.test(target.replaceAll('\\', '/'));
}

// Hook-config file targets for adapters that install hooks. Derived from the
// adapter catalog so adding a host never requires extending a hardcoded ternary.
// codex has no `projectConfig` block (its hook path lives only in the install map
// and red-zone prefixes), so it is special-cased here as the sole non-derivable path.
export function hookConfigTargets(adapters) {
  const items = Array.isArray(adapters) ? adapters : adapters.items;
  const entries = [];
  for (const adapter of items) {
    if (supportLevel(adapter.capabilities.hooks) === 'unsupported') continue;
    const target = adapter.projectConfig?.hooks?.target
      ?? (adapter.id === 'codex' ? '.codex/hooks.json' : null);
    if (target) {
      const displayName = adapter.id.charAt(0).toUpperCase() + adapter.id.slice(1);
      entries.push({ id: adapter.id, target, displayName });
    }
  }
  return entries;
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
  if (entry.target.startsWith('.agents/skills/') && supportLevel(adapter.capabilities.skills) === 'unsupported') return null;
  if (entry.source?.endsWith('/agents/openai.yaml') && adapter.id !== 'codex') return null;

  let source = entry.source;
  let target = entry.target.replaceAll('\\', '/');
  if (entry.group === 'agents') {
    source = `adapters/${adapter.id}/${adapter.instructionTemplate}.template.md`;
    target = adapter.instructionTarget;
  } else if (target.startsWith('.agents/skills/')) {
    target = `${adapter.skillRoot}/${target.slice('.agents/skills/'.length)}`;
  }
  if (entry.group === 'agents' && adapter.instructionTarget === 'AGENTS.md') {
    source = canonicalAgentsTemplate;
  }
  if (target.startsWith('.codex/') && adapter.id !== 'codex') return null;
  if (source) assertPortableRelativePath(source, 'adapter install source');
  assertPortableRelativePath(target, 'adapter install target');
  const redZone = Boolean(entry.redZone)
    || adapter.redZonePrefixes.some((prefix) => target.startsWith(prefix.replaceAll('\\', '/')));
  return { ...entry, redZone, source, target };
}
