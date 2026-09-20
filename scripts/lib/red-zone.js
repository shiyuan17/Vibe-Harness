import { readFileSync } from 'node:fs';
import path from 'node:path';

// Canonical red-zone declaration. manifests/red-zone.json is the single source
// every red-zone copy derives from or is cross-checked against:
//   - scripts/lib/manifest.js RED_ZONE_PATTERNS (install-time gating regexes)
//   - scripts/lib/project-config.js defaultRedZonePaths (generated project
//     config defaults)
//   - runtime/hooks/lib/context.mjs DEFAULT_RED_ZONE_PATHS (the fail-safe
//     literal shipped inside installed hooks; equivalence is enforced by
//     pack-validation, the runtime reads the installed projection
//     .agents/runtime/hooks/red-zone.json and can only extend, never shrink)
const PACK_ROOT = path.resolve(import.meta.dirname, '..', '..');

// Tripwire floor: entries that must always be present in runtimePaths. The
// bidirectional cross-coverage in validateRedZoneManifest catches lists that
// are internally consistent but jointly wrong (the TD-2026-09-02-1 gap where
// .githooks/ was missing from every list at once).
export const RED_ZONE_FLOOR_PATHS = [
  '.env',
  'auth/',
  'ci/cd/',
  '.github/workflows/',
  '.githooks/',
  'vibe-harness.config.json',
  '.vibe-harness/install-state.json',
  '.agents/runtime/hooks/',
  '.mcp.json',
  '.codex/hooks.json',
  '.codex/config.toml',
];

export function readRedZoneManifestSync(rootDir = PACK_ROOT) {
  const manifestPath = path.join(rootDir, 'manifests', 'red-zone.json');
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read the canonical red-zone manifest (${manifestPath}): ${error.message}`);
  }
}

export function compileInstallPatterns(sources) {
  return sources.map((source) => new RegExp(source, 'u'));
}

// Module-load derivation used by scripts/lib/manifest.js: the canonical
// installPatterns compiled to the same RegExp objects the pack used to
// hard-code.
export function compiledInstallPatterns(rootDir = PACK_ROOT) {
  const manifest = readRedZoneManifestSync(rootDir);
  if (!Array.isArray(manifest.installPatterns)) {
    throw new Error('manifests/red-zone.json installPatterns must be a non-empty string array');
  }
  return compileInstallPatterns(manifest.installPatterns);
}

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isNonEmptyStringArray(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

/**
 * Semantic validation of the canonical manifest: duplicates, compilable
 * patterns, the floor tripwire, and bidirectional cross-coverage (every
 * runtimePath must be gated by an installPattern or an adapter
 * redZonePrefix; every installPattern must cover at least one of them).
 * The adapterPrefixes option exists so pack validation can pass the real
 * adapter catalog; standalone callers omit it.
 *
 * @param {{runtimePaths?: unknown, installPatterns?: unknown}} manifest
 * @param {{adapterPrefixes?: string[]}} [options]
 * @returns {string[]}
 */
export function validateRedZoneManifest(manifest, { adapterPrefixes = [] } = {}) {
  const errors = [];
  const runtimePaths = manifest?.runtimePaths;
  const installPatterns = manifest?.installPatterns;

  if (!isNonEmptyStringArray(runtimePaths)) {
    return ['manifests/red-zone.json runtimePaths must be a non-empty array of non-empty strings'];
  }
  if (!isNonEmptyStringArray(installPatterns)) {
    return ['manifests/red-zone.json installPatterns must be a non-empty array of non-empty strings'];
  }
  if (new Set(runtimePaths).size !== runtimePaths.length) {
    errors.push('manifests/red-zone.json runtimePaths must not contain duplicates');
  }
  if (new Set(installPatterns).size !== installPatterns.length) {
    errors.push('manifests/red-zone.json installPatterns must not contain duplicates');
  }

  const compiled = [];
  for (const source of installPatterns) {
    try {
      compiled.push(new RegExp(source, 'u'));
    } catch {
      errors.push(`manifests/red-zone.json installPattern is not a valid regular expression: ${source}`);
    }
  }

  for (const floorPath of RED_ZONE_FLOOR_PATHS) {
    if (!runtimePaths.includes(floorPath)) {
      errors.push(`manifests/red-zone.json runtimePaths drops the mandatory red-zone floor entry: ${floorPath}`);
    }
  }

  const normalizedPrefixes = adapterPrefixes.map((prefix) => prefix.replaceAll('\\', '/'));
  for (const redZonePath of runtimePaths) {
    const normalized = redZonePath.replaceAll('\\', '/');
    const gatedByPattern = compiled.some((pattern) => pattern.test(normalized));
    const gatedByPrefix = normalizedPrefixes.some((prefix) => normalized.startsWith(prefix));
    if (!gatedByPattern && !gatedByPrefix) {
      errors.push(`manifests/red-zone.json runtimePath is not gated at install time (missing from installPatterns and all adapter redZonePrefixes): ${redZonePath}`);
    }
  }

  const knownPaths = [...runtimePaths, ...normalizedPrefixes];
  for (const source of installPatterns) {
    let pattern;
    try {
      pattern = new RegExp(source, 'u');
    } catch {
      continue;
    }
    if (!knownPaths.some((candidate) => pattern.test(candidate.replaceAll('\\', '/')))) {
      errors.push(`manifests/red-zone.json installPattern covers no runtime red-zone path or adapter prefix: ${source}`);
    }
  }

  return [...new Set(errors)].sort();
}
