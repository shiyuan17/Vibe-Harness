const retiredModules = new Set(['rtk', 'ast-grep', 'codegraph', 'serena', 'probe', 'codebase-memory']);
const retiredAliases = new Set([...retiredModules, 'serena-agent', 'codebase-memory-mcp']);

export const retiredToolGroups = new Set([
  'rules-rtk', 'tools-rtk', 'rules-ast-grep', 'tools-ast-grep',
  'rules-codegraph', 'rules-serena', 'rules-probe',
  'rules-codebase-memory', 'tools-codebase-memory',
]);

export function assertActiveToolSelection(value) {
  const name = String(value).replace(/^-/, '');
  if (retiredAliases.has(name)) {
    throw new Error(`Tool integration ${name} has been retired. Run install --upgrade to migrate existing installations; codebase-memory-mcp is now an externally managed tool with usage rules only.`);
  }
}

export function migrateRetiredTools(config, state) {
  const migrated = { ...config };
  const removed = [];
  for (const key of ['modules', 'plugins']) {
    const values = config[key] ?? (config.preset ? undefined : state?.[key === 'modules' ? 'requestedModules' : 'requestedPlugins']);
    if (!Array.isArray(values)) continue;
    const active = values.filter(value => !retiredAliases.has(String(value).replace(/^-/, '')));
    if (active.length !== values.length) {
      removed.push(...values.filter(value => !active.includes(value)).map(value => `${key}:${value}`));
      migrated[key] = active.length === 0 && key === 'modules' ? ['agents', 'rules'] : active;
    }
  }
  if (Object.hasOwn(config.hooks ?? {}, 'rtk')) {
    migrated.hooks = { ...config.hooks };
    delete migrated.hooks.rtk;
    removed.push('hooks.rtk');
  }
  return { config: migrated, removed };
}
