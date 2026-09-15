import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expandInstallPreset,
  installPresetCatalog,
  installPresets,
  parsePresetOption,
  resolveInstallSurface,
  validateInstallPresetCatalog,
} from '../scripts/lib/install-preset.js';
import { parsePluginsOption, pluginModules } from '../scripts/lib/module-selection.js';
import { defaultProjectConfig, parseTargetsOption, validateProjectConfig } from '../scripts/lib/project-config.js';

const everything = {
  id: 'everything',
  description: 'synthetic preset',
  profile: 'full',
  addModules: ['memory'],
  plugins: { all: true, add: ['linear'] },
  allowPreview: true,
  provision: true,
};

function catalogWith(overrides) {
  return { schemaVersion: 1, items: [{ ...everything, ...overrides }] };
}

function projectConfig(overrides = {}) {
  return {
    ...defaultProjectConfig,
    projectName: 'Sample',
    profile: 'full',
    targets: ['codex'],
    ...overrides,
  };
}

test('shipped install preset catalog is valid and selects every stable plugin plus linear', () => {
  assert.deepEqual(validateInstallPresetCatalog(installPresetCatalog, {
    profileIdSet: new Set(['minimal', 'core', 'full', 'docs-only']),
  }), []);
  assert.deepEqual(installPresets.map((preset) => preset.id), ['everything']);
  assert.deepEqual(parsePluginsOption('all'), pluginModules);
  assert.equal(parsePluginsOption('all').includes('linear'), false);
});

test('install preset catalog rejects unknown profiles, modules and plugins', () => {
  assert.match(
    validateInstallPresetCatalog(catalogWith({ profile: 'unknown' }), { profileIdSet: new Set(['full']) }).join('\n'),
    /references unknown profile: unknown/u,
  );
  assert.match(
    validateInstallPresetCatalog(catalogWith({ addModules: ['unknown-module'] })).join('\n'),
    /references unknown module: unknown-module/u,
  );
  assert.match(
    validateInstallPresetCatalog(catalogWith({ plugins: { all: true, add: ['unknown-plugin'] } })).join('\n'),
    /references unknown plugin: unknown-plugin/u,
  );
  assert.match(
    validateInstallPresetCatalog(catalogWith({ plugins: { all: false } })).join('\n'),
    /must include every plugin selected by --plugin all/u,
  );
  assert.match(
    validateInstallPresetCatalog({
      schemaVersion: 1,
      items: [everything, { ...everything, description: 'duplicate id' }],
    }).join('\n'),
    /Duplicate install preset id: everything/u,
  );
  assert.match(
    validateInstallPresetCatalog(catalogWith({ plugins: { all: true, add: ['linear', 'linear-mcp-readonly'] } })).join('\n'),
    /selects mutually exclusive plugins/u,
  );
});

test('everything expands to the full profile, every stable plugin, linear and memory', () => {
  assert.deepEqual(expandInstallPreset('everything'), {
    allowPreview: true,
    modules: ['agents', 'rules', 'templates', 'skills', 'evals', 'project-scripts', 'hooks', 'roles', 'memory'],
    plugins: [...pluginModules, 'linear'],
    preset: 'everything',
    profile: 'full',
    provision: true,
  });
  assert.throws(() => expandInstallPreset('unknown'), /Unknown preset: unknown/u);
  assert.throws(() => parsePresetOption(''), /--preset requires a preset id/u);
});

test('resolveInstallSurface expands the preset and keeps explicit selection otherwise', () => {
  const presetSurface = resolveInstallSurface({ config: projectConfig({ preset: 'everything' }) });
  assert.equal(presetSurface.preset, 'everything');
  assert.equal(presetSurface.profile, 'full');
  assert.equal(presetSurface.allowPreview, true);
  assert.equal(presetSurface.provision, true);
  assert.equal(presetSurface.provisionSource, 'preset');
  assert.deepEqual(presetSurface.plugins, [...pluginModules, 'linear']);

  const cliSurface = resolveInstallSurface({ args: { preset: 'everything' }, config: projectConfig({ profile: 'core' }) });
  assert.equal(cliSurface.preset, 'everything');
  assert.equal(cliSurface.profile, 'full');

  const explicitSurface = resolveInstallSurface({
    args: { plugin: ['rtk'], profile: 'core' },
    config: projectConfig({ profile: 'core' }),
  });
  assert.equal(explicitSurface.preset, null);
  assert.deepEqual(explicitSurface.plugins, ['rtk']);
  assert.equal(explicitSurface.allowPreview, false);
  assert.equal(explicitSurface.provision, false);
  assert.equal(explicitSurface.provisionSource, 'none');

  const stateSurface = resolveInstallSurface({
    config: projectConfig({ profile: 'core' }),
    installState: { requestedModules: ['agents'], requestedPlugins: ['ast-grep'] },
  });
  assert.deepEqual(stateSurface.plugins, ['ast-grep']);
  assert.deepEqual(stateSurface.modules, ['agents']);
});

test('preset selection rejects conflicting CLI selection and mismatched config', () => {
  assert.throws(
    () => resolveInstallSurface({ args: { preset: 'everything', plugin: ['none'] }, config: projectConfig() }),
    /cannot be combined with --plugin/u,
  );
  assert.throws(
    () => resolveInstallSurface({ args: { preset: 'everything', modules: 'memory' }, config: projectConfig() }),
    /cannot be combined with --modules/u,
  );
  assert.throws(
    () => resolveInstallSurface({ args: { preset: 'everything', profile: 'core' }, config: projectConfig() }),
    /cannot be combined with --profile core/u,
  );
  assert.throws(
    () => resolveInstallSurface({ config: projectConfig({ profile: 'core', preset: 'everything' }) }),
    /requires profile full, found core/u,
  );
  assert.throws(
    () => resolveInstallSurface({ args: { preset: 'everything' }, config: projectConfig({ profile: 'core', preset: 'everything' }) }),
    /requires profile full, found core/u,
  );
});

test('project config accepts the preset only on its own install surface', () => {
  assert.equal(validateProjectConfig(projectConfig({ preset: 'everything' })), true);
  assert.throws(
    () => validateProjectConfig(projectConfig({ preset: 'everything', plugins: ['rtk'] })),
    /remove plugins or drop the preset/u,
  );
  assert.throws(
    () => validateProjectConfig(projectConfig({ preset: 'everything', modules: ['memory'] })),
    /remove modules or drop the preset/u,
  );
  assert.throws(
    () => validateProjectConfig(projectConfig({ profile: 'core', preset: 'everything' })),
    /requires profile full, found core/u,
  );
  assert.throws(() => validateProjectConfig(projectConfig({ preset: 'unknown' })), /Unknown preset: unknown/u);
});

test('--targets parsing keeps order and rejects duplicates, unknown and empty values', () => {
  assert.deepEqual(parseTargetsOption('codex,zcode,opencode'), ['codex', 'zcode', 'opencode']);
  assert.deepEqual(parseTargetsOption('codex, zcode'), ['codex', 'zcode']);
  assert.deepEqual(parseTargetsOption(['codex', 'zcode,opencode']), ['codex', 'zcode', 'opencode']);
  assert.throws(() => parseTargetsOption('codex,codex'), /must not contain duplicate adapters/u);
  assert.throws(() => parseTargetsOption('codex,bogus'), /Unknown target: bogus/u);
  assert.throws(() => parseTargetsOption('codex,'), /comma-separated adapter list/u);
  assert.throws(() => parseTargetsOption(''), /comma-separated adapter list/u);
});
