import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { stringify as stringifyToml } from '@iarna/toml';

import {
  assertInsideDir,
  assertPortableRelativePath,
  assertSafePathInside,
  isRedZoneTarget,
  readPackJson,
} from './manifest.js';
import { validateJsonAgainstSchema } from './schema-validation.js';

const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/u;
const PROJECT_PROMPT_PATTERN = /^docs\/agent-roles\/[a-z0-9][a-z0-9._-]*\.md$/iu;
const MAX_PROJECT_PROMPT_BYTES = 32 * 1024;
const PROMPT_OVERRIDE_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/iu,
  /override\s+(?:the\s+)?(?:governance|safety|sandbox|authorization)/iu,
  /disable\s+(?:the\s+)?(?:safety|sandbox|authorization)/iu,
  /忽略.{0,12}(?:之前|以上|上级).{0,12}指令/u,
  /(?:绕过|禁用|取消).{0,12}(?:安全|沙箱|授权|治理)/u,
  /(?:扩大|提升).{0,8}权限/u,
];
const EXPECTED_PERMISSION_CAPABILITIES = {
  analysis: ['read', 'search', 'reason'],
  implementation: ['read', 'search', 'reason', 'workspace-write', 'validation-command'],
  verification: ['read', 'search', 'reason', 'validation-command', 'browser-verification'],
  'security-review': ['read', 'search', 'reason', 'safe-security-check'],
  'release-readiness': ['read', 'search', 'reason', 'validation-command', 'package-dry-run'],
};

/**
 * @typedef {{
 *   disabled?: string[],
 *   overrides?: Record<string, { permissionPreset?: string, promptPath?: string }>,
 *   custom?: Array<{ id: string, name: string, description: string, permissionPreset: string, promptPath: string, routing: { when: string[], avoid: string[] } }>
 * }} RoleConfig
 */

function yamlScalar(value) {
  return JSON.stringify(value);
}

function frontmatter(fields) {
  const lines = ['---'];
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) lines.push(name + ': ' + JSON.stringify(value));
    else lines.push(name + ': ' + yamlScalar(value));
  }
  lines.push('---', '');
  return lines.join('\n');
}

function presetMap(rolePack) {
  return new Map(rolePack.permissionPresets.map((preset) => [preset.id, preset]));
}

function isCapabilitySubset(candidate, baseline) {
  const allowed = new Set(baseline.capabilities);
  return candidate.capabilities.every((capability) => allowed.has(capability));
}

function validateRolePackSemantics(rolePack) {
  const errors = [];
  const roleIds = rolePack.items.map((role) => role.id);
  const presetIds = rolePack.permissionPresets.map((preset) => preset.id);
  if (new Set(roleIds).size !== roleIds.length) errors.push('Role pack contains duplicate role ids.');
  if (new Set(presetIds).size !== presetIds.length) errors.push('Role pack contains duplicate permission preset ids.');
  if (rolePack.routingOrder.length !== roleIds.length
    || rolePack.routingOrder.some((id) => !roleIds.includes(id))) {
    errors.push('Role pack routingOrder must contain every built-in role exactly once.');
  }
  for (const preset of rolePack.permissionPresets) {
    const expected = EXPECTED_PERMISSION_CAPABILITIES[preset.id];
    if (!expected || JSON.stringify([...preset.capabilities].sort()) !== JSON.stringify([...expected].sort())) {
      errors.push('Permission preset ' + preset.id + ' does not match the governed capability mapping.');
    }
  }
  for (const role of rolePack.items) {
    if (!presetIds.includes(role.permissionPreset)) {
      errors.push('Role ' + role.id + ' references unknown permission preset ' + role.permissionPreset + '.');
    }
    if (role.promptSource !== 'roles/prompts/' + role.id + '.md') {
      errors.push('Role ' + role.id + ' promptSource must match its id.');
    }
  }
  return errors;
}

export async function loadRolePack(rootDir) {
  const [rolePack, schema] = await Promise.all([
    readPackJson(path.join(rootDir, 'manifests', 'roles.json')),
    readPackJson(path.join(rootDir, 'schemas', 'role-pack.schema.json')),
  ]);
  const errors = [
    ...validateJsonAgainstSchema(rolePack, schema, 'roles'),
    ...validateRolePackSemantics(rolePack),
  ];
  if (errors.length > 0) throw new Error('Invalid role pack:\n  - ' + errors.join('\n  - '));
  return rolePack;
}

function assertProjectPromptContent(content, label) {
  if (Buffer.byteLength(content, 'utf8') > MAX_PROJECT_PROMPT_BYTES) {
    throw new Error(label + ' must not exceed ' + MAX_PROJECT_PROMPT_BYTES + ' bytes.');
  }
  const match = PROMPT_OVERRIDE_PATTERNS.find((pattern) => pattern.test(content));
  if (match) throw new Error(label + ' attempts to override governance, safety, sandbox, or authorization boundaries.');
}

async function readProjectPrompt(targetDir, relativePath, label) {
  assertPortableRelativePath(relativePath, label);
  const normalized = relativePath.replaceAll('\\', '/');
  if (!PROJECT_PROMPT_PATTERN.test(normalized)) {
    throw new Error(label + ' must be a direct Markdown file under docs/agent-roles/.');
  }
  const resolved = path.resolve(targetDir, normalized);
  assertInsideDir(targetDir, resolved, label);
  await assertSafePathInside(targetDir, resolved, label);
  const content = await readFile(resolved, 'utf8');
  assertProjectPromptContent(content, label);
  return { content, relativePath: normalized, source: resolved };
}

function permissionPreset(rolePack, id, label) {
  const preset = presetMap(rolePack).get(id);
  if (!preset) throw new Error(label + ' references unknown permission preset ' + id + '.');
  return preset;
}

function composePrompt(basePrompt, rolePrompt, projectPrompt, permission) {
  const sections = [basePrompt.trim(), rolePrompt.trim()];
  if (projectPrompt) sections.push('# 项目角色补充\n\n' + projectPrompt.trim());
  sections.push('# 生效权限预设\n\n' + permission.id + ': ' + permission.capabilities.join(', '));
  return sections.join('\n\n') + '\n';
}

function roleIndex(roles) {
  const lines = [
    '# 可用角色',
    '',
    '每个原子动作只选择一个角色。先按 docs/rules/role-routing.md 的优先级选择，再读取对应角色文件。',
    '',
  ];
  for (const role of roles) {
    lines.push('## ' + role.id, '', role.description, '', '权限预设：' + role.permissionPreset + '。', '');
    lines.push('适用：' + role.routing.when.join('；') + '。', '');
    lines.push('避免：' + role.routing.avoid.join('；') + '。', '');
  }
  return lines.join('\n').trim() + '\n';
}

function toolSet(permissionPresetId) {
  if (permissionPresetId === 'implementation') {
    return ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];
  }
  if (['verification', 'security-review', 'release-readiness'].includes(permissionPresetId)) {
    return ['Read', 'Grep', 'Glob', 'Bash'];
  }
  return ['Read', 'Grep', 'Glob'];
}

function genericMarkdown(role, prompt, format) {
  const fields = {
    name: role.id,
    description: role.description,
  };
  if (format === 'claude-markdown') {
    fields.tools = toolSet(role.permissionPreset);
    fields.model = 'inherit';
  } else if (format === 'gemini-markdown') {
    fields.kind = 'local';
    fields.tools = toolSet(role.permissionPreset);
  } else if (format === 'cursor-markdown') {
    fields.model = 'inherit';
    fields.readonly = role.permissionPreset !== 'implementation';
  } else if (format === 'qoder-markdown') {
    fields.tools = toolSet(role.permissionPreset);
  } else if (format === 'antigravity-markdown') {
    fields.tools = toolSet(role.permissionPreset);
  } else if (format === 'zcode-plugin-markdown') {
    fields.tools = toolSet(role.permissionPreset);
  }
  return frontmatter(fields) + prompt;
}

function opencodeMarkdown(role, prompt) {
  const writable = role.permissionPreset === 'implementation';
  const lines = [
    '---',
    'description: ' + yamlScalar(role.description),
    'mode: subagent',
    'permission:',
    '  edit: ' + (writable ? 'allow' : 'deny'),
    '  bash:',
    '    "*": ' + (writable ? 'ask' : 'deny'),
    '---',
    '',
    prompt,
  ];
  return lines.join('\n');
}

export function projectRole(role, adapter) {
  const format = adapter.roleProjection.format;
  if (format === 'codex-toml') {
    return stringifyToml({
      name: role.id,
      description: role.description,
      sandbox_mode: role.permissionPreset === 'implementation' ? 'workspace-write' : 'read-only',
      developer_instructions: role.prompt,
    });
  }
  if (format === 'opencode-markdown') return opencodeMarkdown(role, role.prompt);
  return genericMarkdown(role, role.prompt, format);
}

function roleTarget(adapter, roleId) {
  return adapter.roleProjection.targetRoot.replace(/\/+$/u, '')
    + '/' + roleId + adapter.roleProjection.extension;
}

function zcodeMetadataEntries(adapter, packageVersion) {
  if (adapter.id !== 'zcode') return [];
  const pluginRoot = '.zcode/plugins/vibe-harness-roles';
  const plugin = {
    name: 'vibe-harness-roles',
    version: packageVersion,
    description: 'Vibe-Harness project-local role agents',
    agents: './agents',
  };
  const marketplace = {
    name: 'vibe-harness-project',
    plugins: [{ name: plugin.name, source: '.' }],
  };
  return [
    {
      group: 'roles',
      source: 'manifests/roles.json',
      sourceRoot: 'pack',
      target: pluginRoot + '/.zcode-plugin/plugin.json',
      inlineContent: JSON.stringify(plugin, null, 2) + '\n',
    },
    {
      group: 'roles',
      source: 'manifests/roles.json',
      sourceRoot: 'pack',
      target: pluginRoot + '/marketplace.json',
      inlineContent: JSON.stringify(marketplace, null, 2) + '\n',
    },
  ];
}

/**
 * @param {{ adapter: any, packageVersion: string, rolesConfig?: RoleConfig, rootDir: string, targetDir: string }} options
 */
export async function resolveRoleInstallEntries({ adapter, packageVersion, rolesConfig = {}, rootDir, targetDir }) {
  const rolePack = await loadRolePack(rootDir);
  const baseSource = path.resolve(rootDir, rolePack.basePrompt);
  assertInsideDir(rootDir, baseSource, 'role base prompt');
  await assertSafePathInside(rootDir, baseSource, 'role base prompt');
  const basePrompt = await readFile(baseSource, 'utf8');
  const presets = presetMap(rolePack);
  const roles = [];
  const builtInIds = new Set(rolePack.items.map((role) => role.id));
  const overrides = rolesConfig.overrides ?? {};

  for (const id of Object.keys(overrides)) {
    if (!builtInIds.has(id)) throw new Error('roles.overrides references unknown built-in role ' + id + '.');
  }

  for (const definition of rolePack.items) {
    const override = overrides[definition.id] ?? {};
    const baselinePreset = permissionPreset(rolePack, definition.permissionPreset, 'role ' + definition.id);
    const selectedPreset = permissionPreset(rolePack, override.permissionPreset ?? definition.permissionPreset, 'roles.overrides.' + definition.id);
    if (!isCapabilitySubset(selectedPreset, baselinePreset)) {
      throw new Error('roles.overrides.' + definition.id + '.permissionPreset must not expand the built-in permission set.');
    }
    const promptSource = path.resolve(rootDir, definition.promptSource);
    assertInsideDir(rootDir, promptSource, 'role prompt');
    await assertSafePathInside(rootDir, promptSource, 'role prompt');
    const rolePrompt = await readFile(promptSource, 'utf8');
    const projectPrompt = override.promptPath
      ? await readProjectPrompt(targetDir, override.promptPath, 'roles.overrides.' + definition.id + '.promptPath')
      : null;
    roles.push({
      ...definition,
      permissionPreset: selectedPreset.id,
      prompt: composePrompt(basePrompt, rolePrompt, projectPrompt?.content, selectedPreset),
      relativeSource: projectPrompt?.relativePath ?? definition.promptSource,
      source: projectPrompt?.source ?? promptSource,
      sourceRoot: projectPrompt ? 'project' : 'pack',
    });
  }

  const customIds = new Set();
  for (const [index, custom] of (rolesConfig.custom ?? []).entries()) {
    if (!ROLE_ID_PATTERN.test(custom.id)) throw new Error('roles.custom[' + index + '].id is invalid.');
    if (builtInIds.has(custom.id) || customIds.has(custom.id)) {
      throw new Error('Custom role id conflicts with an existing role: ' + custom.id + '.');
    }
    customIds.add(custom.id);
    const selectedPreset = permissionPreset(rolePack, custom.permissionPreset, 'roles.custom[' + index + ']');
    const projectPrompt = await readProjectPrompt(targetDir, custom.promptPath, 'roles.custom[' + index + '].promptPath');
    roles.push({
      ...custom,
      prompt: composePrompt(basePrompt, projectPrompt.content, null, selectedPreset),
      relativeSource: projectPrompt.relativePath,
      source: projectPrompt.source,
      sourceRoot: 'project',
    });
  }

  const disabled = new Set(rolesConfig.disabled ?? []);
  const allIds = new Set(roles.map((role) => role.id));
  for (const id of disabled) {
    if (!allIds.has(id)) throw new Error('roles.disabled references unknown role ' + id + '.');
  }
  const enabledRoles = roles.filter((role) => !disabled.has(role.id));
  const entries = [
    {
      group: 'roles',
      source: 'manifests/roles.json',
      sourceRoot: 'pack',
      target: '.agents/roles/index.md',
      inlineContent: roleIndex(enabledRoles),
    },
  ];
  for (const role of enabledRoles) {
    entries.push({
      group: 'roles',
      source: role.relativeSource,
      sourceRoot: role.sourceRoot,
      target: '.agents/roles/' + role.id + '.md',
      inlineContent: role.prompt,
    });
    entries.push({
      group: 'roles',
      source: role.relativeSource,
      sourceRoot: role.sourceRoot,
      target: roleTarget(adapter, role.id),
      inlineContent: projectRole(role, adapter),
    });
  }
  entries.push(...zcodeMetadataEntries(adapter, packageVersion));
  return {
    entries: entries.map((entry) => ({
      ...entry,
      contentStrategy: 'replace',
      redZone: isRedZoneTarget(entry.target)
        || adapter.redZonePrefixes.some((prefix) => entry.target.startsWith(prefix.replaceAll('\\', '/'))),
    })),
    roles: enabledRoles.map((role) => ({
      id: role.id,
      name: role.name,
      permissionPreset: role.permissionPreset,
    })),
    diagnostics: {
      activation: adapter.roleProjection.activation,
      activationPath: adapter.id === 'zcode'
        ? '.zcode/plugins/vibe-harness-roles/'
        : adapter.roleProjection.targetRoot,
      permissionMapping: adapter.roleProjection.permissionEnforcement === 'native' ? 'native' : 'degraded-permission-mapping',
    },
  };
}
