import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  loadAllManifests,
  readJson,
  validateCatalogManifest,
  validateInstallMapShape,
  validateJsonAgainstSchema,
  validateManifestSources,
} from '../scripts/lib/manifest.js';
import { validateCapabilityMatrix, validatePack } from '../scripts/lib/pack-validation.js';

const rootDir = path.resolve('.');

test('manifests expose adapters, profiles, rules, and skills', async () => {
  const manifests = await loadAllManifests(rootDir);
  assert.deepEqual(Object.keys(manifests).sort(), ['adapters', 'profiles', 'rules', 'skills']);
  assert.equal(manifests.rules.items.some((item) => item.id === 'governance-core'), true);
  assert.equal(manifests.rules.items.some((item) => item.id === 'chrome-devtools-mcp'), true);
  assert.equal(manifests.skills.items.filter((item) => item.kind === 'native').length, 8);
  assert.equal(manifests.skills.items.some((item) => ['router', 'compatibility'].includes(item.kind)), false);
  assert.deepEqual(manifests.profiles.items.map((item) => item.id), ['minimal', 'core', 'full', 'docs-only']);
});

test('manifest source files all exist', async () => {
  assert.deepEqual(await validateManifestSources(rootDir, await loadAllManifests(rootDir)), []);
});

test('adapter schema requires an explicit goals support level', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/adapters.json'));
  const schema = await readJson(path.join(rootDir, 'schemas/adapter-pack.schema.json'));
  assert.deepEqual(validateJsonAgainstSchema(manifest, schema, 'adapters'), []);
  const missingGoals = structuredClone(manifest);
  delete missingGoals.items[0].capabilities.goals;
  assert.match(validateJsonAgainstSchema(missingGoals, schema, 'adapters').join('\n'), /goals.*required|required.*goals/iu);
});

test('project baseline schema rejects unknown fields', async () => {
  const schema = await readJson(path.join(rootDir, 'schemas/project-baseline.schema.json'));
  const sample = {
    schemaVersion: 1,
    generatedAt: '2026-07-12T00:00:00.000Z',
    project: {
      name: 'example',
      packageManager: 'pnpm',
      stackSummary: 'Node.js',
      directoryGuidance: 'src',
      vcs: { kind: 'Git', workingTreeStatus: 'clean' },
    },
    installation: {
      managedFileCount: 4,
      profile: 'minimal',
      requestedPlugins: [],
      resolvedModules: ['agents', 'rules', 'templates'],
      status: 'consistent',
      tools: {},
      version: '0.3.0',
    },
    verification: {
      mode: 'static',
      status: 'not_run',
      commands: {
        lint: { status: 'not_configured' },
        typecheck: { status: 'not_configured' },
        test: { status: 'not_configured' },
        eval: { status: 'not_configured' },
      },
    },
    recommendations: [],
    drift: { changes: [], status: 'initial' },
  };

  assert.deepEqual(validateJsonAgainstSchema(sample, schema, 'baseline'), []);
  assert.match(validateJsonAgainstSchema({ ...sample, extra: true }, schema, 'baseline').join('\n'), /extra/u);
});

test('canonical schema validation enforces numeric and string constraints and rejects unknown keywords', () => {
  const schema = {
    additionalProperties: false,
    properties: {
      count: { exclusiveMinimum: 0, maximum: 3, type: 'number' },
      id: { minLength: 2, pattern: '^[A-Z]+$', type: 'string' },
    },
    required: ['count', 'id'],
    type: 'object',
  };
  const invalid = { count: 4, id: 'a' };
  const cliErrors = validateJsonAgainstSchema(invalid, schema, 'sample');

  assert.match(cliErrors.join('\n'), /maximum|<= 3/iu);
  assert.match(cliErrors.join('\n'), /pattern|匹配/iu);
  assert.throws(
    () => validateJsonAgainstSchema({}, { type: 'object', unsupportedConstraint: true }, 'sample'),
    /unsupported schema keyword.*unsupportedConstraint/iu,
  );
});

test('manifest validation rejects missing sources and duplicate ids', () => {
  assert.throws(() => validateCatalogManifest('rules', { schemaVersion: 1, items: [{ id: 'core' }] }), /source is required/u);
  assert.throws(() => validateCatalogManifest('rules', { schemaVersion: 1, items: [
    { id: 'core', source: 'rules/governance-core.md' },
    { id: 'core', source: 'rules/codebase-memory-mcp.md' },
  ] }), /Duplicate manifest id/u);
});

test('install map validation rejects unknown groups and unsafe red-zone mappings', () => {
  assert.throws(() => validateInstallMapShape({ adapter: 'codex', entries: [
    { contentStrategy: 'replace', group: 'unknown', source: 'rules/governance-core.md', target: 'docs/rules/governance-core.md' },
  ] }, new Set(['rules-minimal'])), /Unknown install-map group/u);
  assert.throws(() => validateInstallMapShape({ adapter: 'codex', entries: [
    { contentStrategy: 'replace', group: 'rules-minimal', source: 'rules/governance-core.md', target: '.codex/hooks.json' },
  ] }, new Set(['rules-minimal'])), /redZone/u);
});

test('install map validation accepts explicit retired entries and rejects unsafe retirement declarations', () => {
  const valid = {
    adapter: 'codex',
    entries: [
      { contentStrategy: 'replace', group: 'skills-memory', source: 'skills/integrations/agentmemory/SKILL.md', target: '.agents/skills/agentmemory/SKILL.md' },
    ],
    retiredEntries: [
      { group: 'skills-memory', target: '.agents/skills/recall/SKILL.md' },
    ],
  };
  assert.doesNotThrow(() => validateInstallMapShape(valid, new Set(['skills-memory'])));
  assert.throws(() => validateInstallMapShape({
    ...valid,
    retiredEntries: [{ group: 'missing', target: '.agents/skills/recall/SKILL.md' }],
  }, new Set(['skills-memory'])), /Unknown retired install-map group/u);
  assert.throws(() => validateInstallMapShape({
    ...valid,
    retiredEntries: [{ group: 'skills-memory', target: '../escape/SKILL.md' }],
  }, new Set(['skills-memory'])), /portable relative path/u);
  assert.throws(() => validateInstallMapShape({
    ...valid,
    retiredEntries: [{ group: 'skills-memory', target: '.agents/skills/agentmemory/SKILL.md' }],
  }, new Set(['skills-memory'])), /conflicts with active install target/u);
  assert.throws(() => validateInstallMapShape({
    ...valid,
    retiredEntries: [
      { group: 'skills-memory', target: '.agents/skills/recall/SKILL.md' },
      { group: 'skills-memory', target: '.agents/skills/recall/SKILL.md' },
    ],
  }, new Set(['skills-memory'])), /Duplicate retired install target/u);
  assert.throws(() => validateInstallMapShape({
    ...valid,
    retiredEntries: [{ group: 'skills-memory', target: '.codex/hooks.json' }],
  }, new Set(['skills-memory'])), /Red-zone retired target must be marked redZone/u);
  assert.throws(() => validateInstallMapShape({
    ...valid,
    retiredEntries: [{ group: 'skills-memory', target: '.agents/skills/recall/SKILL.md', source: 'legacy.md' }],
  }, new Set(['skills-memory'])), /source is not allowed/u);
});

test('capability matrix maps every reusable capability to current assets', async () => {
  const matrix = await readJson(path.join(rootDir, 'manifests/capabilities.json'));
  const schema = await readJson(path.join(rootDir, 'schemas/capability-catalog.schema.json'));
  assert.deepEqual(validateJsonAgainstSchema(matrix, schema, 'capabilities'), []);
  assert.deepEqual(await validateCapabilityMatrix(rootDir, matrix), []);
  assert.match((await validateCapabilityMatrix(rootDir, { schemaVersion: 1, items: [] })).join('\n'), /schemaVersion 2/u);
  const invalid = structuredClone(matrix);
  invalid.items[0].evaluation = { required: false };
  assert.match((await validateCapabilityMatrix(rootDir, invalid, { checkFiles: false })).join('\n'), /evaluation reason/u);
  const unknownProfile = structuredClone(matrix);
  unknownProfile.items[0].profiles.push('unknown-profile');
  assert.match((await validateCapabilityMatrix(rootDir, unknownProfile)).join('\n'), /unknown profile/u);
  const unmanagedDoc = structuredClone(matrix);
  unmanagedDoc.items[0].docs = ['docs/not-cataloged.md'];
  assert.match((await validateCapabilityMatrix(rootDir, unmanagedDoc, { checkFiles: false })).join('\n'), /documentation catalog/u);
});

test('complete pack validates', async () => {
  const report = await validatePack(rootDir);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});
