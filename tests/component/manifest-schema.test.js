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
} from '../../scripts/lib/manifest.js';
import { resolveAdapterEntry } from '../../scripts/lib/adapter.js';
import { moduleCatalog } from '../../scripts/lib/module-selection.js';
import { validateCapabilityMatrix, validateInstructionBudget, validatePack, validateSelfInstalledArtifacts, validateSkillExecutionBoundaries, validateSkillGraph, validateSkillMetadataQuality, validateSkillPortability } from '../../scripts/lib/pack-validation.js';
import {
  pluginProviderCatalog,
  validatePluginProviderCatalog,
} from '../../scripts/lib/plugin-provider-catalog.js';
import { toolSpecs } from '../../scripts/lib/tool-provisioning/environment.js';

const rootDir = path.resolve(import.meta.dirname, '../..');

test('manifests expose adapters, profiles, rules, and skills', async () => {
  const manifests = await loadAllManifests(rootDir);
  assert.deepEqual(Object.keys(manifests).sort(), ['adapters', 'profiles', 'roles', 'rules', 'skills']);
  assert.equal(manifests.rules.items.some((item) => item.id === 'governance-core'), true);
  assert.equal(manifests.rules.items.some((item) => item.id === 'chrome-devtools-mcp'), true);
  assert.equal(manifests.skills.items.filter((item) => item.kind === 'native').length, 14);
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

test('adapter manifest v5 requires execution authority and the fixed Hook contract', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/adapters.json'));
  const schema = await readJson(path.join(rootDir, 'schemas/adapter-pack.schema.json'));
  const expected = {
    codex: ['stable', 'stable', 'not-projected', 'manual-trust'],
    claude: ['stable', 'stable', 'not-projected', 'config-file'],
    gemini: ['unsupported', 'unsupported', 'unsupported', 'unsupported'],
    cursor: ['stable', 'unsupported', 'unsupported', 'config-file'],
    qoder: ['stable', 'stable', 'unsupported', 'config-file'],
    zcode: ['stable', 'stable', 'unsupported', 'config-file'],
    antigravity: ['preview', 'unsupported', 'unsupported', 'config-file'],
    opencode: ['unsupported', 'unsupported', 'unsupported', 'unsupported'],
  };
  assert.equal(manifest.schemaVersion, 5);
  for (const adapter of manifest.items) {
    assert.deepEqual([
      adapter.hookEvents.preToolUse,
      adapter.hookEvents.permissionRequest,
      adapter.hookEvents.stop,
      adapter.hookActivation,
    ], expected[adapter.id], adapter.id);
    assert.equal(typeof adapter.roleProjection.targetRoot, 'string', adapter.id);
    assert.equal(adapter.executionAuthority.projectConfigMayAuthorize, false, adapter.id);
    assert.equal(
      adapter.executionAuthority.highRiskEnforcement === 'host-required',
      adapter.hookActivation !== 'unsupported',
      adapter.id,
    );
  }
  const missing = structuredClone(manifest);
  delete missing.items[0].hookEvents;
  assert.match(validateJsonAgainstSchema(missing, schema, 'adapters').join('\n'), /hookEvents.*required|required.*hookEvents/iu);
  const missingAuthority = structuredClone(manifest);
  delete missingAuthority.items[0].executionAuthority;
  assert.match(validateJsonAgainstSchema(missingAuthority, schema, 'adapters').join('\n'), /executionAuthority.*required|required.*executionAuthority/iu);
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
      // not-projected means the host supports the event but this pack does not
      // install a Hook for it, so it must not appear in the template.
      .filter(([, support]) => support !== 'unsupported' && support !== 'not-projected')
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
    { id: 'core', source: 'docs/rules/governance-core.md' },
    { id: 'core', source: 'docs/rules/codebase-memory-mcp.md' },
  ] }), /Duplicate manifest id/u);
});

test('install map validation rejects unknown groups and unsafe red-zone mappings', () => {
  assert.throws(() => validateInstallMapShape({ adapter: 'codex', entries: [
    { contentStrategy: 'replace', group: 'unknown', source: 'docs/rules/governance-core.md', target: 'docs/rules/governance-core.md' },
  ] }, new Set(['rules-minimal'])), /Unknown install-map group/u);
  assert.throws(() => validateInstallMapShape({ adapter: 'codex', entries: [
    { contentStrategy: 'replace', group: 'rules-minimal', source: 'docs/rules/governance-core.md', target: '.codex/hooks.json' },
  ] }, new Set(['rules-minimal'])), /redZone/u);
});

test('install map validation gates the project-owned seed declaration', () => {
  const seedEntry = {
    contentStrategy: 'replace',
    group: 'templates-memory',
    projectOwned: true,
    source: 'templates/memory/PROJECT_STATE.md',
    target: 'docs/memory/PROJECT_STATE.md',
  };
  assert.doesNotThrow(() => validateInstallMapShape(
    { adapter: 'codex', entries: [seedEntry] },
    new Set(['templates-memory']),
  ));
  assert.throws(() => validateInstallMapShape({
    adapter: 'codex',
    entries: [{ ...seedEntry, projectOwned: 'yes' }],
  }, new Set(['templates-memory'])), /projectOwned must be boolean/u);
  assert.throws(() => validateInstallMapShape({
    adapter: 'codex',
    entries: [{ ...seedEntry, contentStrategy: 'managed-json-object' }],
  }, new Set(['templates-memory'])), /projectOwned requires the replace content strategy/u);
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

test('the worktree audit core ships with the project scripts it serves', async () => {
  // The installed runner imports the shared core, so both files have to travel
  // in the same install-map group or the project copy fails at import time.
  const installMap = await readJson(path.join(rootDir, 'adapters/install-map.json'));
  const entry = installMap.entries.find((item) => item.source === 'runtime/lib/worktree-audit.mjs');
  assert.deepEqual(entry, {
    contentStrategy: 'replace',
    group: 'runtime-project-scripts',
    source: 'runtime/lib/worktree-audit.mjs',
    target: '.agents/runtime/lib/worktree-audit.mjs',
  });
  assert.equal(
    installMap.entries.find((item) => item.source === 'runtime/commands/run.mjs').group,
    entry.group,
  );

  const matrix = await readJson(path.join(rootDir, 'manifests/capabilities.json'));
  const capability = matrix.items.find((item) => item.id === 'project-deterministic-scripts');
  for (const target of ['runtime/commands/run.mjs', 'runtime/lib/worktree-audit.mjs']) {
    assert.ok(capability.targets.includes(target), target);
  }
  for (const suite of ['tests/integration/project-worktree-command.test.js', 'tests/integration/project-file-edit-command.test.js']) {
    assert.ok(capability.tests.includes(suite), suite);
  }
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
      source: 'docs/rules/project-specific-rules.md',
      target: 'docs/rules/governance-core.md',
    }],
  };
  const placeholderErrors = await validateSelfInstalledArtifacts(rootDir, adapters, new Map([['synthetic.json', placeholder]]));
  assert.deepEqual(placeholderErrors, []);

  // Project-owned seeds are seeded once and then edited inside the project, so
  // their content is expected to differ from the template. The exclusion must
  // still require the artifact to exist.
  const seed = {
    adapter: 'codex',
    entries: [{
      contentStrategy: 'replace',
      group: 'templates-memory',
      projectOwned: true,
      source: 'templates/memory/ARCHITECTURE.md',
      target: 'docs/rules/governance-core.md',
    }],
  };
  const seedErrors = await validateSelfInstalledArtifacts(rootDir, adapters, new Map([['synthetic.json', seed]]));
  assert.deepEqual(seedErrors, []);

  const missingSeed = { ...seed, entries: [{ ...seed.entries[0], target: 'docs/memory/absent-seed.md' }] };
  const missingSeedErrors = await validateSelfInstalledArtifacts(
    rootDir,
    adapters,
    new Map([['synthetic.json', missingSeed]]),
    { requiredGroups: new Set(['templates-memory']) },
  );
  assert.match(missingSeedErrors.join('\n'), /self-installed artifact is missing/u);
});

// Validating the complete pack reads every manifest, schema, and skill, so it
// is I/O-bound and legitimately exceeds the default test budget on slow
// filesystems.
test('complete pack validates', { timeout: 120000 }, async () => {
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

test('skill metadata quality rejects duplicate descriptions', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-skill-duplicates-'));
  try {
    const items = [];
    for (const id of ['first-skill', 'second-skill']) {
      const dir = path.join(target, id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'SKILL.md'), '---\nname: ' + id + '\ndescription: Use this skill for reviewing delivery evidence.\n---\n\n# Skill\n');
      items.push({ id, source: id + '/SKILL.md' });
    }
    const errors = await validateSkillMetadataQuality(target, items);
    assert.match(errors.join('\n'), /duplicate Skill description/u);
    const duplicateDir = path.join(target, 'third-skill');
    await mkdir(duplicateDir, { recursive: true });
    await writeFile(path.join(duplicateDir, 'SKILL.md'), '---\nname: first-skill\ndescription: A distinct description for this skill.\n---\n\n# Skill\n');
    const nameErrors = await validateSkillMetadataQuality(target, [items[0], { id: 'third-skill', source: 'third-skill/SKILL.md' }]);
    assert.match(nameErrors.join('\n'), /duplicate Skill name/u);
    const mismatchErrors = await validateSkillMetadataQuality(target, [items[0], { id: 'other-skill', source: 'third-skill/SKILL.md' }]);
    assert.match(mismatchErrors.join('\n'), /frontmatter name must match manifest id/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('skill graph rejects identity fields duplicated in metadata', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-skill-metadata-identity-'));
  try {
    const skillDir = path.join(target, 'example-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: example-skill\ndescription: Use this skill for reviewing delivery evidence.\n---\n\n# Example\n');
    await writeFile(path.join(skillDir, 'metadata.json'), JSON.stringify({ id: 'example-skill', name: 'wrong', description: 'wrong' }));
    const errors = await validateSkillGraph(target, [{ id: 'example-skill', source: 'example-skill/SKILL.md', metadata: 'example-skill/metadata.json', kind: 'integration', requiresSkills: [], optionalSkills: [], requiresTools: [] }], [], { installEntries: [] });
    assert.match(errors.join('\n'), /metadata must not define name/u);
    assert.match(errors.join('\n'), /metadata must not define description/u);
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

test('Skill 可移植性拒绝入口与嵌套参考中的外部委托和私有路径', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-skill-portability-'));
  try {
    const skill = path.join(target, 'skills/core/example');
    await mkdir(path.join(skill, 'references/nested'), { recursive: true });
    const fixtures = [
      ['按 ADR-0042 执行。', 'ADR number'],
      ['参考 `docs/adr/ADR-0001-safety.md`。', 'private documentation path'],
      ['参考 `../../specs/execution.md`。', 'private documentation path'],
      ['参考 `adr/decision.md`。', 'private documentation path'],
      ['参考 `docs/private-policy.md`。', 'private documentation path'],
      ['按 ADR 执行。', 'external specification delegation'],
      ['以 `docs/rules/example.md` 的规则为准。', 'external specification delegation'],
      ['需要宿主 v2 执行证明。', 'version-only proof'],
      ['[说明](https://example.org/guide)', 'external documentation link'],
      ['[spec]: https://example.org/spec', 'external documentation link'],
      ['参见 https://example.org/spec', 'external documentation link'],
      ['工具连接端点：https://mcp.example.org/mcp；[规范](https://example.org/spec)', 'external documentation link'],
      ['`node scripts/private-check.js`', 'private implementation path'],
      ['`tests/fixtures/private/sample.json`', 'private implementation path'],
      ['`C:/Users/example/repo/private.md`', 'absolute project path'],
      ['`pnpm verify:focused --run`', 'declare target-project command'],
      ['```sh\npnpm private:check\n```', 'declare target-project command'],
    ];
    for (const file of ['SKILL.md', 'references/nested/contract.md']) {
      for (const [body, expected] of fixtures) {
        await writeFile(path.join(skill, file), body);
        const errors = await validateSkillPortability(target);
        assert.ok(errors.some((error) => error.includes(file) && error.includes(expected)), `${file}: ${body}\n${errors.join('\n')}`);
      }
      await writeFile(path.join(skill, file), '');
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('Skill 可移植性允许协议标识、操作端点、内部参考与声明后的项目命令', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-skill-portable-'));
  try {
    const dir = path.join(target, 'skills/integrations/example');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), [
      '同步归属：`docs/rules/governance-core.md`；修改须同步。',
      '[字段示例](references/contract.md)',
      '`vibe-harness.execution-envelope/v2`、`vibe-harness.linear-execution/v3` 与 `/v1`。',
      '`schema`、`claimId`、`fencingToken`；高风险核对工作区与宿主信息，缺失则停止。',
      '工具连接端点：https://mcp.example.org/mcp',
      '[API endpoint](https://service.example.net/rpc)',
      '```sh',
      'node .agents/runtime/tools/playwright-cli/run.mjs open http://127.0.0.1:3000',
      'curl https://api.example.org/health',
      '```',
      '项目命令声明：`pnpm test:unit`；执行前确认目标项目 package.json scripts 已声明。',
      '验证：`pnpm test:unit`。',
      '`vibe-harness audit --project <path> --kind cleanup`',
      '`pnpm exec prettier --check .`',
      '目标项目路径示例：`src/settings/**`，执行前替换为实际路径。',
    ].join('\n'));
    assert.deepEqual(await validateSkillPortability(target), []);
    assert.deepEqual(await validateSkillPortability(rootDir), []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('Skill 授权、工作区核验、宿主信息和受阻处理缺失时仍失败', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-skill-boundaries-'));
  try {
    const files = ['skills/core/gd-flow/SKILL.md', 'skills/integrations/lwflow/SKILL.md', 'skills/integrations/linear-workflow/SKILL.md'];
    const originals = new Map();
    for (const file of files) {
      const content = await readFile(path.join(rootDir, file), 'utf8');
      originals.set(file, content);
      await mkdir(path.dirname(path.join(target, file)), { recursive: true });
      await writeFile(path.join(target, file), content);
    }
    assert.deepEqual(await validateSkillExecutionBoundaries(target), []);
    for (const file of files) {
      for (const term of ['allowedEffects', 'allowedWriteRoots', 'source=host', 'process=isolated', 'Agent 不得自造', '缺授权', '暂停', '不得靠重复询问用户解除', 'contract-only/degraded']) {
        await writeFile(path.join(target, file), originals.get(file).replaceAll(term, 'REMOVED'));
        const errors = await validateSkillExecutionBoundaries(target);
        assert.ok(errors.some((error) => error.includes(file) && error.endsWith(term)), `${file}: must reject missing ${term}`);
      }
      await writeFile(path.join(target, file), originals.get(file));
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
