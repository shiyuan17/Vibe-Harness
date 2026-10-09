import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseToml } from '@iarna/toml';

import { loadAdapterCatalog } from './adapter.js';
import { assertInsideDir, assertPortableRelativePath, assertSafePathInside } from './manifest.js';
import { readOnlyCommandPrefixes } from '../../runtime/hooks/lib/read-only-commands.mjs';
import { loadRolePack, MANAGED_MCP_SERVER_PREFIX, projectRole } from './role-projection.js';

const REQUIRED_ROLE_SECTIONS = ['## 决策方式', '## 质疑重点', '## 交付物', '## 禁止事项'];
// Audit-side expectations, kept independent of the projection helpers so a
// mapping regression in role-projection.js is still caught here.
const AUDIT_WRITE_PRESETS = new Set(['implementation']);
const AUDIT_EXECUTE_PRESETS = new Set(['implementation', 'verification', 'release-readiness']);
const AUDIT_PLAN_MODE_PRESETS = new Set(['analysis']);
const AUDIT_MAX_DESCRIPTION_LENGTH = 300;
const AUDIT_EXPLICIT_DESCRIPTION_PREFIX = '[Explicit invocation only; do not auto-select. ';
const AUDIT_ASCII_PATTERN = /^[\x20-\x7e]+$/u;
// The read-only command table is runtime policy, not a projection helper, so the
// audit may reuse it; everything else below restates the host contract by hand.
const AUDIT_READ_ONLY_COMMANDS = new Set(readOnlyCommandPrefixes());
const AUDIT_CAPABILITY_HOSTS = new Set(['claude', 'gemini', 'qoder', 'zcode']);
const AUDIT_CAPABILITIES = {
  mcpServers: [MANAGED_MCP_SERVER_PREFIX + 'linear'],
  skills: ['browser-verification'],
};
const AUDIT_ANTIGRAVITY_TOOLS = new Set([
  'grep_search', 'list_dir', 'replace_file_content', 'run_command', 'view_file', 'write_to_file',
]);
const AUDIT_WRITE_TOOL = {
  'claude-markdown': '"Write"',
  'zcode-plugin-markdown': '"Write"',
  'gemini-markdown': '"write_file"',
  'antigravity-markdown': '"replace_file_content"',
};
const AUDIT_RUN_TOOL = {
  'claude-markdown': '"Bash"',
  'zcode-plugin-markdown': '"Bash"',
  'gemini-markdown': '"run_shell_command"',
  'antigravity-markdown': '"run_command"',
};
const AUDIT_OPENCODE_DENY_KEYS = ['task', 'webfetch', 'websearch'];
const AUDIT_OPENCODE_DISABLED_BASH = /^ {4}"\*": deny$/mu;
const AUDIT_DESCRIPTION_FIELD = /^description: (.+)$/mu;
const AUDIT_NAME_FIELD = /^name: (.+)$/mu;

function normalizeRoleContent(content) {
  return content.replace(/\r\n?/gu, '\n').trim();
}

export function findDuplicateRoleContents(entries = []) {
  const owners = new Map();
  const duplicates = [];
  for (const entry of entries) {
    const raw = typeof entry === 'string' ? entry : entry.content ?? '';
    const normalized = normalizeRoleContent(raw);
    const id = typeof entry === 'string' ? entry : entry.id ?? normalized;
    const owner = owners.get(normalized);
    if (owner && owner !== id) duplicates.push([owner, id]);
    else owners.set(normalized, id);
  }
  return duplicates;
}

function parseFrontmatter(content, label) {
  if (!content.startsWith('---\n')) throw new Error(label + ' must start with YAML frontmatter.');
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) throw new Error(label + ' has unterminated YAML frontmatter.');
  const header = content.slice(4, end);
  if (!/(?:^|\n)(?:name|description):/u.test(header)) {
    throw new Error(label + ' is missing identifying frontmatter.');
  }
  return header;
}

function frontmatterScalar(header, name) {
  const match = header.match(new RegExp('^' + name + ': (.+)$', 'mu'));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return match[1].trim();
  }
}

function frontmatterList(header, name) {
  const inline = header.match(new RegExp('^' + name + ': (.+)$', 'mu'));
  if (inline) {
    const trimmed = inline[1].trim();
    if (trimmed === '[]') return [];
    return JSON.parse(trimmed);
  }
  const block = header.match(new RegExp('(?:^|\\n)' + name + ':\\n((?:[ \\t]+- .+\\n?)+)', 'u'));
  if (!block) return null;
  return block[1].split('\n').filter(Boolean).map((line) => line.replace(/^\s*- /u, '').trim());
}

function projectedHeader(content, adapter, role) {
  return adapter.roleProjection.format === 'codex-toml'
    ? null
    : parseFrontmatter(content, adapter.id + ' projection for ' + role.id);
}

/**
 * Rebuilds the shared description from the manifest fields instead of calling
 * the projection helper, so a regression in the helper is caught here rather
 * than reproduced.
 */
function expectedRoleDescription(role) {
  const explicit = role.routing?.mode === 'explicit';
  return (explicit ? AUDIT_EXPLICIT_DESCRIPTION_PREFIX : '')
    + role.description
    + ' Triggers: ' + role.routing.when.join('; ')
    + '. Avoid: ' + role.routing.avoid.join('; ')
    + '.';
}

function auditRoleDescription(role, adapter, projected, header) {
  const errors = [];
  const expected = expectedRoleDescription(role);
  const actual = adapter.roleProjection.format === 'codex-toml'
    ? parseToml(projected).description
    : frontmatterScalar(header, 'description');
  if (actual !== expected) {
    errors.push(adapter.id + ' description for ' + role.id + ' does not match the shared role description.');
  }
  for (const description of new Set([expected, actual ?? ''])) {
    if (!AUDIT_ASCII_PATTERN.test(description)) {
      errors.push(adapter.id + ' description for ' + role.id + ' must be one line of plain ASCII text.');
    }
    if (description.length > AUDIT_MAX_DESCRIPTION_LENGTH) {
      errors.push(adapter.id + ' description for ' + role.id + ' exceeds '
        + AUDIT_MAX_DESCRIPTION_LENGTH + ' characters.');
    }
    if (role.routing?.mode === 'explicit' && !description.startsWith(AUDIT_EXPLICIT_DESCRIPTION_PREFIX)) {
      errors.push(adapter.id + ' description for explicit role ' + role.id + ' is missing the explicit-only prefix.');
    }
  }
  return errors;
}

function auditOpenCodeBashMap(role, projected) {
  const errors = [];
  const executable = AUDIT_EXECUTE_PRESETS.has(role.permissionPreset);
  const bashIndex = projected.indexOf('\n  bash:\n');
  if (bashIndex < 0) return ['opencode projection for ' + role.id + ' is missing the bash permission map.'];
  const bashLines = projected.slice(bashIndex).split('\n').slice(2)
    .filter((line) => line.startsWith('    '));
  const entries = bashLines.map((line) => {
    const match = line.match(/^ {4}(.+): (\w+)$/u);
    return match ? { command: JSON.parse(match[1]), decision: match[2] } : { command: line, decision: null };
  });
  if (entries.length === 0) return ['opencode bash map for ' + role.id + ' is empty.'];
  if (entries[0].command !== '*') {
    errors.push('opencode bash map for ' + role.id + ' must list the "*" fallback first.');
  }
  if (entries[0].decision !== (executable ? 'ask' : 'deny')) {
    errors.push('opencode bash fallback for ' + role.id + ' does not match its preset.');
  }
  if (!executable && entries.length !== 1) {
    errors.push('opencode read-only role ' + role.id + ' must keep bash fully disabled.');
  }
  for (const entry of entries.slice(1)) {
    if (!AUDIT_READ_ONLY_COMMANDS.has(entry.command)) {
      errors.push('opencode bash allowlist for ' + role.id + ' contains a command the policy layer does not classify as read-only: ' + entry.command);
    }
    if (entry.decision !== 'allow') {
      errors.push('opencode bash entry ' + entry.command + ' for ' + role.id + ' must stay a read-only allow.');
    }
  }
  return errors;
}

function auditCapabilityBinding(role, adapter, projected, header, writable, executable) {
  const errors = [];
  const format = adapter.roleProjection.format;
  const bindable = AUDIT_CAPABILITY_HOSTS.has(adapter.id);
  if (format === 'qoder-markdown') {
    if (frontmatterScalar(header, 'tools') !== null || /^tools:/mu.test(header)) {
      errors.push('qoder projection for ' + role.id + ' must not declare a tools list.');
    }
    const skills = frontmatterList(header, 'skills');
    const servers = frontmatterList(header, 'mcpServers');
    if (skills === null || servers === null) {
      errors.push('qoder projection for ' + role.id + ' must carry skills and mcpServers lists.');
    } else if (skills.length !== AUDIT_CAPABILITIES.skills.length || servers.length !== AUDIT_CAPABILITIES.mcpServers.length) {
      errors.push('qoder projection for ' + role.id + ' does not bind the requested capabilities.');
    }
  }
  if (format === 'claude-markdown') {
    const tools = frontmatterList(header, 'tools') ?? [];
    const bound = tools.filter((tool) => tool.startsWith('mcp__'));
    if (bound.length !== AUDIT_CAPABILITIES.mcpServers.length
      || bound.some((tool) => !AUDIT_CAPABILITIES.mcpServers.includes(tool.slice('mcp__'.length)))) {
      errors.push('claude projection for ' + role.id + ' must enumerate exactly the installed MCP servers.');
    }
    const explicitSkillTool = tools.some((tool) => /^skill$/iu.test(tool));
    if (explicitSkillTool) {
      errors.push('claude projection for ' + role.id + ' must preload skills instead of listing the Skill tool.');
    }
    const skills = frontmatterList(header, 'skills');
    if (skills === null || skills.length !== AUDIT_CAPABILITIES.skills.length) {
      errors.push('claude projection for ' + role.id + ' must preload the installed skills.');
    }
    const permissionMode = frontmatterScalar(header, 'permissionMode');
    const expectedPlanMode = AUDIT_PLAN_MODE_PRESETS.has(role.permissionPreset);
    if (expectedPlanMode ? permissionMode !== 'plan' : permissionMode !== null) {
      errors.push('claude projection for ' + role.id + ' has an unexpected permissionMode.');
    }
  }
  if (format === 'gemini-markdown') {
    const tools = frontmatterList(header, 'tools') ?? [];
    if (!tools.includes('mcp_*')) {
      errors.push('gemini projection for ' + role.id + ' must grant the mcp_* wildcard when servers are installed.');
    }
  }
  if (format === 'zcode-plugin-markdown') {
    const skills = frontmatterList(header, 'skills');
    if (skills === null || skills.length !== AUDIT_CAPABILITIES.skills.length) {
      errors.push('zcode projection for ' + role.id + ' must declare the installed skills.');
    }
    const permissionMode = frontmatterScalar(header, 'permissionMode');
    const expectedPlanMode = AUDIT_PLAN_MODE_PRESETS.has(role.permissionPreset);
    if (expectedPlanMode ? permissionMode !== 'plan' : permissionMode !== null) {
      errors.push('zcode projection for ' + role.id + ' has an unexpected permissionMode.');
    }
  }
  if (format === 'antigravity-markdown') {
    const tools = frontmatterList(header, 'tools') ?? [];
    const unknown = tools.filter((tool) => !AUDIT_ANTIGRAVITY_TOOLS.has(tool));
    if (unknown.length > 0) {
      errors.push('antigravity projection for ' + role.id + ' uses unverified tool names: ' + unknown.join(', '));
    }
  }
  if (format === 'cursor-markdown' && !bindable) {
    const readonly = frontmatterScalar(header, 'readonly');
    if (readonly !== !executable) {
      errors.push('cursor projection for ' + role.id + ' has an unexpected readonly flag.');
    }
  }
  if (/\bmcp__|\bmcp_\*/u.test(projected) && !bindable) {
    errors.push(adapter.id + ' projection for ' + role.id + ' binds MCP tools on a host that cannot hold them.');
  }
  if (!bindable && /^skills:/mu.test(header ?? '')) {
    errors.push(adapter.id + ' projection for ' + role.id + ' binds skills on a host that cannot hold them.');
  }
  if (writable && format === 'antigravity-markdown' && !(frontmatterList(header, 'tools') ?? []).includes('write_to_file')) {
    errors.push('antigravity projection for ' + role.id + ' must grant write_to_file to a writable preset.');
  }
  return errors;
}

function auditPermissionProjection(role, adapter, projected) {
  const format = adapter.roleProjection.format;
  const writable = AUDIT_WRITE_PRESETS.has(role.permissionPreset);
  const executable = AUDIT_EXECUTE_PRESETS.has(role.permissionPreset);
  if (format === 'codex-toml') {
    const parsed = parseToml(projected);
    const expectedSandbox = executable ? 'workspace-write' : 'read-only';
    if (parsed.sandbox_mode !== expectedSandbox) {
      return adapter.id + ' permission mapping for ' + role.id + ' is not restrictive.';
    }
    return null;
  }
  if (format === 'opencode-markdown') {
    const expectedEdit = writable ? 'allow' : 'deny';
    if (!new RegExp('^  edit: ' + expectedEdit + '$', 'mu').test(projected)) {
      return adapter.id + ' permission mapping for ' + role.id + ' is not restrictive.';
    }
    for (const key of AUDIT_OPENCODE_DENY_KEYS) {
      if (!new RegExp('^  ' + key + ': deny$', 'mu').test(projected)) {
        return adapter.id + ' must deny ' + key + ' for ' + role.id + '.';
      }
    }
    const expectedExternal = executable ? 'ask' : 'deny';
    if (!new RegExp('^  external_directory: ' + expectedExternal + '$', 'mu').test(projected)) {
      return adapter.id + ' external-directory mapping for ' + role.id + ' does not match its preset.';
    }
    return null;
  }
  if (format === 'cursor-markdown') {
    const expectedReadonly = executable ? 'false' : 'true';
    if (!new RegExp('^readonly: ' + expectedReadonly + '$', 'mu').test(projected)) {
      return adapter.id + ' permission mapping for ' + role.id + ' is not restrictive.';
    }
    return null;
  }
  // Qoder subagent frontmatter has no tool or permission key, so its preset only
  // reaches the host through the composed prompt.
  if (format === 'qoder-markdown') return null;
  const toolsLine = projected.match(/^tools: (.+)$/mu)?.[1];
  if (!toolsLine) return adapter.id + ' permission mapping for ' + role.id + ' is missing tools.';
  const writeTool = AUDIT_WRITE_TOOL[format];
  const runTool = AUDIT_RUN_TOOL[format];
  if (!writeTool || !runTool) {
    return adapter.id + ' role projection format is not audited: ' + format;
  }
  if (toolsLine.includes(writeTool) !== writable) {
    return adapter.id + ' write grant for ' + role.id + ' does not match its preset.';
  }
  if (toolsLine.includes(runTool) !== executable) {
    return adapter.id + ' command grant for ' + role.id + ' does not match its preset.';
  }
  return null;
}

export async function runRolesAudit(rootDir) {
  const errors = [];
  const warnings = [];
  let rolePack;
  try {
    rolePack = await loadRolePack(rootDir);
  } catch (error) {
    return { errors: [error.message], ok: false, roleCount: 0, warnings };
  }

  const routerPath = path.join(rootDir, 'docs', 'rules', 'role-routing.md');
  let router;
  try {
    router = await readFile(routerPath, 'utf8');
  } catch (error) {
    return {
      errors: ['Role routing rule is unavailable at docs/rules/role-routing.md: ' + error.message],
      ok: false,
      roleCount: rolePack.items.length,
      warnings,
    };
  }
  const basePath = path.resolve(rootDir, rolePack.basePrompt);
  assertInsideDir(rootDir, basePath, 'role base prompt');
  await assertSafePathInside(rootDir, basePath, 'role base prompt');
  const basePrompt = await readFile(basePath, 'utf8');
  for (const fragment of ['## 工作方式', '## 权限边界', '## 交付标准']) {
    if (!basePrompt.includes(fragment)) errors.push('Role base prompt is missing ' + fragment + '.');
  }

  const adapters = await loadAdapterCatalog(rootDir);
  const rolePromptOwners = new Map();
  const projectionOwners = new Map();
  for (const role of rolePack.items) {
    try {
      assertPortableRelativePath(role.promptSource, 'role prompt source');
      const source = path.resolve(rootDir, role.promptSource);
      assertInsideDir(rootDir, source, 'role prompt source');
      await assertSafePathInside(rootDir, source, 'role prompt source');
      const rolePrompt = await readFile(source, 'utf8');
      const normalizedPrompt = normalizeRoleContent(rolePrompt);
      const promptOwner = rolePromptOwners.get(normalizedPrompt);
      if (promptOwner && promptOwner !== role.id) {
        errors.push('Roles ' + promptOwner + ' and ' + role.id + ' have duplicate complete role prompt content.');
      } else {
        rolePromptOwners.set(normalizedPrompt, role.id);
      }
      for (const section of REQUIRED_ROLE_SECTIONS) {
        if (!rolePrompt.includes(section)) errors.push('Role ' + role.id + ' is missing ' + section + '.');
      }
      const heading = rolePrompt.split(/\r?\n/u).find((line) => line.startsWith('# '));
      if (heading !== '# ' + role.name) {
        errors.push('Role ' + role.id + ' prompt heading ' + JSON.stringify(heading ?? null)
          + ' does not match its declared name ' + JSON.stringify(role.name) + '.');
      }
      if (role.routing.mode && !['auto', 'explicit'].includes(role.routing.mode)) {
        errors.push('Role ' + role.id + ' has an invalid routing mode.');
      }
      if (!router.includes(role.id)) errors.push('Role router does not mention ' + role.id + '.');
      const compiled = {
        ...role,
        prompt: basePrompt.trim() + '\n\n' + rolePrompt.trim() + '\n',
      };
      for (const adapter of adapters.items) {
        const capabilities = AUDIT_CAPABILITY_HOSTS.has(adapter.id) ? AUDIT_CAPABILITIES : null;
        const first = projectRole(compiled, adapter, capabilities);
        const second = projectRole(compiled, adapter, capabilities);
        const projectionKey = adapter.id + '\u0000' + normalizeRoleContent(first);
        const projectionOwner = projectionOwners.get(projectionKey);
        if (projectionOwner && projectionOwner !== role.id) {
          errors.push(adapter.id + ' roles ' + projectionOwner + ' and ' + role.id + ' have duplicate complete role projections.');
        } else {
          projectionOwners.set(projectionKey, role.id);
        }
        if (first !== second) errors.push(adapter.id + ' projection for ' + role.id + ' is not deterministic.');
        const unbound = projectRole(compiled, adapter, null);
        // Qoder always renders empty `skills`/`mcpServers` lists, so only a
        // non-empty binding counts as a leak here.
        const unboundShape = unbound.replace(/^(?:skills|mcpServers): \[\]$\n?/gmu, '');
        if (/\bmcp__|\bmcp_\*|^skills:|^mcpServers:/mu.test(unboundShape)) {
          errors.push(adapter.id + ' projection for ' + role.id
            + ' binds capabilities even though the install declared none.');
        }
        const header = projectedHeader(first, adapter, role);
        if (adapter.roleProjection.format === 'codex-toml') {
          const parsed = parseToml(first);
          if (parsed.name !== role.id || typeof parsed.developer_instructions !== 'string') {
            errors.push('Codex projection for ' + role.id + ' is missing required fields.');
          }
        }
        const writable = AUDIT_WRITE_PRESETS.has(role.permissionPreset);
        const executable = AUDIT_EXECUTE_PRESETS.has(role.permissionPreset);
        errors.push(...auditRoleDescription(role, adapter, first, header));
        const permissionError = auditPermissionProjection(role, adapter, first);
        if (permissionError) errors.push(permissionError);
        if (adapter.roleProjection.format === 'opencode-markdown') {
          errors.push(...auditOpenCodeBashMap(role, first));
        }
        errors.push(...auditCapabilityBinding(role, adapter, first, header, writable, executable));
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  return {
    errors: [...new Set(errors)].sort(),
    ok: errors.length === 0,
    roleCount: rolePack.items.length,
    warnings,
  };
}

export function renderRolesAudit(report) {
  const lines = [
    'Role audit: ' + (report.ok ? 'ok' : 'failed'),
    'Built-in roles: ' + report.roleCount,
    'Errors: ' + report.errors.length,
    'Warnings: ' + report.warnings.length,
  ];
  for (const error of report.errors) lines.push('- ERROR ' + error);
  for (const warning of report.warnings) lines.push('- WARN ' + warning);
  return lines.join('\n') + '\n';
}
