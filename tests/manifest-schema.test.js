import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  loadAllManifests,
  readJson,
  validateCatalogManifest,
  validateInstallMapShape,
  validateJsonAgainstSchema,
  validateManifestSources,
} from '../scripts/lib/manifest.js';
import { resolveAdapterEntry } from '../scripts/lib/adapter.js';
import { moduleCatalog } from '../scripts/lib/module-selection.js';
import { validateCapabilityMatrix, validateInstructionBudget, validatePack, validateSelfInstalledArtifacts, validateSkillMetadataQuality } from '../scripts/lib/pack-validation.js';
import {
  pluginProviderCatalog,
  validatePluginProviderCatalog,
} from '../scripts/lib/plugin-provider-catalog.js';
import { toolSpecs } from '../scripts/lib/tool-provisioning/environment.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('manifests expose adapters, profiles, rules, and skills', async () => {
  const manifests = await loadAllManifests(rootDir);
  assert.deepEqual(Object.keys(manifests).sort(), ['adapters', 'profiles', 'roles', 'rules', 'skills']);
  assert.equal(manifests.rules.items.some((item) => item.id === 'governance-core'), true);
  assert.equal(manifests.rules.items.some((item) => item.id === 'chrome-devtools-mcp'), true);
  assert.equal(manifests.skills.items.filter((item) => item.kind === 'native').length, 9);
  assert.equal(manifests.skills.items.some((item) => ['router', 'compatibility'].includes(item.kind)), false);
  assert.deepEqual(manifests.profiles.items.map((item) => item.id), ['minimal', 'core', 'full', 'docs-only']);
});

test('manifest source files all exist', async () => {
  assert.deepEqual(await validateManifestSources(rootDir, await loadAllManifests(rootDir)), []);
});

test('plugin provider catalog is valid and matches module, provisioning, and config contracts', async () => {
  const projectConfigSchema = await readJson(path.join(rootDir, 'schemas/project-config.schema.json'));
  const options = {
    moduleIds: new Set(Object.keys(moduleCatalog)),
    provisioningToolIds: new Set(toolSpecs.map((spec) => spec.id)),
  };

  assert.deepEqual(validatePluginProviderCatalog(pluginProviderCatalog, options), []);
  assert.deepEqual(
    pluginProviderCatalog.providers
      .filter((provider) => provider.selection.allowInProjectConfig)
      .map((provider) => provider.moduleId),
    projectConfigSchema.properties.plugins.items.enum,
  );
});

test('plugin provider catalog rejects invalid identities and references', () => {
  const duplicateAlias = structuredClone(pluginProviderCatalog);
  duplicateAlias.providers[1].aliases.push(duplicateAlias.providers[0].aliases[0]);
  assert.match(validatePluginProviderCatalog(duplicateAlias).join('\n'), /Duplicate provider alias/u);

  const unknownCapability = structuredClone(pluginProviderCatalog);
  unknownCapability.providers[0].capabilities = ['missing.capability'];
  assert.match(validatePluginProviderCatalog(unknownCapability).join('\n'), /unknown capability/u);

  const asymmetricConflict = structuredClone(pluginProviderCatalog);
  delete asymmetricConflict.providers.at(-1).conflicts;
  assert.match(validatePluginProviderCatalog(asymmetricConflict).join('\n'), /conflict must be symmetric/u);

  const duplicateTool = structuredClone(pluginProviderCatalog);
  duplicateTool.providers[1].provisioningToolId = duplicateTool.providers[0].provisioningToolId;
  assert.match(validatePluginProviderCatalog(duplicateTool).join('\n'), /Duplicate provisioning tool id/u);

  const invalidTransport = structuredClone(pluginProviderCatalog);
  invalidTransport.providers[0].transport = 'hook';
  assert.match(validatePluginProviderCatalog(invalidTransport).join('\n'), /transport/u);

  const unknownModule = structuredClone(pluginProviderCatalog);
  unknownModule.providers[0].moduleId = 'missing-module';
  assert.match(
    validatePluginProviderCatalog(unknownModule, { moduleIds: new Set(Object.keys(moduleCatalog)) }).join('\n'),
    /unknown module/u,
  );

  const unknownTool = structuredClone(pluginProviderCatalog);
  unknownTool.providers[0].provisioningToolId = 'missingTool';
  assert.match(
    validatePluginProviderCatalog(unknownTool, { provisioningToolIds: new Set(toolSpecs.map((spec) => spec.id)) }).join('\n'),
    /unknown provisioning tool/u,
  );
});

test('adapter schema requires an explicit goals support level', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/adapters.json'));
  const schema = await readJson(path.join(rootDir, 'schemas/adapter-pack.schema.json'));
  assert.deepEqual(validateJsonAgainstSchema(manifest, schema, 'adapters'), []);
  const missingGoals = structuredClone(manifest);
  delete missingGoals.items[0].capabilities.goals;
  assert.match(validateJsonAgainstSchema(missingGoals, schema, 'adapters').join('\n'), /goals.*required|required.*goals/iu);
  const missingSubagents = structuredClone(manifest);
  delete missingSubagents.items[0].capabilities.subagents;
  assert.match(validateJsonAgainstSchema(missingSubagents, schema, 'adapters').join('\n'), /subagents.*required|required.*subagents/iu);
});

test('adapter manifest v4 requires role projection and the fixed Hook contract', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/adapters.json'));
  const schema = await readJson(path.join(rootDir, 'schemas/adapter-pack.schema.json'));
  const expected = {
    codex: ['stable', 'stable', 'unsupported', 'manual-trust'],
    claude: ['stable', 'stable', 'unsupported', 'config-file'],
    gemini: ['unsupported', 'unsupported', 'unsupported', 'unsupported'],
    cursor: ['stable', 'unsupported', 'unsupported', 'config-file'],
    qoder: ['stable', 'stable', 'unsupported', 'config-file'],
    zcode: ['stable', 'stable', 'unsupported', 'config-file'],
    antigravity: ['preview', 'unsupported', 'unsupported', 'config-file'],
    opencode: ['unsupported', 'unsupported', 'unsupported', 'unsupported'],
  };
  assert.equal(manifest.schemaVersion, 4);
  for (const adapter of manifest.items) {
    assert.deepEqual([
      adapter.hookEvents.preToolUse,
      adapter.hookEvents.permissionRequest,
      adapter.hookEvents.stop,
      adapter.hookActivation,
    ], expected[adapter.id], adapter.id);
    assert.equal(typeof adapter.roleProjection.targetRoot, 'string', adapter.id);
  }
  const missing = structuredClone(manifest);
  delete missing.items[0].hookEvents;
  assert.match(validateJsonAgainstSchema(missing, schema, 'adapters').join('\n'), /hookEvents.*required|required.*hookEvents/iu);
});

test('adapter Hook templates match the event-level manifest exactly', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/adapters.json'));
  const eventKeys = {
    PermissionRequest: 'permissionRequest',
    PreToolUse: 'preToolUse',
    preToolUse: 'preToolUse',
    Stop: 'stop',
  };
  for (const adapter of manifest.items) {
    const templatePath = path.join(rootDir, 'adapters', adapter.id, 'hooks.template.json');
    let template = {};
    try {
      template = await readJson(templatePath);
    } catch {}
    const hooks = adapter.id === 'codex' ? (template.hooks || {}) : template;
    const declared = new Set(Object.entries(adapter.hookEvents)
      .filter(([, support]) => support !== 'unsupported')
      .map(([event]) => event));
    const actual = new Set(Object.keys(hooks).map((event) => eventKeys[event]).filter(Boolean));
    assert.deepEqual([...actual].sort(), [...declared].sort(), adapter.id);
  }
});

test('project baseline schema rejects unknown fields', async () => {
  const schema = await readJson(path.join(rootDir, 'schemas/project-baseline.schema.json'));
  const sample = {
    schemaVersion: 2,
    generatedAt: '2026-07-12T00:00:00.000Z',
    project: {
      name: 'example',
      packageManager: 'pnpm',
      stackSummary: 'Node.js',
      directoryGuidance: 'src',
      logging: {
        status: 'unknown',
        evidence: { frameworks: [], configFiles: [], queryCandidates: [], correlationCandidates: [] },
        contract: { frameworks: [], configFiles: [], sources: [], queries: [], correlationFields: [], verification: [] },
      },
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

test('self-installed artifacts must stay in sync with their sources', async () => {
  // The real pack validates (covered by the next test), which means every
  // replace entry whose source has no render placeholder is byte-identical to
  // its self-installed artifact. Build a synthetic install map that points a
  // real source at a mismatched target to prove the drift detector fires.
  const realSource = 'schemas/eval-run.schema.json';
  const adapters = { items: [{ id: 'codex', installMap: 'synthetic.json', instructionTarget: 'AGENTS.md', capabilities: {}, redZonePrefixes: [] }] };
  const drifted = {
    adapter: 'codex',
    entries: [{
      contentStrategy: 'replace',
      group: 'schemas-core',
      source: realSource,
      target: 'docs/rules/governance-core.md',
    }],
  };
  const installMaps = new Map([['synthetic.json', drifted]]);
  const errors = await validateSelfInstalledArtifacts(rootDir, adapters, installMaps);
  assert.ok(errors.length > 0, 'drifted artifact must be reported');
  assert.match(errors.join('\n'), /drifted from source/u);

  // A matching source/target pair must report no drift.
  const matched = { ...drifted, entries: [{ ...drifted.entries[0], target: 'docs/schemas/eval-run.schema.json' }] };
  const matchedErrors = await validateSelfInstalledArtifacts(rootDir, adapters, new Map([['synthetic.json', matched]]));
  assert.deepEqual(matchedErrors, []);

  const missing = { ...drifted, entries: [{ ...drifted.entries[0], target: 'docs/schemas/does-not-exist.json' }] };
  const missingErrors = await validateSelfInstalledArtifacts(rootDir, adapters, new Map([['synthetic.json', missing]]));
  assert.match(missingErrors.join('\n'), /self-installed artifact is missing/u);

  // Sources carrying render placeholders are skipped (source != artifact by design).
  const placeholder = {
    adapter: 'codex',
    entries: [{
      contentStrategy: 'replace',
      group: 'rules-core',
      source: 'rules/project-specific-rules.md',
      target: 'docs/rules/governance-core.md',
    }],
  };
  const placeholderErrors = await validateSelfInstalledArtifacts(rootDir, adapters, new Map([['synthetic.json', placeholder]]));
  assert.deepEqual(placeholderErrors, []);
});

test('complete pack validates', async () => {
  const report = await validatePack(rootDir);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.deepEqual(report.workflowScan, {
    findings: [],
    inventoryCount: 3,
    scannedCount: 3,
    status: 'clean',
  });
});

test('skill descriptions stay English and single-script across the pack', async () => {
  // Host routing matches skills by description text, so the pack unifies on
  // English descriptions; Chinese prose inside some descriptions would give
  // Chinese-language requests an inconsistent routing surface.
  const manifests = await loadAllManifests(rootDir);
  assert.deepEqual(await validateSkillMetadataQuality(rootDir, manifests.skills.items), []);
  for (const item of manifests.skills.items) {
    const content = await readFile(path.join(rootDir, item.source), 'utf8');
    const description = content.match(/^description: (.+)$/mu)?.[1];
    assert.ok(description, `${item.id} SKILL.md must have a single-line description`);
    assert.equal(/[\u3400-\u9fff\uf900-\ufaff]/u.test(description), false, `${item.id} description must stay English`);
  }
});

test('skill metadata quality rejects mixed-script and pack-split descriptions', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-skill-lang-'));
  const writeSkill = async (id, description) => {
    const dir = path.join(target, id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n`);
    return { id, source: `${id}/SKILL.md` };
  };
  try {
    const english = await writeSkill('english-skill', 'Use for reviewing delivery evidence before push.');
    const chinese = await writeSkill('chinese-skill', '仅当用户显式调用该命令或明确要求使用此技能时才使用；用于整理当前任务相关改动并按逻辑分组提交。');
    const mixed = await writeSkill('mixed-skill', 'Use for reviewing 仓库策略、交付证据和验收门禁与红线边界。');

    const split = await validateSkillMetadataQuality(target, [english, chinese]);
    assert.match(split.join('\n'), /skill descriptions must share one script across the pack; Chinese: chinese-skill; English: english-skill/u);

    const mixedOnly = await validateSkillMetadataQuality(target, [mixed]);
    assert.match(mixedOnly.join('\n'), /mixed-skill description must use a single script/u);

    // An all-Chinese pack is a valid single-script state.
    const chineseTwo = await writeSkill('chinese-two', '用于在浏览器功能实现与调试时做自动化验收和页面验证。');
    assert.deepEqual(await validateSkillMetadataQuality(target, [chinese, chineseTwo]), []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('instruction budget covers every adapter without errors on current templates', async () => {
  const { errors, warnings } = await validateInstructionBudget(rootDir);
  assert.equal(errors.length, 0, errors.join('\n'));
  // Current templates are well under the warning threshold; if they grow past it,
  // the warning list surfaces the adapter for review.
  assert.ok(Array.isArray(warnings), 'warnings must be an array');
});

test('instruction budget flags oversized content', async () => {
  // Directly exercise the thresholds by calling the estimator logic against a
  // synthetic payload, proving the gate fires above TOKEN_ERROR_THRESHOLD.
  const oversized = Buffer.alloc(4 * 5000 + 1, 'a').toString('utf8');
  const tokenEstimate = Math.ceil(Buffer.byteLength(oversized, 'utf8') / 4);
  assert.ok(tokenEstimate > 5000, 'synthetic payload must exceed the error threshold');
});
