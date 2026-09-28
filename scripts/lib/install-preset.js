import { readFileSync } from 'node:fs';
import path from 'node:path';

import { moduleCatalog, parseModulesOption, parsePluginsOption, pluginModules, profileModuleIds } from './module-selection.js';
import { pluginProviderForAlias, pluginProviderForId, pluginProviderForModule } from './plugin-provider-catalog.js';
import { validateJsonAgainstSchema } from './schema-validation.js';

const rootDir = path.resolve(import.meta.dirname, '..', '..');
const catalogPath = path.join(rootDir, 'manifests', 'install-presets.json');
const schemaPath = path.join(rootDir, 'schemas', 'install-preset.schema.json');
const profilesPath = path.join(rootDir, 'manifests', 'profiles.json');

const catalogSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const profileIds = new Set(JSON.parse(readFileSync(profilesPath, 'utf8')).items.map((item) => item.id));
const moduleIds = new Set(Object.keys(moduleCatalog));

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/** @param {any} catalog @param {{moduleIdSet?: Set<string>, profileIdSet?: Set<string>}} options */
export function validateInstallPresetCatalog(catalog, { moduleIdSet = moduleIds, profileIdSet = profileIds } = {}) {
  const errors = validateJsonAgainstSchema(catalog, catalogSchema, 'install-presets');
  if (errors.length > 0) return errors;

  const seenIds = new Set();
  for (const item of catalog.items) {
    if (seenIds.has(item.id)) errors.push('Duplicate install preset id: ' + item.id);
    seenIds.add(item.id);
    if (!profileIdSet.has(item.profile)) {
      errors.push('Install preset ' + item.id + ' references unknown profile: ' + item.profile);
    }
    for (const moduleId of item.addModules ?? []) {
      if (!moduleIdSet.has(moduleId)) {
        errors.push('Install preset ' + item.id + ' references unknown module: ' + moduleId);
      }
    }
    if (!item.plugins.all) {
      errors.push('Install preset ' + item.id + ' must include every plugin selected by --plugin all');
    }
    const selectedProviders = [];
    for (const alias of item.plugins.add ?? []) {
      const provider = pluginProviderForAlias(alias);
      if (!provider) {
        errors.push('Install preset ' + item.id + ' references unknown plugin: ' + alias);
        continue;
      }
      if (!moduleIdSet.has(provider.moduleId)) {
        errors.push('Install preset ' + item.id + ' references plugin without an install module: ' + alias);
      }
      selectedProviders.push(provider);
    }
    const conflict = findProviderConflict([
      ...pluginModules.map((moduleId) => pluginProviderForModule(moduleId)),
      ...selectedProviders,
    ]);
    if (conflict) {
      errors.push('Install preset ' + item.id + ' selects mutually exclusive plugins: '
        + conflict[0].cliName + ' and ' + conflict[1].cliName);
    }
  }
  return errors;
}

export function assertInstallPresetCatalog(catalog, options) {
  const errors = validateInstallPresetCatalog(catalog, options);
  if (errors.length > 0) throw new Error('Invalid install preset catalog:\n' + errors.join('\n'));
}

// Mirrors the module-selection conflict check so an aggregate preset cannot
// select two mutually exclusive providers (for example linear and
// linear-readonly) that the CLI itself refuses to combine.
function findProviderConflict(providers) {
  const selectedIds = new Set(providers.filter(Boolean).map((provider) => provider.id));
  for (const provider of providers) {
    if (!provider) continue;
    const conflictId = (provider.conflicts ?? []).find((candidate) => selectedIds.has(candidate));
    if (conflictId) return [provider, pluginProviderForId(conflictId)];
  }
  return null;
}

const loadedCatalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
assertInstallPresetCatalog(loadedCatalog);

export const installPresetCatalog = deepFreeze(loadedCatalog);
export const installPresets = installPresetCatalog.items;

const presetById = new Map(installPresets.map((preset) => [preset.id, preset]));

export function installPresetForId(id) {
  return presetById.get(id) ?? null;
}

export function parsePresetOption(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('--preset requires a preset id.');
  }
  const id = value.trim();
  if (!installPresetForId(id)) {
    throw new Error('Unknown preset: ' + id + '. Available presets: ' + installPresets.map((preset) => preset.id).join(', ') + '.');
  }
  return id;
}

/** @param {string} presetId */
export function expandInstallPreset(presetId) {
  const preset = installPresetForId(parsePresetOption(presetId));
  const plugins = [
    ...(preset.plugins.all ? pluginModules : []),
    ...(preset.plugins.add ?? []).map((alias) => {
      const provider = pluginProviderForAlias(alias);
      if (!provider) throw new Error('Install preset ' + preset.id + ' references unknown plugin: ' + alias);
      return provider.moduleId;
    }),
  ];
  if (new Set(plugins).size !== plugins.length) {
    throw new Error('Install preset ' + preset.id + ' contains a duplicate plugin.');
  }
  return {
    allowPreview: Boolean(preset.allowPreview),
    modules: [...profileModuleIds(preset.profile), ...(preset.addModules ?? [])],
    plugins,
    preset: preset.id,
    profile: preset.profile,
    provision: Boolean(preset.provision),
  };
}

function assertPresetSelectionAgreement({ args, preset }) {
  const conflicts = [
    ...(args.profile !== undefined && args.profile !== preset.profile ? ['--profile ' + args.profile] : []),
    ...(args.modules !== undefined ? ['--modules'] : []),
    ...(args.plugin !== undefined ? ['--plugin'] : []),
  ];
  if (conflicts.length > 0) {
    throw new Error('preset ' + preset.id + ' already declares the profile, plugins, and modules; it cannot be combined with '
      + conflicts.join(', ') + '. Remove --preset or use explicit selection.');
  }
}

/**
 * Resolves the effective install surface for one project.
 *
 * The install surface is a project property: vibe-harness.config.json wins when
 * it declares one, otherwise the selection recorded by the last install is
 * authoritative. Every lifecycle command (install, provision, validate, doctor,
 * diff, verify, baseline) resolves it through here so a replay plans the same
 * surface the project was installed with instead of recomputing it from the
 * current profile, which would silently retire modules the project still asks
 * for.
 *
 * @param {{args?: Record<string, any>, config?: Record<string, any>, installState?: any}} options
 */
export function resolveInstallSurface({ args = {}, config = {}, installState } = {}) {
  const cliPreset = args.preset === undefined ? null : parsePresetOption(args.preset);
  const configPreset = config.preset === undefined || config.preset === null
    ? null
    : parsePresetOption(config.preset);
  if (cliPreset && configPreset && cliPreset !== configPreset) {
    throw new Error('--preset ' + cliPreset + ' does not match the project preset ' + configPreset + '.');
  }
  const presetId = cliPreset ?? configPreset;

  if (!presetId) {
    return {
      allowPreview: Boolean(args['allow-preview']),
      allowPreviewSource: args['allow-preview'] ? 'cli' : 'none',
      modules: args.modules !== undefined
        ? parseModulesOption(args.modules)
        : (config.modules ?? installState?.requestedModules),
      plugins: args.plugin !== undefined
        ? parsePluginsOption(args.plugin)
        : (config.plugins ? parsePluginsOption(config.plugins) : installState?.requestedPlugins),
      preset: null,
      profile: args.profile ?? config.profile,
      provision: Boolean(args.provision),
      provisionSource: args.provision ? 'cli' : 'none',
    };
  }

  const preset = installPresetForId(presetId);
  assertPresetSelectionAgreement({ args, preset });
  if (configPreset && config.profile !== preset.profile) {
    throw new Error('vibe-harness.config.json preset ' + preset.id + ' requires profile '
      + preset.profile + ', found ' + config.profile + '. Fix the profile or drop the preset.');
  }
  const expanded = expandInstallPreset(preset.id);
  return {
    ...expanded,
    allowPreviewSource: 'preset',
    provisionSource: args.provision ? 'cli' : 'preset',
  };
}
