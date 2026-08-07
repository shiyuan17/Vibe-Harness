import { applyEdits, modify, parse, printParseErrorCode } from 'jsonc-parser';

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

function syntaxFor(descriptor) {
  return descriptor.syntax ?? 'json';
}

function readJsonObject(content, descriptor = {}) {
  if (!content.trim()) return {};
  let parsed;
  if (syntaxFor(descriptor) === 'jsonc') {
    const errors = [];
    parsed = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0) {
      const details = errors.map((error) => printParseErrorCode(error.error) + ' at offset ' + error.offset).join(', ');
      throw new Error('Managed JSONC configuration is invalid: ' + details + '.');
    }
  } else {
    parsed = JSON.parse(content);
  }
  if (!isRecord(parsed)) throw new Error('Managed JSON configuration must contain an object.');
  return parsed;
}

function getAtPath(root, path, { create = false } = {}) {
  let current = root;
  for (const segment of path) {
    if (!Object.hasOwn(current, segment)) {
      if (!create) return undefined;
      current[segment] = {};
    } else if (!isRecord(current[segment])) {
      throw new Error('Managed JSON configuration path ' + path.join('.') + ' must contain an object.');
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

function formattingOptions(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const indent = content.match(/^[ \t]+(?=["}])/mu)?.[0] ?? '  ';
  return {
    eol,
    insertSpaces: !indent.includes('\t'),
    tabSize: indent.includes('\t') ? 1 : Math.max(1, indent.length),
  };
}

function applyJsoncValue(content, path, value) {
  const base = content.trim() ? content : '{}\n';
  return applyEdits(base, modify(base, path, value, { formattingOptions: formattingOptions(base) }));
}

function removeEmptyJsoncPath(content, path) {
  const parsed = readJsonObject(content, { syntax: 'jsonc' });
  const value = getAtPath(parsed, path);
  return isRecord(value) && Object.keys(value).length === 0
    ? applyJsoncValue(content, path, undefined)
    : content;
}

function mergeJsoncMcp(existingContent, descriptor, servers) {
  const root = readJsonObject(existingContent, descriptor);
  const container = getAtPath(root, descriptor.mcpPath);
  let content = existingContent.trim() ? existingContent : '{}\n';
  for (const name of Object.keys(managedMcpServers(container, descriptor.serverPrefix))) {
    content = applyJsoncValue(content, [...descriptor.mcpPath, name], undefined);
  }
  for (const [name, server] of Object.entries(servers)) {
    content = applyJsoncValue(content, [...descriptor.mcpPath, descriptor.serverPrefix + name], clone(server));
  }
  if (Object.keys(servers).length === 0) content = removeEmptyJsoncPath(content, descriptor.mcpPath);
  if (Object.keys(readJsonObject(content, descriptor)).length === 0 && !/\/\/|\/\*/u.test(content)) return '{}\n';
  return content.endsWith('\n') ? content : content + '\n';
}

export function managedJsonPayload(content, descriptor) {
  const root = readJsonObject(content, descriptor);
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
  if (syntaxFor(descriptor) === 'jsonc') {
    if (descriptor.hooksPath) throw new Error('Managed JSONC Hook configuration is not supported.');
    return mergeJsoncMcp(existingContent, descriptor, servers);
  }

  const root = readJsonObject(existingContent, descriptor);
  if (descriptor.mcpPath) {
    const container = getAtPath(root, descriptor.mcpPath, { create: true });
    const existing = managedMcpServers(container, descriptor.serverPrefix);
    for (const name of Object.keys(existing)) delete container[name];
    for (const [name, server] of Object.entries(servers)) {
      container[descriptor.serverPrefix + name] = clone(server);
    }
    deleteAtPathIfEmpty(root, descriptor.mcpPath);
  }
  if (descriptor.hooksPath) {
    const container = getAtPath(root, descriptor.hooksPath, { create: true });
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
  return JSON.stringify(root, null, 2) + '\n';
}

export function removeManagedJsonConfig(existingContent, descriptor) {
  return mergeManagedJsonConfig(existingContent, descriptor, { hooks: {}, servers: {} });
}
