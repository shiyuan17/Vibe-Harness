import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadAllManifests, readJson, RED_ZONE_PATTERNS } from '../scripts/lib/manifest.js';
import { validateRedZoneConsistency } from '../scripts/lib/pack-validation.js';
import { DEFAULT_RED_ZONE_PATHS } from '../runtime/hooks/lib/context.mjs';

const rootDir = path.resolve(import.meta.dirname, '..');

async function loadRealInputs() {
  const manifests = await loadAllManifests(rootDir);
  const installMap = await readJson(path.join(rootDir, manifests.adapters.items[0].installMap));
  return { adapters: manifests.adapters.items, installMap };
}

test('runtime red-zone paths, adapter prefixes, and install-map flags are mutually consistent', async () => {
  const { adapters, installMap } = await loadRealInputs();
  assert.deepEqual(validateRedZoneConsistency(adapters, installMap), []);
});

test('install-map entry under a runtime red-zone path must be flagged red-zone', async () => {
  const { adapters, installMap } = await loadRealInputs();
  const mutated = structuredClone(installMap);
  const hookEntry = mutated.entries.find((entry) => entry.target === '.agents/runtime/hooks/lib/context.mjs');
  assert.equal(hookEntry?.redZone, true);
  delete hookEntry.redZone;

  const errors = validateRedZoneConsistency(adapters, mutated);
  assert.equal(
    errors.some((message) => message.includes('install target is a runtime red-zone path but not red-zone gated: .agents/runtime/hooks/lib/context.mjs')),
    true,
  );
});

test('adapter config target under a runtime red-zone path must be covered by redZonePrefixes', async () => {
  const { adapters, installMap } = await loadRealInputs();
  const mutated = structuredClone(adapters);
  const claude = mutated.find((adapter) => adapter.id === 'claude');
  assert.deepEqual(claude.redZonePrefixes, ['.claude/settings.json']);
  claude.redZonePrefixes = [];

  const errors = validateRedZoneConsistency(mutated, installMap);
  assert.deepEqual(errors, [
    'claude adapter config target is a runtime red-zone path but not covered by redZonePrefixes: .claude/settings.json',
  ]);
});

test('runtime red-zone path without install-time gating is rejected (gemini skill-content drift regression)', async () => {
  const { adapters, installMap } = await loadRealInputs();
  const errors = validateRedZoneConsistency(adapters, installMap, {
    redZonePaths: [...DEFAULT_RED_ZONE_PATHS, '.gemini/'],
  });
  assert.equal(
    errors.some((message) => message.includes('runtime red-zone path is not gated at install time (missing from RED_ZONE_PATTERNS and all redZonePrefixes): .gemini/')),
    true,
  );
  // A .gemini/ runtime gate would also demand --confirm-red-zone for ordinary
  // gemini skill-content installs, which is exactly the drift this guard exists
  // to catch.
  assert.equal(
    errors.some((message) => message.includes('gemini install target is a runtime red-zone path but not red-zone gated: .gemini/skills/')),
    true,
  );
});

test('RED_ZONE_PATTERNS entry that covers no real red-zone path is rejected (dead regex drift regression)', async () => {
  const { adapters, installMap } = await loadRealInputs();
  const errors = validateRedZoneConsistency(adapters, installMap, {
    redZonePatterns: [...RED_ZONE_PATTERNS, /(?:^|\/)\.gemini\//u],
  });
  assert.deepEqual(errors, [
    'RED_ZONE_PATTERNS entry covers no runtime red-zone path or adapter prefix: /(?:^|\\/)\\.gemini\\//u',
  ]);
});
