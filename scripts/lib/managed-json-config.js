function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function readJsonObject(content) {
  if (!content.trim()) return {};
  const parsed = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error('Managed JSON configuration must contain an object.');
  return parsed;
}

function getAtPath(root, path, { create = false } = {}) {
  let current = root;
  for (const segment of path) {
    if (!isRecord(current[segment])) {
      if (!create) return undefined;
      if (Object.hasOwn(current, segment)) {
        throw new Error(`Managed JSON configuration path ${path.join('.')} must contain an object.`);
      }
      current[segment] = {};
    }
    current = current[segment];
  }
  return current;
}

function deleteAtPathIfEmpty(root, path) {
  if (path.length === 0) return;
  const parents = [];
  let current = root;
  for (const segment of path) {
    if (!isRecord(current[segment])) return;
    parents.push([current, segment]);
    current = current[segment];
  }
  for (const [parent, segment] of parents.reverse()) {
    if (isRecord(parent[segment]) && Object.keys(parent[segment]).length === 0) delete parent[segment];
    else break;
  }
}

function managedHookGroups(value, hookMarker) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([event, groups]) => [event, Array.isArray(groups)
      ? groups.filter((group) => Array.isArray(group?.hooks)
        && group.hooks.some((hook) => hook?.statusMessage === hookMarker))
      : []])
    .filter(([, groups]) => groups.length > 0));
}

function managedMcpServers(value, serverPrefix) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([name]) => name.startsWith(serverPrefix)));
}

export function managedJsonPayload(content, descriptor) {
  const root = readJsonObject(content);
  const payload = {};
  if (descriptor.mcpPath) {
    payload.mcpServers = managedMcpServers(getAtPath(root, descriptor.mcpPath), descriptor.serverPrefix);
  }
  if (descriptor.hooksPath) {
    payload.hooks = managedHookGroups(getAtPath(root, descriptor.hooksPath), descriptor.hookMarker);
  }
  return JSON.stringify(stableValue(payload));
}

export function hasManagedJsonPayload(content, descriptor) {
  const payload = JSON.parse(managedJsonPayload(content, descriptor));
  return Object.values(payload).some((value) => isRecord(value) && Object.keys(value).length > 0);
}

export function mergeManagedJsonConfig(existingContent, descriptor, { hooks = {}, servers = {} } = {}) {
  const root = readJsonObject(existingContent);
  if (descriptor.mcpPath) {
    const container = getAtPath(root, descriptor.mcpPath, { create: true });
    const existing = managedMcpServers(container, descriptor.serverPrefix);
    for (const name of Object.keys(existing)) delete container[name];
    for (const [name, server] of Object.entries(servers)) {
      container[`${descriptor.serverPrefix}${name}`] = clone(server);
    }
    deleteAtPathIfEmpty(root, descriptor.mcpPath);
  }
  if (descriptor.hooksPath) {
    const container = getAtPath(root, descriptor.hooksPath, { create: true });
    if (!isRecord(container)) throw new Error('Managed Hook configuration path must contain an object.');
    for (const [event, groups] of Object.entries(container)) {
      if (!Array.isArray(groups)) continue;
      const remaining = groups.filter((group) => !Array.isArray(group?.hooks)
        || !group.hooks.some((hook) => hook?.statusMessage === descriptor.hookMarker));
      if (remaining.length > 0) container[event] = remaining;
      else delete container[event];
    }
    for (const [event, groups] of Object.entries(hooks)) {
      const current = Array.isArray(container[event]) ? container[event] : [];
      container[event] = [...current, ...clone(groups)];
    }
    deleteAtPathIfEmpty(root, descriptor.hooksPath);
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function removeManagedJsonConfig(existingContent, descriptor) {
  return mergeManagedJsonConfig(existingContent, descriptor, { hooks: {}, servers: {} });
}
