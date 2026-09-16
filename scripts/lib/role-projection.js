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
import { readOnlyCommandPrefixes } from '../../runtime/hooks/lib/read-only-commands.mjs';
import { validateJsonAgainstSchema } from './schema-validation.js';

const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/u;
const PROJECT_PROMPT_PATTERN = /^docs\/agent-roles\/[a-z0-9][a-z0-9._-]*\.md$/iu;
const MAX_PROJECT_PROMPT_BYTES = 32 * 1024;
/**
 * Combined role descriptions have to stay inside every host's own limit while
 * still naming what the role does and when to use it. `schemas/role-pack.schema.json`
 * bounds the three source fields separately, so the composed string is checked
 * here (and again in `roles-audit.js`) instead of in the JSON schema.
 */
const MAX_PROJECTED_DESCRIPTION_LENGTH = 300;
const EXPLICIT_DESCRIPTION_PREFIX = '[Explicit invocation only; do not auto-select. ';
const PROJECTED_DESCRIPTION_PATTERN = /^[\x20-\x7e]+$/u;
/** Managed MCP servers are always written with this prefix in the target config. */
export const MANAGED_MCP_SERVER_PREFIX = 'vibe-harness-';
const BINDABLE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function isBindableName(name) {
  return typeof name === 'string' && BINDABLE_NAME_PATTERN.test(name);
}

function isManagedMcpServerName(name) {
  return typeof name === 'string'
    && name.startsWith(MANAGED_MCP_SERVER_PREFIX)
    && isBindableName(name.slice(MANAGED_MCP_SERVER_PREFIX.length));
}
/**
 * Hosts whose native subagent schema can bind installed Skills or MCP servers.
 * Every other host keeps the capability in the parent session, so asking for an
 * injection there is a configuration error rather than something to ignore.
 */
const CAPABILITY_INJECTION_HOSTS = new Set(['claude', 'gemini', 'qoder', 'zcode']);
/** Presets that must not change the workspace, mapped to a host plan/permission mode. */
const PLAN_MODE_PRESETS = new Set(['analysis']);

/**
 * True when the host's native subagent schema can bind installed Skills or MCP
 * servers. Callers use it to skip the request for hosts that keep the capability
 * in the parent session; passing a request to one of those still fails closed.
 *
 * @param {string} adapterId
 * @returns {boolean}
 */
export function supportsNativeCapabilityBinding(adapterId) {
  return CAPABILITY_INJECTION_HOSTS.has(adapterId);
}

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
const PROJECTED_CAPABILITIES = {
  codex: ['read', 'search', 'reason', 'workspace-write', 'validation-command'],
  claude: ['read', 'search', 'reason', 'workspace-write', 'validation-command'],
  gemini: ['read', 'search', 'reason', 'workspace-write', 'validation-command'],
  cursor: ['read', 'search', 'reason', 'workspace-write', 'validation-command'],
  qoder: ['read', 'search', 'reason', 'workspace-write', 'validation-command'],
  zcode: ['read', 'search', 'reason', 'workspace-write', 'validation-command'],
  antigravity: ['read', 'search', 'reason', 'workspace-write', 'validation-command'],
  opencode: ['read', 'search', 'reason', 'workspace-write', 'validation-command'],
};

// Permission presets that may modify the workspace versus those that may only
// execute approved validation commands and write isolated evidence.
const WRITE_PRESETS = new Set(['implementation']);
const EXECUTE_PRESETS = new Set(['implementation', 'verification', 'release-readiness']);

// Host-native tool names per adapter. Gemini and Antigravity use their own
// built-in tool identifiers; emitting another host's names can make a projected
// subagent unable to bind its tools.
const NATIVE_TOOLS = {
  claude: { read: 'Read', search: 'Grep', glob: 'Glob', edit: 'Edit', write: 'Write', run: 'Bash' },
  qoder: { read: 'Read', search: 'Grep', glob: 'Glob', edit: 'Edit', write: 'Write', run: 'Bash' },
  zcode: { read: 'Read', search: 'Grep', glob: 'Glob', edit: 'Edit', write: 'Write', run: 'Bash' },
  gemini: { read: 'read_file', search: 'grep_search', glob: 'glob', edit: 'replace', write: 'write_file', run: 'run_shell_command' },
  antigravity: { read: 'view_file', search: 'grep_search', glob: 'list_dir', edit: 'replace_file_content', write: 'write_to_file', run: 'run_command' },
};

function isWritablePreset(permissionPresetId) {
  return WRITE_PRESETS.has(permissionPresetId);
}

function isExecutablePreset(permissionPresetId) {
  return EXECUTE_PRESETS.has(permissionPresetId);
}

/**
 * Builds the single description every host projection and the role index share.
 *
 * Hosts delegate on this string, so it has to answer "what does this role do"
 * and "when should it be used" in one language and one line: hosts differ in
 * how many characters they accept, and a mixed-language description makes the
 * delegation decision depend on which half the parent model weighs.
 *
 * @param {{ description?: string, id?: string, routing?: { avoid?: string[], mode?: string, when?: string[] } }} role
 * @returns {string}
 */
export function projectRoleDescription(role) {
  const routing = role.routing ?? {};
  const when = Array.isArray(routing.when) ? routing.when : [];
  const avoid = Array.isArray(routing.avoid) ? routing.avoid : [];
  const description = (routing.mode === 'explicit' ? EXPLICIT_DESCRIPTION_PREFIX : '')
    + String(role.description ?? '').trim()
    + ' Triggers: ' + when.join('; ')
    + '. Avoid: ' + avoid.join('; ')
    + '.';
  assertProjectedDescription(description, role.id ?? 'role');
  return description;
}

function assertProjectedDescription(description, label) {
  if (!PROJECTED_DESCRIPTION_PATTERN.test(description)) {
    throw new Error('Projected description for role ' + label
      + ' must be a single line of plain ASCII text.');
  }
  if (description.length > MAX_PROJECTED_DESCRIPTION_LENGTH) {
    throw new Error('Projected description for role ' + label + ' is ' + description.length
      + ' characters; hosts accept at most ' + MAX_PROJECTED_DESCRIPTION_LENGTH
      + '. Shorten description, routing.when, or routing.avoid.');
  }
}

/**
 * Normalizes the installed capabilities a caller wants bound into native role
 * files. Absent input means "bind nothing" so older callers keep working; the
 * value is validated fail-closed instead of being dropped silently.
 */
function resolveBindableCapabilities(adapter, resolvedCapabilities) {
  const mcpServers = [...new Set(resolvedCapabilities?.mcpServers ?? [])];
  const skills = [...new Set(resolvedCapabilities?.skills ?? [])];
  if (mcpServers.length === 0 && skills.length === 0) return { mcpServers: [], skills: [] };
  if (!CAPABILITY_INJECTION_HOSTS.has(adapter.id)) {
    throw new Error(adapter.id + ' cannot bind installed Skills or MCP servers into native role files; '
      + 'keep the capability in the parent session or drop the roles module.');
  }
  for (const name of mcpServers) {
    if (!isManagedMcpServerName(name)) {
      throw new Error('Cannot bind MCP server ' + JSON.stringify(name) + ' into role files for '
        + adapter.id + '; expected a ' + MANAGED_MCP_SERVER_PREFIX + '* server managed by this installer.');
    }
  }
  for (const name of skills) {
    if (!isBindableName(name)) {
      throw new Error('Cannot bind installed skill ' + JSON.stringify(name) + ' into role files for '
        + adapter.id + '; expected a plain skill directory name.');
    }
  }
  return { mcpServers: mcpServers.sort(), skills: skills.sort() };
}

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
    '每个原子动作只选择一个角色：先识别动作，再在可用且能力匹配的角色中选择领域视角。`explicit` 角色只在用户明确指定或父 Agent 明确咨询时使用。',
    '',
  ];
  for (const role of roles) {
    lines.push('## ' + role.id, '', role.description, '', '路由模式：' + (role.routing.mode ?? 'auto') + '。', '', '权限预设：' + role.permissionPreset + '。', '');
    lines.push('适用：' + role.routing.when.join('；') + '。', '');
    lines.push('避免：' + role.routing.avoid.join('；') + '。', '');
  }
  return lines.join('\n').trim() + '\n';
}

// Read/search are always granted; glob is host-specific; write tools only for
// implementation; a validation command tool for implement/verify/release roles
// so independent verification can actually execute and record evidence.
export function projectedToolNames(host, permissionPresetId) {
  const tools = NATIVE_TOOLS[host];
  if (!tools) throw new Error('Unknown role projection host: ' + host);
  const names = [tools.read, tools.search];
  if (tools.glob) names.push(tools.glob);
  if (isWritablePreset(permissionPresetId)) names.push(tools.edit, tools.write);
  if (isExecutablePreset(permissionPresetId)) names.push(tools.run);
  return [...new Set(names)];
}

/**
 * Claude Code resolves every entry of `tools` before it starts a subagent and
 * refuses to launch on an unknown name, so MCP entries are enumerated from the
 * servers this install actually manages instead of using a wildcard.
 */
function claudeTools(role, capabilities) {
  return [
    ...projectedToolNames('claude', role.permissionPreset),
    ...capabilities.mcpServers.map((name) => 'mcp__' + name),
  ];
}

function genericMarkdown(role, prompt, adapter, capabilities) {
  const format = adapter.roleProjection.format;
  const fields = {
    name: role.id,
    description: projectRoleDescription(role),
  };
  if (format === 'claude-markdown') {
    fields.tools = claudeTools(role, capabilities);
    if (capabilities.skills.length > 0) fields.skills = capabilities.skills;
    fields.model = 'inherit';
    if (PLAN_MODE_PRESETS.has(role.permissionPreset)) fields.permissionMode = 'plan';
  } else if (format === 'gemini-markdown') {
    fields.kind = 'local';
    fields.tools = [
      ...projectedToolNames('gemini', role.permissionPreset),
      ...(capabilities.mcpServers.length > 0 ? ['mcp_*'] : []),
    ];
  } else if (format === 'cursor-markdown') {
    fields.model = 'inherit';
    fields.readonly = !isExecutablePreset(role.permissionPreset);
  } else if (format === 'antigravity-markdown') {
    fields.tools = projectedToolNames('antigravity', role.permissionPreset);
  } else if (format === 'zcode-plugin-markdown') {
    fields.tools = projectedToolNames('zcode', role.permissionPreset);
    if (capabilities.skills.length > 0) fields.skills = capabilities.skills;
    if (PLAN_MODE_PRESETS.has(role.permissionPreset)) fields.permissionMode = 'plan';
  }
  return frontmatter(fields) + prompt;
}

/**
 * Qoder parses `name`, `description`, `model`, `skills`, `mcpServers` and
 * `additionalPrompt`; an unknown key such as `tools` is inert, so the projection
 * only emits the keys the host reads and uses its own list form (`- item`) for
 * the two arrays. `model` is intentionally not written: Qoder expects a concrete
 * model id here, and a guessed value would override the host default.
 */
function qoderMarkdown(role, prompt, capabilities) {
  const fieldLines = (name, values) => (values.length === 0
    ? [name + ': []']
    : [name + ':', ...values.map((value) => '  - ' + value)]);
  const lines = [
    '---',
    'name: ' + yamlScalar(role.id),
    'description: ' + yamlScalar(projectRoleDescription(role)),
    ...fieldLines('skills', capabilities.skills),
    ...fieldLines('mcpServers', capabilities.mcpServers),
    '---',
    '',
    prompt,
  ];
  return lines.join('\n');
}

/**
 * OpenCode is the only host that enforces role permissions natively, so its
 * projection denies the delegation, fetch, and search surfaces outright and
 * keeps its read-only bash allowlist to argument-free commands the shared policy
 * table already classifies. OpenCode evaluates the last matching rule first, so
 * the `"*"` fallback stays ahead of the specific entries.
 *
 * The allowlist only ships for presets that may run validation commands at all;
 * a read-only preset keeps bash disabled, because granting it read-only shells
 * would widen `analysis`/`security-review` beyond their declared capabilities.
 */
function opencodeMarkdown(role, prompt) {
  const writable = isWritablePreset(role.permissionPreset);
  const executable = isExecutablePreset(role.permissionPreset);
  const lines = [
    '---',
    'description: ' + yamlScalar(projectRoleDescription(role)),
    'mode: subagent',
    'permission:',
    '  edit: ' + (writable ? 'allow' : 'deny'),
    '  task: deny',
    '  webfetch: deny',
    '  websearch: deny',
    '  external_directory: ' + (executable ? 'ask' : 'deny'),
    '  bash:',
    '    "*": ' + (executable ? 'ask' : 'deny'),
    ...(executable
      ? readOnlyCommandPrefixes().map((prefix) => '    ' + yamlScalar(prefix) + ': allow')
      : []),
    '---',
    '',
    prompt,
  ];
  return lines.join('\n');
}

function missingCapabilities(adapter, rolePack, role) {
  const required = permissionPreset(rolePack, role.permissionPreset, 'role ' + role.id).capabilities;
  const available = new Set(PROJECTED_CAPABILITIES[adapter.id] ?? []);
  return required.filter((capability) => !available.has(capability));
}

export function projectRole(role, adapter, resolvedCapabilities = null) {
  const capabilities = resolveBindableCapabilities(adapter, resolvedCapabilities);
  const format = adapter.roleProjection.format;
  if (format === 'codex-toml') {
    return stringifyToml({
      name: role.id,
      description: projectRoleDescription(role),
      sandbox_mode: isExecutablePreset(role.permissionPreset) ? 'workspace-write' : 'read-only',
      developer_instructions: role.prompt,
    });
  }
  if (format === 'opencode-markdown') return opencodeMarkdown(role, role.prompt);
  if (format === 'qoder-markdown') return qoderMarkdown(role, role.prompt, capabilities);
  return genericMarkdown(role, role.prompt, adapter, capabilities);
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
 * @param {{
 *   adapter: any,
 *   packageVersion: string,
 *   resolvedCapabilities?: { mcpServers?: string[], skills?: string[] } | null,
 *   rolesConfig?: RoleConfig,
 *   rootDir: string,
 *   targetDir: string
 * }} options
 */
export async function resolveRoleInstallEntries({
  adapter,
  packageVersion,
  resolvedCapabilities = null,
  rolesConfig = {},
  rootDir,
  targetDir,
}) {
  const rolePack = await loadRolePack(rootDir);
  const capabilities = resolveBindableCapabilities(adapter, resolvedCapabilities);
  const baseSource = path.resolve(rootDir, rolePack.basePrompt);
  assertInsideDir(rootDir, baseSource, 'role base prompt');
  await assertSafePathInside(rootDir, baseSource, 'role base prompt');
  const basePrompt = await readFile(baseSource, 'utf8');
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
      // Validated once above so an illegal binding fails before any file is planned.
      inlineContent: projectRole(role, adapter, capabilities),
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
      toolBinding: adapter.roleProjection.toolBinding ?? 'configured-unverified',
      missingCapabilities: Object.fromEntries(enabledRoles.map((role) => [
        role.id,
        missingCapabilities(adapter, rolePack, role),
      ])),
    },
  };
}
