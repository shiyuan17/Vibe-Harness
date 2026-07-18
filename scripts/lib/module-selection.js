export const moduleCatalog = {
  agents: { dependencies: [], groups: ['agents'] },
  rules: { dependencies: [], groups: ['rules-minimal', 'rules-core', 'rules-full'] },
  templates: { dependencies: [], groups: ['templates-minimal', 'templates-core', 'templates-full'] },
  governance: { dependencies: [], groups: ['schemas-core', 'runtime-basic', 'runtime-task', 'runtime-full'] },
  skills: { dependencies: ['agents', 'rules', 'templates'], groups: ['skills-core', 'skills-full'] },
  memory: { dependencies: ['skills'], groups: ['templates-memory', 'skills-memory'] },
  playwright: { dependencies: ['skills'], groups: ['tools-playwright'] },
  'chrome-devtools': { dependencies: ['skills'], groups: ['rules-chrome-devtools', 'tools-chrome-devtools', 'mcp-config'] },
  'codebase-memory': { dependencies: ['agents', 'rules'], groups: ['rules-codebase-memory', 'tools-codebase-memory', 'mcp-config'] },
  'open-code-review': { dependencies: ['skills'], groups: ['tools-open-code-review'] },
  agentmemory: { dependencies: ['memory'], groups: ['tools-agentmemory', 'mcp-config'] },
  hooks: { dependencies: ['agents', 'governance'], groups: ['hooks'] },
};

const profileModules = {
  minimal: ['agents', 'rules', 'templates'],
  core: ['agents', 'rules', 'templates', 'governance', 'skills', 'playwright'],
  full: Object.keys(moduleCatalog),
  'docs-only': ['rules', 'templates'],
};

export function parseModulesOption(value) {
  if (typeof value !== 'string') throw new Error('--modules requires a comma-separated module list.');
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function resolveModuleSelection({ profile, profileGroups = [], requestedModules }) {
  if (requestedModules === undefined || requestedModules === null) {
    return {
      allowedGroups: new Set(profileGroups),
      implicitModules: [],
      requestedModules: null,
      resolvedModules: profileModules[profile] ?? [],
    };
  }
  if (!Array.isArray(requestedModules) || requestedModules.length === 0) {
    throw new Error('modules must contain at least one module.');
  }
  const unique = new Set(requestedModules);
  if (unique.size !== requestedModules.length) throw new Error('modules contains a duplicate module.');
  for (const id of requestedModules) {
    if (!Object.hasOwn(moduleCatalog, id)) throw new Error(`Unknown module: ${id}`);
  }

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
  for (const id of requestedModules) visit(id);

  const resolvedModules = Object.keys(moduleCatalog).filter((id) => selected.has(id));
  const requested = new Set(requestedModules);
  return {
    allowedGroups: new Set(resolvedModules.flatMap((id) => moduleCatalog[id].groups)),
    implicitModules: resolvedModules.filter((id) => !requested.has(id)),
    requestedModules: [...requestedModules],
    resolvedModules,
  };
}
