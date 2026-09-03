import {
  assertPluginProviderCatalog,
  pluginProviderCatalog,
  pluginProviderForAlias,
  pluginProviderForId,
  pluginProviderForModule,
  pluginProviders,
} from './plugin-provider-catalog.js';

export const moduleCatalog = {
  agents: { dependencies: [], groups: ['agents', 'agents-index'] },
  rules: { dependencies: [], groups: ['rules-minimal', 'rules-core', 'rules-full'] },
  templates: { dependencies: [], groups: ['templates-minimal'] },
  skills: { dependencies: ['agents', 'rules', 'templates'], groups: ['skills-core', 'skills-full'] },
  schemas: { dependencies: [], groups: ['schemas-core'] },
  evals: { dependencies: ['schemas'], groups: ['runtime-eval', 'runtime-eval-online', 'evals-core', 'evals-online'] },
  memory: { dependencies: ['skills'], groups: ['templates-memory', 'skills-memory'] },
  playwright: { dependencies: ['skills'], groups: ['skills-browser', 'tools-playwright'] },
  'chrome-devtools': { dependencies: ['skills'], groups: ['rules-chrome-devtools', 'skills-browser', 'tools-chrome-devtools', 'mcp-config'] },
  'codebase-memory': { dependencies: ['agents', 'rules'], groups: ['rules-codebase-memory', 'tools-codebase-memory', 'mcp-config'] },
  'open-code-review': { dependencies: ['skills'], groups: ['tools-open-code-review'] },
  rtk: { dependencies: ['agents', 'rules'], groups: ['rules-rtk', 'tools-rtk'] },
  'ast-grep': { dependencies: ['agents', 'rules'], groups: ['rules-ast-grep', 'tools-ast-grep'] },
  linear: { dependencies: ['skills'], groups: ['rules-linear', 'skills-linear', 'templates-linear', 'mcp-config'] },
  'linear-readonly': { dependencies: ['skills'], groups: ['rules-linear', 'skills-linear', 'templates-linear', 'mcp-config'] },
  hooks: { dependencies: ['agents'], groups: ['hooks'] },
  roles: { dependencies: ['agents', 'rules'], groups: ['roles'] },
};

assertPluginProviderCatalog(pluginProviderCatalog, { moduleIds: new Set(Object.keys(moduleCatalog)) });

const profileModules = {
  minimal: ['agents', 'rules', 'templates'],
  core: ['agents', 'rules', 'templates', 'skills', 'evals'],
  full: [
    'agents', 'rules', 'templates', 'skills', 'evals', 'hooks', 'roles',
  ],
  'docs-only': ['rules', 'templates', 'schemas'],
};

export const pluginModules = pluginProviders
  .filter((provider) => provider.selection.includeInAll)
  .map((provider) => provider.moduleId);

export function parseModulesOption(value) {
  if (typeof value !== 'string') throw new Error('--modules requires a comma-separated module list.');
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function parsePluginsOption(value) {
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values)) throw new Error('--plugin requires at least one plugin.');
  const tokens = values
    .flatMap((item) => typeof item === 'string' ? item.split(',') : [])
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.startsWith('-') ? item.slice(1) : item);
  if (tokens.length === 0) throw new Error('--plugin requires at least one plugin.');
  if (tokens.includes('all')) {
    if (tokens.length !== 1) throw new Error('plugin all cannot be combined with another plugin.');
    return [...pluginModules];
  }
  if (tokens.includes('none')) {
    if (tokens.length !== 1) throw new Error('plugin none cannot be combined with another plugin.');
    return [];
  }
  const plugins = tokens.map((token) => {
    const plugin = pluginProviderForAlias(token)?.moduleId;
    if (!plugin) throw new Error(`Unknown plugin: ${token}`);
    return plugin;
  });
  if (new Set(plugins).size !== plugins.length) throw new Error('plugins contains a duplicate plugin.');
  return plugins;
}

function conflictingProviders(moduleIds) {
  const selectedProviderIds = new Set(moduleIds
    .map((moduleId) => pluginProviderForModule(moduleId)?.id)
    .filter(Boolean));
  for (const provider of pluginProviders) {
    if (!selectedProviderIds.has(provider.id)) continue;
    const conflictId = (provider.conflicts ?? []).find((candidate) => selectedProviderIds.has(candidate));
    if (conflictId) return [provider, pluginProviderForId(conflictId)];
  }
  return null;
}

function validateModules(requestedModules) {
  if (!Array.isArray(requestedModules) || requestedModules.length === 0) {
    throw new Error('modules must contain at least one module.');
  }
  const unique = new Set(requestedModules);
  if (unique.size !== requestedModules.length) throw new Error('modules contains a duplicate module.');
  for (const id of requestedModules) {
    if (!Object.hasOwn(moduleCatalog, id)) throw new Error(`Unknown module: ${id}`);
  }
}

function resolveDependencies(moduleIds) {
  const selected = new Set();
  const visiting = new Set();
  const visit = (id) => {
    if (selected.has(id)) return;
    if (visiting.has(id)) throw new Error(`Module dependency cycle detected at ${id}.`);
    visiting.add(id);
    for (const dependency of moduleCatalog[id].dependencies) visit(dependency);
    visiting.delete(id);
    selected.add(id);
  };
  for (const id of moduleIds) visit(id);
  return selected;
}

export function resolveModuleSelection({
  profile,
  profileGroups = [],
  requestedModules,
  requestedPlugins,
  rolesEnabled,
  rtkHooksEnabled = false,
}) {
  const customModules = requestedModules !== undefined && requestedModules !== null;
  if (customModules) validateModules(requestedModules);
  let baseModules = customModules ? [...requestedModules] : [...(profileModules[profile] ?? [])];
  if (customModules && typeof rolesEnabled === 'boolean') {
    const moduleEnablesRoles = baseModules.includes('roles');
    if (moduleEnablesRoles !== rolesEnabled) {
      throw new Error('roles.enabled conflicts with the explicit modules selection; include roles or make the values agree.');
    }
  } else if (!customModules && rolesEnabled === true && !baseModules.includes('roles')) {
    baseModules.push('roles');
  } else if (!customModules && rolesEnabled === false) {
    baseModules = baseModules.filter((id) => id !== 'roles');
  }
  const baseSelection = resolveDependencies(baseModules);
  const plugins = requestedPlugins === undefined || requestedPlugins === null || requestedPlugins.length === 0
    ? []
    : parsePluginsOption(requestedPlugins);
  const conflict = conflictingProviders(plugins);
  if (conflict) {
    throw new Error(conflict[0].cliName + ' and ' + conflict[1].cliName + ' are mutually exclusive.');
  }
  if (rtkHooksEnabled && !plugins.includes('rtk')) {
    throw new Error('RTK hook integration requires the rtk plugin. Select --plugin -rtk.');
  }
  const pluginSelection = resolveDependencies(plugins);
  const integrationSelection = resolveDependencies(rtkHooksEnabled ? ['hooks'] : []);
  const selected = new Set([...baseSelection, ...pluginSelection, ...integrationSelection]);
  const resolvedModules = Object.keys(moduleCatalog).filter((id) => selected.has(id));
  const requested = new Set(customModules ? requestedModules : baseModules);
  const allowedGroups = customModules || profileGroups.length === 0
    ? new Set([...baseSelection].flatMap((id) => moduleCatalog[id].groups))
    : new Set(profileGroups);
  if (baseSelection.has('roles')) allowedGroups.add('roles');
  else allowedGroups.delete('roles');
  for (const group of [...pluginSelection].flatMap((id) => moduleCatalog[id].groups)) allowedGroups.add(group);
  for (const group of [...integrationSelection].flatMap((id) => moduleCatalog[id].groups)) allowedGroups.add(group);
  return {
    allowedGroups,
    implicitModules: resolvedModules.filter((id) => !requested.has(id) && !plugins.includes(id)),
    requestedModules: customModules ? [...requestedModules] : null,
    requestedPlugins: plugins,
    resolvedModules,
  };
}
