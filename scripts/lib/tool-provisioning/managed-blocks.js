import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';

import { extractManagedBlock, removeManagedBlock, stripManagedBlock } from '../managed-block.js';

const managedMcpStart = '# VIBE_HARNESS:MCP:START';
const managedMcpEnd = '# VIBE_HARNESS:MCP:END';
const managedCbmIgnoreStart = '# VIBE_HARNESS:CBM:START';
const managedCbmIgnoreEnd = '# VIBE_HARNESS:CBM:END';

function tomlString(value) {
  return JSON.stringify(String(value));
}

function renderMcpServer(name, server) {
  const hasRemoteShape = server.url !== undefined;
  const hasLocalShape = server.command !== undefined || server.args !== undefined || server.env !== undefined;
  if (hasRemoteShape && hasLocalShape) {
    throw new Error('MCP server ' + name + ' must define exactly one of command or url.');
  }
  if (hasRemoteShape) {
    if (typeof server.url !== 'string' || server.url.length === 0) {
      throw new Error('MCP server ' + name + ' url must be a non-empty string.');
    }
    return ['[mcp_servers.' + name + ']', 'url = ' + tomlString(server.url)].join('\n');
  }
  if (typeof server.command !== 'string' || server.command.length === 0) {
    throw new Error('MCP server ' + name + ' must define exactly one of command or url.');
  }
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(', ')}]`,
  ];
  const entries = Object.entries(server.env ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 0) {
    lines.push('', `[mcp_servers.${name}.env]`);
    for (const [key, value] of entries) lines.push(`${key} = ${tomlString(value)}`);
  }
  return lines.join('\n');
}

function stripManagedMcpBlock(content) {
  return stripManagedBlock(content, managedMcpStart, managedMcpEnd);
}

export function extractManagedMcpBlock(content) {
  return extractManagedBlock(content, managedMcpStart, managedMcpEnd);
}

export function removeManagedMcpBlock(content) {
  return removeManagedBlock(content, managedMcpStart, managedMcpEnd);
}

export function mergeManagedMcpBlock(existingContent, servers, { force = false } = {}) {
  let unmanaged = stripManagedMcpBlock(existingContent);
  let parsedToml = null;
  let unmanagedServerNames = new Set();
  try {
    parsedToml = parseToml(unmanaged);
    const parsedServers = parsedToml.mcp_servers;
    if (parsedServers && typeof parsedServers === 'object') {
      unmanagedServerNames = new Set(Object.keys(parsedServers));
    }
  } catch {
    // Preserve malformed user content; the table-header check below still avoids known duplicates.
  }
  const conflicts = [];
  const rendered = [];
  let replacedUnmanagedServer = false;
  for (const [name, server] of Object.entries(servers).sort(([left], [right]) => left.localeCompare(right))) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const duplicate = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${escaped}|["']${escaped}["'])\\s*\\]\\s*(?:#.*)?$`, 'mu');
    if (unmanagedServerNames.has(name) || duplicate.test(unmanaged)) {
      if (!force || !parsedToml?.mcp_servers || !Object.hasOwn(parsedToml.mcp_servers, name)) {
        conflicts.push(name);
        continue;
      }
      delete parsedToml.mcp_servers[name];
      if (Object.keys(parsedToml.mcp_servers).length === 0) delete parsedToml.mcp_servers;
      replacedUnmanagedServer = true;
    }
    rendered.push(renderMcpServer(name, server));
  }
  if (replacedUnmanagedServer) unmanaged = stringifyToml(parsedToml).trimEnd();
  const block = [managedMcpStart, ...rendered.flatMap((item, index) => index === 0 ? [item] : ['', item]), managedMcpEnd].join('\n');
  const prefix = unmanaged.trimEnd();
  return {
    conflicts,
    content: `${prefix ? `${prefix}\n\n` : ''}${block}\n`,
  };
}

function findManagedCbmIgnoreBlock(content) {
  const starts = [...content.matchAll(new RegExp(managedCbmIgnoreStart, 'gu'))];
  const ends = [...content.matchAll(new RegExp(managedCbmIgnoreEnd, 'gu'))];
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error('Multiple Vibe-Harness codebase-memory ignore blocks are not allowed.');
  }
  const start = starts[0].index;
  const end = ends[0].index;
  if (end < start) throw new Error('Malformed Vibe-Harness codebase-memory ignore block.');
  return { end, start };
}

function stripManagedCbmIgnoreBlock(content) {
  const found = findManagedCbmIgnoreBlock(content);
  if (!found) return content;
  return `${content.slice(0, found.start)}${content.slice(found.end + managedCbmIgnoreEnd.length)}`
    .replace(/\n{3,}/gu, '\n\n');
}

export function extractManagedCbmIgnoreBlock(content) {
  const found = findManagedCbmIgnoreBlock(content);
  return found ? content.slice(found.start, found.end + managedCbmIgnoreEnd.length) : '';
}

export function removeManagedCbmIgnoreBlock(content) {
  const remaining = stripManagedCbmIgnoreBlock(content).trim();
  return remaining ? `${remaining}\n` : '';
}

export function mergeManagedCbmIgnoreBlock(existingContent, managedContent) {
  const unmanaged = stripManagedCbmIgnoreBlock(existingContent).trimEnd();
  const block = [managedCbmIgnoreStart, managedContent.trim(), managedCbmIgnoreEnd].join('\n');
  return `${unmanaged ? `${unmanaged}\n\n` : ''}${block}\n`;
}
