import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadAllManifests, readJson, isRedZoneTarget, RED_ZONE_PATTERNS } from '../../scripts/lib/manifest.js';
import { validateRedZoneConsistency, validateRedZoneDerivations } from '../../scripts/lib/pack-validation.js';
import { DEFAULT_RED_ZONE_PATHS } from '../../runtime/hooks/lib/context.mjs';
import { defaultRedZonePaths } from '../../scripts/lib/project-config.js';
import { compileInstallPatterns, readRedZoneManifestSync, validateRedZoneManifest } from '../../scripts/lib/red-zone.js';

const rootDir = path.resolve(import.meta.dirname, '../..');

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

test('manifests/red-zone.json 是所有红区副本的唯一真值源', async () => {
  const { adapters } = await loadRealInputs();
  const canonical = readRedZoneManifestSync(rootDir);

  // Runtime hook literal equals the canonical runtimePaths exactly.
  assert.deepEqual(DEFAULT_RED_ZONE_PATHS, canonical.runtimePaths);
  // CLI install-time patterns are compiled from the canonical installPatterns.
  assert.deepEqual(RED_ZONE_PATTERNS, compileInstallPatterns(canonical.installPatterns));
  // Generated project-config defaults contain every canonical runtime path.
  for (const entry of canonical.runtimePaths) {
    assert.equal(defaultRedZonePaths.includes(entry), true, `defaultRedZonePaths missing ${entry}`);
  }

  assert.deepEqual(validateRedZoneDerivations(canonical), []);
  assert.deepEqual(validateRedZoneManifest(canonical, {
    adapterPrefixes: adapters.flatMap((adapter) => adapter.redZonePrefixes ?? []),
  }), []);
});

test('.githooks 安装目标端到端受红区门禁（TD-2026-09-02-1 回归）', async () => {
  const { installMap } = await loadRealInputs();
  assert.equal(DEFAULT_RED_ZONE_PATHS.includes('.githooks/'), true);
  assert.equal(isRedZoneTarget('.githooks/pre-commit'), true);
  assert.equal(isRedZoneTarget('.githooks/pre-push'), true);
  for (const target of ['.githooks/pre-commit', '.githooks/pre-push']) {
    const entry = installMap.entries.find((item) => item.target === target);
    assert.equal(entry?.redZone, true);
  }
});

test('真值清单地板绊线：删除强制地板路径会被拒绝', () => {
  const mutated = structuredClone(readRedZoneManifestSync(rootDir));
  mutated.runtimePaths = mutated.runtimePaths.filter((entry) => entry !== '.githooks/');

  const errors = validateRedZoneManifest(mutated);
  assert.equal(
    errors.some((message) => message.includes('drops the mandatory red-zone floor entry: .githooks/')),
    true,
  );
  // The full-list drift this tripwire exists for: without it, every copy could
  // agree on a list that silently dropped .githooks/ again.
  assert.equal(validateRedZoneDerivations(mutated).length > 0, true);
});

test('真值清单运行时路径缺少安装期门禁会被拒绝', () => {
  const mutated = structuredClone(readRedZoneManifestSync(rootDir));
  mutated.installPatterns = mutated.installPatterns.filter((source) => source !== '(?:^|/)\\.githooks/');

  const errors = validateRedZoneManifest(mutated);
  assert.equal(
    errors.some((message) => message.includes('runtimePath is not gated at install time (missing from installPatterns and all adapter redZonePrefixes): .githooks/')),
    true,
  );
});

test('真值清单安装模式匹配不到任何红区目标会被拒绝', () => {
  const mutated = structuredClone(readRedZoneManifestSync(rootDir));
  mutated.installPatterns.push('(?:^|/)\\.gemini/');

  const errors = validateRedZoneManifest(mutated);
  assert.equal(
    errors.some((message) => message.includes('installPattern covers no runtime red-zone path or adapter prefix: (?:^|/)\\.gemini/')),
    true,
  );
});
