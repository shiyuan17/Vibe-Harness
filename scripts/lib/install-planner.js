import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  backupFile,
  collectTargetFiles,
  hashFile,
  pruneBackups,
  readInstallState,
  stateFilePath,
  toTargetPath,
  writeInstallState,
} from './install-state.js';
import {
  assertInsideDir,
  assertPortableRelativePath,
  assertSafePathInside,
  pathExists,
  readPackJson,
  sameResolvedPath,
  validateCatalogManifest,
  validateInstallMapShape,
} from './manifest.js';
import {
  extractManagedInstructionBlock,
  mergeManagedInstructionBlock,
  renderManagedInstructionBlock,
  renderTemplate,
  withDefaultTemplateData,
} from './template-renderer.js';
import {
  PLAYWRIGHT_GENERATED_RELATIVE_DIR,
  PLAYWRIGHT_TOOL_RELATIVE_DIR,
} from '../../runtime/tools/playwright-cli/run.mjs';
import { retiredToolGroups } from './retired-tools.js';
import {
  extractManagedCbmIgnoreBlock,
  extractManagedMcpBlock,
  mergeManagedCbmIgnoreBlock,
  mergeManagedMcpBlock,
  removeManagedCbmIgnoreBlock,
  removeManagedMcpBlock,
} from './tool-provisioning.js';
import { applyBaselinePlan, createBaselinePlan } from './installation-baseline.js';
import { moduleCatalog, resolveModuleSelection } from './module-selection.js';
import { hasPluginCapability } from './plugin-provider-catalog.js';
import { assertAdapterProfile, hookConfigTargets, loadAdapterCatalog, resolveAdapter, resolveAdapterEntry, skillRootMatcher, skillRootPrefixes } from './adapter.js';
import { beginFileTransaction, createTransactionId } from './file-transaction.js';
import {
  MANAGED_MCP_SERVER_PREFIX,
  resolveRoleInstallEntries,
  supportsNativeCapabilityBinding,
} from './role-projection.js';
import { existingRuleSources, installedRuleIndex, loadRuleIndex, renderRulesLine } from './rules-index.js';
import {
  hashManagedBlock,
  isManagedIgnore,
  isManagedInstruction,
  isManagedJson,
  isManagedToml,
} from './managed-block.js';
import {
  hasManagedJsonPayload,
  managedJsonPayload,
  mergeManagedJsonConfig,
  removeManagedJsonConfig,
} from './managed-json-config.js';

async function loadProfileInstallMap({ adapterId = 'codex', allowPreview = false, profile, rootDir }) {
  const profiles = await readPackJson(path.join(rootDir, 'manifests/profiles.json'));
  validateCatalogManifest('profiles', profiles);

  const selectedProfile = profiles.items.find((item) => item.id === profile);
  if (!selectedProfile) {
    throw new Error(`Unknown profile: ${profile}`);
  }

  const adapter = await resolveAdapter(rootDir, adapterId);
  assertAdapterProfile(adapter, profile, { allowPreview });
  const catalog = await loadAdapterCatalog(rootDir);
  const skillRoots = skillRootPrefixes(catalog);
  const hookTargets = hookConfigTargets(catalog);
  const rawInstallMap = await readPackJson(path.join(rootDir, adapter.installMap));
  const knownGroups = new Set([
    ...profiles.items.flatMap((item) => item.groups),
    ...Object.values(moduleCatalog).flatMap((module) => module.groups),
  ]);
  validateInstallMapShape(rawInstallMap, knownGroups);
  const installMap = {
    ...rawInstallMap,
    adapter: adapter.id,
    entries: rawInstallMap.entries.map((entry) => resolveAdapterEntry(adapter, entry)).filter(Boolean),
    retiredEntries: (rawInstallMap.retiredEntries ?? []).map((entry) => resolveAdapterEntry(adapter, entry)).filter(Boolean),
  };

  return { adapter, installMap, selectedProfile, skillRoots, hookTargets };
}

async function packageVersion(rootDir) {
  const pkg = await readPackJson(path.join(rootDir, 'package.json'));
  return pkg.version;
}

function toolDiscoveryLine({ hasCodebaseMemoryMcp = false, hasCodeNavigationSkill = false } = {}) {
  const skillLead = hasCodeNavigationSkill ? '跨文件上下文先用 code-navigation Skill 建立；' : '';
  const graphRoute = hasCodebaseMemoryMcp
    ? '宿主提供 codebase-memory-mcp 时，用 list_projects 匹配项目根、index_status 检查状态，并用 check_index_coverage 核对证据路径；'
    : '';
  return '先按问题类型选工具：' + skillLead + graphRoute
    + '单文件文本、配置和日志使用 rg 与直接文件阅读。工具缺失或覆盖不足时回退当前源码；'
    + '不自动安装、升级或全量重建索引，不把 ready 或空结果当成完整覆盖证据。';
}

export function createInstalledSurface({ clarificationPosture = 'balanced', customModules = false, hookConfigTargets = [], memoryPath = '.agents/memory', profile, projectRuleSources = [], ruleIndex = [], skillRoots = [], targets }) {
  const installedTargets = targets.map((target) => target.replaceAll('\\', '/'));
  // The routing index covers what the project owns: this run's targets plus
  // rule files recorded in the install state from earlier transactions. See
  // `existingRuleSources` in rules-index.js.
  const routableTargets = [...installedTargets, ...projectRuleSources.map((source) => source.replaceAll('\\', '/'))];
  const hasTarget = (expectedTarget) => installedTargets.includes(expectedTarget);
  const hasPrefix = (prefix) => installedTargets.some((target) => target.startsWith(prefix));
  const hasInstalledOrExistingPrefix = (prefix) => routableTargets.some((target) => target.startsWith(prefix));
  const hasSkill = (suffix) => installedTargets.some((target) => target.endsWith(`/skills/${suffix}`));
  const isSkillRootTarget = skillRootMatcher(skillRoots);
  const detectedSkillRoots = [...new Set(installedTargets
    .filter((target) => isSkillRootTarget(target))
    .map((target) => target.split('/skills/')[0] + '/skills'))];
  const hasProjectScripts = hasTarget('.agents/runtime/commands/run.mjs');
  const hasCodebaseMemoryMcp = hasTarget('docs/rules/codebase-memory-mcp.md');
  const hasRoles = hasTarget('.agents/roles/index.md');
  const normalizedMemoryPath = memoryPath.replaceAll('\\', '/').replace(/\/+$/u, '');
  const hasLocalMemory = installedTargets.includes(`${normalizedMemoryPath}/README.md`);
  const hasGovernanceMemory = hasPrefix('docs/memory/');
  const installedIntegrationSkills = [
    hasSkill('browser-verification/SKILL.md') ? 'browser-verification' : null,
    hasSkill('agentmemory/SKILL.md') ? 'agentmemory' : null,
    hasSkill('linear-workflow/SKILL.md') ? 'linear-workflow' : null,
  ].filter(Boolean);
  const profileLines = {
    core: '- 当前安装方式：通用安装（不包含扩展 MCP 或 hooks 安装面）。',
    'docs-only': '- 当前安装方式：仅文档安装。',
    full: '- 当前安装方式：完整能力安装（包含十五个原生 Skills、可选 Eval 和 Codex 安全 hooks；memory 与外部工具仅通过 `--plugin` 显式启用）。',
    minimal: '- 当前安装方式：最小安装。',
  };

  const installedSurface = {
    clarificationPostureLine: hasSkill('clarify-requirements/SKILL.md')
      ? `- 需求澄清姿态：\`${clarificationPosture}\`（action-leaning 偏向采用最小可逆默认值直接推进；balanced 按规则判断；conservative 对尚未解决的高影响分歧更谨慎）。`
      : '',
    codebaseMemoryMcpLine: hasCodebaseMemoryMcp
      ? '- codebase-memory-mcp 使用规范位于 `docs/rules/codebase-memory-mcp.md`；仅使用宿主已提供的工具，不负责安装、配置、版本、索引或缓存管理。'
      : '',
    discoveryLine: hasTarget('docs/rules/codebase-memory-mcp.md')
      ? '若 `codebase-memory-mcp` 可用，先确认索引状态并用于结构化定位；不可用时说明并退回仓库搜索。'
      : '使用仓库搜索和已安装规则定位相关代码；需要结构化索引时先确认目标项目已有能力。',
    hasProjectScripts,
    hooksLine: hookConfigTargets
      .filter((entry) => hasTarget(entry.target))
      .map((entry) => `- ${entry.displayName} hook 配置位于 \`${entry.target}\`。`)
      .join(String.fromCharCode(10)),
    memoryLoadLine: hasGovernanceMemory && hasLocalMemory
      ? `从 \`${normalizedMemoryPath}/CURRENT.md\` 唯一入口恢复；治理真值按它引用的 \`docs/memory/PROJECT_STATE.md\` 读取，不复制其内容。`
      : (hasGovernanceMemory
        ? `读取 \`docs/memory/\` 的治理记忆（优先 \`PROJECT_STATE.md\`）恢复上下文；记忆仅作辅助，不覆盖当前源码与用户指令。`
        : (hasLocalMemory
          ? `读取 \`${normalizedMemoryPath}/README.md\` 与 \`CURRENT.md\` 恢复上下文；记忆仅作辅助，不覆盖当前源码与用户指令。`
          : '')),
    profileLine: customModules
      ? '- 当前安装方式：自定义能力模块安装。'
      : (profileLines[profile] ?? `- 当前 profile: \`${profile}\`。`),
    responseModeLine: routableTargets.includes('docs/rules/response-modes.md')
      ? '- 表达模式位于 `docs/rules/response-modes.md`：按任务类型自动选择，或消息内显式 `/模式名` 并可组合；模式只控制思考深度、表达方式与输出粒度，不改变任务目标、验证范围或安全边界。'
      : '',
    reviewLoopLine: '',
    rulesLine: hasInstalledOrExistingPrefix('docs/rules/') ? renderRulesLine(installedRuleIndex(ruleIndex, routableTargets)) : '',
    skillRoutingLine: detectedSkillRoots.length > 0
      ? '宿主按 Skill description 选择当前所需能力，按需补充互补 Skill；不使用 Router 或流程 Skill 链。'
      : '当前 profile 未安装 Skills；仅按已安装规则和模板执行，不引用未安装的 skill。',
    skillsLine: detectedSkillRoots.length > 0 ? `- Skills 位于 ${detectedSkillRoots.map((root) => `\`${root}/\``).join('、')}。` : '',
    templatesLine: hasPrefix('docs/templates/') ? '- 模板位于 `docs/templates/`。' : '',
    toolingLine: hasPrefix('.agents/runtime/tools/')
      ? `- 项目内工具位于 \`.agents/runtime/tools/\`；使用 \`vibe-harness doctor --project <path>\` 查看初始化状态。${hasTarget('docs/rules/chrome-devtools-mcp.md') ? ' Chrome DevTools MCP 规则位于 \`docs/rules/chrome-devtools-mcp.md\`。' : ''}${hasProjectScripts ? ' 项目级确定性脚本：\`node .agents/runtime/commands/run.mjs <env|context|changes|verify|worktree|slice|patch|task> --project . --json\`。' : ''}`
      : (hasProjectScripts ? '- 项目级确定性脚本：`node .agents/runtime/commands/run.mjs <env|context|changes|verify|worktree|slice|patch|task> --project . --json`。' : ''),
  };
  if (installedSurface.memoryLoadLine) {
    installedSurface.memoryLoadLine = '仅当需要恢复项目状态且已获授权时读 Memory body，'
      + installedSurface.memoryLoadLine
      + ' 专项 Skill 限制 Memory 证据边界时，只确认路径存在与元数据，不读正文。';
  }
  installedSurface.discoveryLine = toolDiscoveryLine({
    hasCodebaseMemoryMcp,
    hasCodeNavigationSkill: hasSkill('code-navigation/SKILL.md'),
  });
  if (hasRoles) {
    // Role files are optional context, not a startup step: loading one on every
    // read-only or local task costs tokens and buys nothing. Selection stays
    // available for the actions that actually need a second perspective.
    installedSurface.discoveryLine += ' 只有发生架构决策、独立验证或安全审查等角色触发场景时才按 docs/rules/role-routing.md 选择一个能力匹配的角色并只读其角色文件；普通只读、局部实现与聚焦验证不加载角色文件。';
    installedSurface.rulesLine += ' 多角色索引位于 .agents/roles/index.md。';
  }
  if (installedIntegrationSkills.length > 0) {
    installedSurface.profileLine += ' 当前另安装 integration Skills：'
      + installedIntegrationSkills.join('、')
      + '；它们不计入 profile 的原生领域 Skill 数量。';
  }
  return installedSurface;
}

function memoryTargetPath(renderData, relativeTarget) {
  const normalizedTarget = relativeTarget.replaceAll('\\', '/');
  if (!normalizedTarget.startsWith('.agents/memory/')) {
    return normalizedTarget;
  }
  const memoryPath = renderData.memory?.path ?? '.agents/memory';
  const normalizedMemoryPath = memoryPath.replaceAll('\\', '/').replace(/\/+$/u, '');
  const suffix = normalizedTarget.slice('.agents/memory/'.length);
  return `${normalizedMemoryPath}/${suffix}`;
}

function shouldInstallEntry(entry, renderData) {
  const normalizedTarget = entry.target.replaceAll('\\', '/');
  if (normalizedTarget.startsWith('.agents/memory/') && renderData.memory?.enabled === false) {
    return false;
  }
  return true;
}

function sourceForEntry(entrySource, renderData) {
  const localized = renderData.language === 'en-US'
    ? ({
        'templates/delivery.md': 'templates/delivery.en-US.md',
        'templates/task.md': 'templates/task.en-US.md',
      }[entrySource] ?? entrySource)
    : entrySource;
  return localized;
}

function createManagedMcpServers(targetDir, resolvedModules) {
  const chromeDevtoolsTool = path.join(targetDir, '.agents/runtime/tools/chrome-devtools-mcp/run.mjs');
  const servers = {};
  if (hasPluginCapability(resolvedModules, 'browser.devtools')) servers['chrome-devtools'] = {
      args: [chromeDevtoolsTool],
      command: process.execPath,
      env: {
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
      },
    };
  if (hasPluginCapability(resolvedModules, 'work-management.read-write')) servers.linear = {
    url: 'https://mcp.linear.app/mcp',
  };
  if (hasPluginCapability(resolvedModules, 'work-management.read-only')) servers.linear = {
    url: 'https://mcp.linear.app/mcp/readonly',
  };
  return servers;
}

/**
 * Capabilities this install actually resolves for the target host: the skills
 * that land under its skill root and the MCP servers it writes into its own
 * config. Hosts whose native role schema has no place for them return null, so
 * the projection never claims a binding the host cannot hold.
 */
function resolvedRoleCapabilities({ adapter, allowedGroups, installMap, moduleSelection, targetDir }) {
  if (!supportsNativeCapabilityBinding(adapter.id)) return null;
  const skillPrefix = adapter.skillRoot + '/';
  const skills = [...new Set(installMap.entries
    .filter((entry) => allowedGroups.has(entry.group))
    .map((entry) => {
      if (!entry.target.startsWith(skillPrefix) || !entry.target.endsWith('/SKILL.md')) return null;
      const name = entry.target.slice(skillPrefix.length, -'/SKILL.md'.length);
      return name.includes('/') ? null : name;
    })
    .filter(Boolean))].sort();
  const mcpServers = allowedGroups.has('mcp-config')
    ? Object.keys(createManagedMcpServers(path.resolve(targetDir), moduleSelection.resolvedModules))
      .map((name) => MANAGED_MCP_SERVER_PREFIX + name).sort()
    : [];
  return { mcpServers, skills };
}

function adapterConfigRedZone(adapter, target) {
  return adapter.redZonePrefixes.some((prefix) => target.startsWith(prefix.replaceAll('\\', '/')));
}

function formatMcpServers(servers, format = 'command-args-env') {
  if (format === 'command-args-env') return servers;
  if (format !== 'opencode-local') throw new Error('Unsupported MCP server format: ' + format);
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, server.url ? {
    type: 'remote',
    url: server.url,
    enabled: true,
  } : {
    type: 'local',
    command: [server.command, ...(server.args ?? [])],
    environment: { ...(server.env ?? {}) },
    enabled: true,
  }]));
}

async function resolveAdapterConfigTarget(definition, targetDir) {
  const candidates = [definition.target, ...(definition.alternateTargets ?? [])]
    .map((target) => target.replaceAll('\\', '/'));
  const existing = [];
  for (const candidate of candidates) {
    if (await pathExists(path.resolve(targetDir, candidate))) existing.push(candidate);
  }
  if (existing.length > 1) {
    throw new Error('Conflicting adapter configuration files: ' + existing.join(', ') + '. Keep exactly one.');
  }
  return existing[0] ?? candidates[0];
}

async function loadAdapterHookConfig(adapter, renderData, rootDir) {
  const source = path.join(rootDir, 'adapters', adapter.id, 'hooks.template.json');
  return JSON.parse(renderTemplate(await readFile(source, 'utf8'), renderData));
}

function managedJsonHash(content, descriptor) {
  return hashManagedBlock(managedJsonPayload(content, descriptor));
}

async function planAdapterConfigActions(ctx) {
  const { adapter, allowedGroups, force, managed, moduleSelection, renderData, rootDir, targetDir, upgrade } = ctx;
  if (!adapter.projectConfig) return [];

  const planned = new Map();
  const ensure = async (kind, definition) => {
    const target = await resolveAdapterConfigTarget(definition, targetDir);
    let item = planned.get(target);
    if (!item) {
      item = {
        descriptor: {
          hookMarker: 'Vibe-Harness safety policy',
          hooksPath: null,
          mcpPath: null,
          serverPrefix: MANAGED_MCP_SERVER_PREFIX,
          ...(definition.syntax && definition.syntax !== 'json' ? { syntax: definition.syntax } : {}),
        },
        kinds: [],
        target,
      };
      planned.set(target, item);
    }
    item.descriptor[`${kind}Path`] = definition.path;
    item.kinds.push(kind);
    return item;
  };

  const servers = createManagedMcpServers(path.resolve(targetDir), moduleSelection.resolvedModules);
  if (allowedGroups.has('mcp-config') && Object.keys(servers).length > 0 && adapter.projectConfig.mcp) {
    const item = await ensure('mcp', adapter.projectConfig.mcp);
    item.servers = formatMcpServers(servers, adapter.projectConfig.mcp.serverFormat);
  }
  if (allowedGroups.has('hooks') && adapter.projectConfig.hooks) {
    const item = await ensure('hooks', adapter.projectConfig.hooks);
    item.hooks = await loadAdapterHookConfig(adapter, renderData, rootDir);
  }

  const actions = [];
  for (const item of planned.values()) {
    const relativeTarget = item.target;
    const target = path.resolve(targetDir, relativeTarget);
    const kind = item.kinds.includes('hooks') ? 'hooks' : 'mcp';
    const relativeSource = `adapters/${adapter.id}/${kind}.template.json`;
    const source = path.resolve(rootDir, relativeSource);
    const exists = await pathExists(target);
    const managedFile = managed.get(relativeTarget);
    let actionKind = 'write';
    if (exists) {
      const content = await readFile(target, 'utf8');
      managedJsonPayload(content, item.descriptor);
      if (!force && managedFile) {
        actionKind = managedJsonHash(content, item.descriptor) === managedFile.managedBlockHash
          ? 'write'
          : 'user-modified';
      } else if (!force) {
        actionKind = hasManagedJsonPayload(content, item.descriptor) ? 'conflict' : 'write';
      }
    }
    if (upgrade && exists && !force && !managedFile && actionKind !== 'write') actionKind = 'conflict';
    actions.push({
      contentStrategy: 'managed-json-object',
      executable: false,
      group: 'adapter-config',
      hooks: item.hooks ?? {},
      kind: actionKind,
      managedJson: item.descriptor,
      mcpServers: item.servers ?? {},
      redZone: adapterConfigRedZone(adapter, relativeTarget),
      relativeSource,
      relativeTarget,
      source,
      target,
    });
  }
  return actions;
}

/** @param {{adapterId?: string, allowPreview?: boolean, configUpdate?: any, dryRun?: boolean, enforcementPolicy?: string, force?: boolean, managedAgentsBlock?: boolean, preserveRetired?: boolean, preserveUserModified?: boolean, profile?: string, requestedModules?: string[], requestedPlugins?: any, renderData?: Record<string, any>, rootDir: string, ruleIndex?: Array<{ id: string, source: string, title: string }>, targetDir: string, upgrade?: boolean}} options */
export async function createInstallPlan({
  adapterId = 'codex',
  allowPreview = false,
  configUpdate = null,
  dryRun = true,
  enforcementPolicy = 'advisory',
  force = false,
  managedAgentsBlock = false,
  preserveRetired = false,
  preserveUserModified = false,
  profile = 'core',
  requestedModules,
  requestedPlugins,
  ruleIndex,
  renderData = {},
  rootDir,
  targetDir,
  upgrade = false,
}) {
  if (preserveUserModified && !upgrade) {
    throw new Error('--preserve-user-modified requires --upgrade.');
  }
  if (preserveUserModified && force) {
    throw new Error('--preserve-user-modified cannot be combined with --force.');
  }

  const { adapter, installMap, selectedProfile, skillRoots, hookTargets } = await loadProfileInstallMap({ adapterId, allowPreview, profile, rootDir });
  const moduleSelection = resolveModuleSelection({
    profile,
    profileGroups: selectedProfile.groups,
    requestedModules,
    requestedPlugins,
    rolesEnabled: renderData.roles?.enabled,
  });
  const allowedGroups = moduleSelection.allowedGroups;
  const state = await readInstallState(path.resolve(targetDir));
  if (state && !state.targets && state.adapter !== adapter.id) {
    throw new Error(`Installed adapter ${state.adapter} does not match install target ${adapter.id}; uninstall the existing adapter first.`);
  }
  const managed = new Map((state?.files ?? []).map((file) => [file.target, file]));
  const baselinePlan = await createBaselinePlan({ baseline: state?.baseline, targetDir: path.resolve(targetDir) });

  const currentPackageVersion = await packageVersion(rootDir);
  const ctx = {
    adapter,
    allowedGroups,
    force,
    installMap,
    managed,
    managedAgentsBlock,
    moduleSelection,
    preserveRetired,
    preserveUserModified,
    renderData,
    rootDir,
    skillRoots,
    state,
    targetDir,
    upgrade,
  };

  const roleProjection = moduleSelection.resolvedModules.includes('roles')
    ? await resolveRoleInstallEntries({
        adapter,
        packageVersion: currentPackageVersion,
        resolvedCapabilities: resolvedRoleCapabilities({
          adapter,
          allowedGroups,
          installMap: ctx.installMap,
          moduleSelection,
          targetDir,
        }),
        rolesConfig: renderData.roles,
        rootDir,
        targetDir,
      })
    : null;
  if (roleProjection) {
    ctx.installMap = {
      ...ctx.installMap,
      entries: [...ctx.installMap.entries, ...roleProjection.entries],
    };
  }

  const actions = await planEntryActions(ctx);
  actions.push(...await planAdapterConfigActions(ctx));

  if (upgrade) {
    for (const action of actions) {
      const previous = managed.get(action.relativeTarget);
      if (previous && retiredToolGroups.has(previous.group) && action.kind === 'user-modified') {
        action.kind = 'retire-modified';
      }
      if (!previous || (!isManagedToml(action.contentStrategy) && !isManagedJson(action.contentStrategy)) || !(await pathExists(action.target))) continue;
      const content = await readFile(action.target, 'utf8');
      const payload = isManagedToml(previous.contentStrategy)
        ? extractManagedMcpBlock(content)
        : isManagedJson(previous.contentStrategy) ? managedJsonPayload(content, previous.managedJson) : '';
      if (payload.includes('codebase-memory') && (preserveRetired || hashManagedBlock(payload) !== previous.managedBlockHash)) {
        action.kind = 'retire-modified';
      }
    }
  }

  actions.push(...await planUpgradeRetirements(ctx, actions));

  const plannedTargets = new Set(actions.map((action) => action.relativeTarget));
  actions.push(...await planDeselectedModuleRetirements(ctx, plannedTargets));

  actions.push(...await planOrphanedStateRetirements(ctx, new Set(actions.map((action) => action.relativeTarget))));

  const generatedDirectories = computeGeneratedDirectories(ctx, actions);

  const resolvedRuleIndex = ruleIndex ?? await loadRuleIndex(rootDir);
  // The installed surface describes what the project has after the plan, not
  // what this run happens to rewrite: a kept file can be classified as
  // `write`, `user-modified` or `conflict` depending on `--force` and the
  // file's current content, and retired targets leave the project entirely.
  // Deriving the surface from the write set alone made the resident rule
  // index change with unrelated local edits.
  const retainedTargets = planRetainedTargets(actions);
  const removedTargets = planRemovedTargets(actions);
  const installedSurface = createInstalledSurface({
    clarificationPosture: renderData.clarification?.posture,
    customModules: moduleSelection.requestedModules !== null,
    hookConfigTargets: hookTargets,
    memoryPath: renderData.memory?.path,
    profile,
    // A rule file already on disk is routable, but one this run retires is not:
    // the line has to lose it in the same run that removes it.
    projectRuleSources: (await existingRuleSources(targetDir, resolvedRuleIndex))
      .filter((source) => !removedTargets.has(source)),
    ruleIndex: resolvedRuleIndex,
    skillRoots,
    targets: retainedTargets,
  });
  const owner = 'adapter:' + adapter.id;
  const adapterConfigTargets = new Set(Object.values(adapter.projectConfig ?? {})
    .flatMap((item) => [item.target, ...(item.alternateTargets ?? [])]));
  const projectionTarget = (target) => target === adapter.instructionTarget
    || adapterConfigTargets.has(target)
    || (adapter.skillRoot !== '.agents/skills' && target.startsWith(adapter.skillRoot + '/'))
    || target.startsWith(adapter.roleProjection.targetRoot + '/')
    || (adapter.id === 'zcode' && target.startsWith('.zcode/plugins/vibe-harness-roles/'))
    || (adapter.id === 'antigravity' && ['.agents/hooks.json', '.agents/mcp_config.json', '.agents/rules/vibe-harness.md'].includes(target));
  const ownedActions = actions.map((action) => ({
    ...action,
    adapterId: adapter.id,
    owners: action.owners ?? [projectionTarget(action.relativeTarget) ? owner : 'shared'],
  }));
  const linearAccess = moduleSelection.resolvedModules.includes('linear')
    ? 'read-write'
    : (moduleSelection.resolvedModules.includes('linear-readonly') ? 'read-only' : null);
  const linearEndpoint = linearAccess === 'read-write'
    ? 'https://mcp.linear.app/mcp'
    : 'https://mcp.linear.app/mcp/readonly';
  const linearMcp = linearAccess ? {
    access: linearAccess,
    configuration: ownedActions.some((action) => action.mcpServers?.linear) ? 'managed' : 'manual',
    endpoint: linearEndpoint,
  } : null;

  const hookSupported = adapter.hookActivation !== 'unsupported';
  const strictEnforcementRefusals = enforcementPolicy === 'strict'
    && !hookSupported
    && actions.some((action) => action.redZone && action.kind === 'write')
    ? [adapter.id]
    : [];

  const plan = {
    adapter: adapter.id,
    adapterCapabilities: adapter.capabilities,
    baselinePlan,
    configUpdate,
    dryRun,
    enforcementPolicy,
    force,
    generatedDirectories: generatedDirectories.map((item) => ({ ...item, owners: item.owners ?? ['shared'] })),
    implicitModules: moduleSelection.implicitModules,
    instructionTarget: adapter.instructionTarget,
    linearMcp,
    missingCapabilities: Object.entries(adapter.capabilities).filter(([, status]) => status === 'unsupported').map(([name]) => name),
    profile,
    preserveRetired,
    preserveUserModified,
    previewCapabilities: Object.entries(adapter.capabilities).filter(([, status]) => status === 'preview').map(([name]) => name),
    requestedModules: moduleSelection.requestedModules,
    requestedPlugins: moduleSelection.requestedPlugins,
    resolvedModules: moduleSelection.resolvedModules,
    roleProjection: roleProjection ? {
      ...roleProjection.diagnostics,
      roles: roleProjection.roles,
    } : null,
    renderData: withDefaultTemplateData({
      ...renderData,
      installedSurface: renderData.installedSurface ?? installedSurface,
    }),
    redZoneConfirmed: false,
    skillRoots,
    hookTargets,
    targetDir: path.resolve(targetDir),
    upgrade,
    version: currentPackageVersion,
    hookSupported,
    strictEnforcementRefusals,
    actions: ownedActions,
  };
  await classifyActualInstallChanges(plan);
  plan.strictEnforcementRefusals = enforcementPolicy === 'strict'
    && !hookSupported
    && plan.actions.some((action) => action.redZone && isMutatingInstallAction(action)) ? [adapter.id] : [];
  return plan;
}

export function isMutatingInstallAction(action) {
  return action.kind === 'write' || ['retire', 'retire-managed-ignore', 'retire-managed-json',
    'retire-managed-mcp', 'retire-generated-directory', 'retire-runtime-state'].includes(action.kind);
}

async function classifyActualInstallChanges(plan) {
  for (const action of plan.actions) {
    if (action.kind !== 'write' && action.kind !== 'unchanged') continue;
    const exists = await pathExists(action.target);
    const existing = exists ? await readFile(action.target, 'utf8') : '';
    const merged = isManagedToml(action.contentStrategy)
      ? mergeManagedMcpBlock(existing, action.mcpServers, { force: plan.force }) : null;
    const content = merged?.content ?? await renderActionContent(action, actionRenderData(action, plan.renderData), existing);
    action.expectedTargetHash = exists ? createHash('sha256').update(existing).digest('hex') : null;
    action.expectedSourceHash = await hashFile(action.source);
    action.plannedContentHash = createHash('sha256').update(content).digest('hex');
    const modeMatches = !action.executable || process.platform === 'win32'
      || exists && ((await stat(action.target)).mode & 0o777) === 0o755;
    action.kind = exists && existing === content && modeMatches && !merged?.conflicts.length ? 'unchanged' : 'write';
  }
}

function mergeOwners(left = [], right = []) {
  return [...new Set([...left, ...right])].sort();
}

function strictRefusedAdapters(plans, actualActions = null) {
  const actual = actualActions ? new Map(actualActions.map((action) => [action.relativeTarget, action])) : null;
  const mutates = (action) => isMutatingInstallAction(actual ? actual.get(action.relativeTarget) ?? {} : action);
  const redZoneOwners = new Map();
  for (const plan of plans) {
    const unsupported = !plan.hookSupported;
    for (const action of plan.actions) {
      if (!action.redZone || !mutates(action)) continue;
      const owners = redZoneOwners.get(action.relativeTarget) ?? { enforcing: false, unsupported: false };
      owners.enforcing = owners.enforcing || !unsupported;
      owners.unsupported = owners.unsupported || unsupported;
      redZoneOwners.set(action.relativeTarget, owners);
    }
  }
  const deniedTargets = [...redZoneOwners.entries()]
    .filter(([, owners]) => owners.unsupported && !owners.enforcing)
    .map(([target]) => target);
  if (deniedTargets.length === 0) return [];
  const denied = new Set(deniedTargets);
  return [...new Set(plans
    .filter((plan) => !plan.hookSupported
      && plan.actions.some((action) => action.redZone && mutates(action) && denied.has(action.relativeTarget)))
    .map((plan) => plan.adapter))];
}

/**
 * Report-facing form of the strict refusal: a blocking warning so dry-runs and
 * read-only commands surface the denial, while applyInstallPlan refuses the
 * real write. Returns an empty list under the default "advisory" policy.
 *
 * @param {string[] | null | undefined} refusals
 */
export function strictEnforcementWarnings(refusals) {
  return (refusals ?? []).length > 0
    ? [{
        code: 'HIGH_RISK_WRITES_DENIED',
        message: 'Hosts without a high-risk execution envelope ('
          + [...refusals].join(', ')
          + ') exclusively own red-zone projections; hooks.enforcement is "strict", so these high-risk writes are denied. Drop the unsupported targets or the hooks-facing modules, or set hooks.enforcement to "advisory".',
        blocking: true,
      }]
    : [];
}

function compatibleActions(left, right) {
  if (left.relativeTarget !== right.relativeTarget || left.contentStrategy !== right.contentStrategy) return false;
  if (left.relativeTarget === 'AGENTS.md') return true;
  return left.relativeSource === right.relativeSource
    && left.inlineContent === right.inlineContent
    && JSON.stringify(left.managedJson ?? null) === JSON.stringify(right.managedJson ?? null)
    && JSON.stringify(left.mcpServers ?? null) === JSON.stringify(right.mcpServers ?? null)
    && JSON.stringify(left.hooks ?? null) === JSON.stringify(right.hooks ?? null);
}

/** @param {Record<string, any> & {selectedTargets?: string[], targets: string[], rootDir: string, targetDir: string}} options */
export async function createMultiTargetInstallPlan({ selectedTargets, targets, ...options }) {
  const configuredTargets = [...new Set(targets)];
  const installedState = await readInstallState(path.resolve(options.targetDir));
  const lifecycleTargets = [...new Set([...configuredTargets, ...(installedState?.targets ?? [])])];
  const activeTargets = selectedTargets?.length ? selectedTargets : configuredTargets;
  // The rule index is pack-owned and adapter-independent: build it once for the
  // whole multi-target plan instead of re-reading every rule file per adapter.
  const resolvedRuleIndex = options.ruleIndex ?? await loadRuleIndex(options.rootDir);
  // Planning is read-only against the target project, so per-adapter plans can
  // build concurrently; conflict detection below still merges deterministically
  // in configured-target order.
  const plans = await Promise.all(activeTargets.map((adapterId) => createInstallPlan({
    ...options,
    adapterId,
    ruleIndex: resolvedRuleIndex,
    renderData: { ...options.renderData, target: adapterId, targets: configuredTargets },
  })));
  if (plans.length === 0) throw new Error('At least one install target is required.');

  const writes = new Map();
  const retirements = [];
  for (const plan of plans) {
    for (const action of plan.actions) {
      if (action.kind.startsWith('retire')) {
        retirements.push(action);
        continue;
      }
      const existing = writes.get(action.relativeTarget);
      if (!existing) {
        writes.set(action.relativeTarget, action);
        continue;
      }
      if (!compatibleActions(existing, action)) {
        writes.set(action.relativeTarget, {
          ...existing,
          kind: 'conflict',
          owners: mergeOwners(existing.owners, action.owners),
          planningConflict: true,
        });
        continue;
      }
      writes.set(action.relativeTarget, {
        ...existing,
        kind: existing.kind === 'user-modified' || action.kind === 'user-modified'
          ? 'user-modified'
          : existing.kind === 'conflict' || action.kind === 'conflict' ? 'conflict' : 'write',
        owners: mergeOwners(existing.owners, action.owners),
        ...(existing.projectContentRetained || action.projectContentRetained
          ? { projectContentRetained: true }
          : {}),
      });
    }
  }
  const plannedTargets = new Set(writes.keys());
  const allTargetsSelected = activeTargets.length === lifecycleTargets.length
    && activeTargets.every((target) => lifecycleTargets.includes(target));
  const actions = [
    ...writes.values(),
    ...(allTargetsSelected ? retirements.filter((action) => !plannedTargets.has(action.relativeTarget)) : []),
  ];
  const removedTargets = planRemovedTargets(actions);
  const installedSurface = createInstalledSurface({
    clarificationPosture: options.renderData?.clarification?.posture,
    customModules: plans[0].requestedModules !== null,
    hookConfigTargets: plans[0].hookTargets,
    memoryPath: options.renderData?.memory?.path,
    profile: plans[0].profile,
    projectRuleSources: (await existingRuleSources(options.targetDir, resolvedRuleIndex))
      .filter((source) => !removedTargets.has(source)),
    ruleIndex: resolvedRuleIndex,
    skillRoots: plans[0].skillRoots,
    targets: [...writes.keys()],
  });
  const generatedDirectories = [...new Map(plans.flatMap((plan) => plan.generatedDirectories)
    .map((item) => [item.target, item])).values()];
  const plan = {
    ...plans[0],
    actions,
    adapter: activeTargets[0],
    adapters: Object.fromEntries(plans.map((plan) => [plan.adapter, {
      capabilities: plan.adapterCapabilities,
      missingCapabilities: plan.missingCapabilities,
      previewCapabilities: plan.previewCapabilities,
      roleProjection: plan.roleProjection,
    }])),
    strictEnforcementRefusals: options.enforcementPolicy === 'strict' ? strictRefusedAdapters(plans) : [],
    linearMcp: Object.fromEntries(plans
      .filter((plan) => plan.linearMcp)
      .map((plan) => [plan.adapter, plan.linearMcp])),
    generatedDirectories,
    missingCapabilities: [...new Set(plans.flatMap((plan) => plan.missingCapabilities))],
    previewCapabilities: [...new Set(plans.flatMap((plan) => plan.previewCapabilities))],
    roleProjections: Object.fromEntries(plans
      .filter((plan) => plan.roleProjection)
      .map((plan) => [plan.adapter, plan.roleProjection])),
    renderData: withDefaultTemplateData({
      ...plans[0].renderData,
      installedSurface,
      targets: configuredTargets,
    }),
    selectedTargets: activeTargets,
    targets: lifecycleTargets,
  };
  await classifyActualInstallChanges(plan);
  plan.strictEnforcementRefusals = options.enforcementPolicy === 'strict' ? strictRefusedAdapters(plans, plan.actions) : [];
  return plan;
}

async function planEntryActions(ctx) {
  const { adapter, allowedGroups, force, installMap, managed, managedAgentsBlock, moduleSelection, renderData, rootDir, targetDir, upgrade } = ctx;
  const actions = [];
  for (const entry of installMap.entries) {
    if (!allowedGroups.has(entry.group)) {
      continue;
    }
    if (!shouldInstallEntry(entry, renderData)) {
      continue;
    }
    assertPortableRelativePath(entry.source, 'install source');
    const localizedSource = entry.sourceRoot === 'project'
      ? entry.source
      : sourceForEntry(entry.source, renderData);
    assertPortableRelativePath(localizedSource, 'localized install source');
    const mappedTarget = memoryTargetPath(renderData, entry.target);
    assertPortableRelativePath(mappedTarget, 'install target');
    const sourceBase = entry.sourceRoot === 'project' ? targetDir : rootDir;
    const source = path.resolve(sourceBase, localizedSource);
    const target = path.resolve(targetDir, mappedTarget);
    assertInsideDir(sourceBase, source, 'install source');
    assertInsideDir(targetDir, target, 'install target');
    await assertSafePathInside(sourceBase, source, 'install source');
    await assertSafePathInside(targetDir, target, 'install target');
    const relativeSource = localizedSource.replaceAll('\\', '/');
    const relativeTarget = mappedTarget;
    const contentStrategy = entry.contentStrategy === 'managed-instruction-block'
      ? (managedAgentsBlock && relativeTarget === adapter.instructionTarget ? entry.contentStrategy : 'replace')
      : entry.contentStrategy;
    const exists = await pathExists(target);
    let kind = exists && !force ? 'conflict' : 'write';
    let projectContentRetained = false;
    const managedFile = managed.get(relativeTarget);
    const blockCompared = isManagedInstruction(contentStrategy)
      || isManagedToml(contentStrategy)
      || isManagedIgnore(contentStrategy);

    if (exists && managedFile && !force) {
      let currentHash;
      if (blockCompared) {
        const content = await readFile(target, 'utf8');
        const block = isManagedInstruction(contentStrategy)
          ? extractManagedInstructionBlock(content)
          : isManagedToml(contentStrategy)
            ? extractManagedMcpBlock(content)
            : extractManagedCbmIgnoreBlock(content);
        currentHash = hashManagedBlock(block);
      } else {
        currentHash = await hashFile(target);
      }
      const expectedHash = blockCompared ? managedFile.managedBlockHash : managedFile.targetHash;
      // A project-owned seed belongs to the project once written: when its
      // content drifted from the recorded hash the installer keeps what the
      // project wrote, re-records that content as the new baseline, and reports
      // the target. Harness-owned files keep failing closed below.
      projectContentRetained = Boolean(entry.projectOwned) && currentHash !== expectedHash;
      kind = currentHash === expectedHash || projectContentRetained ? 'write' : 'user-modified';
    } else if (exists && managedFile && force && entry.projectOwned && !blockCompared) {
      // `--force` reinstalls harness-owned targets; a project-owned seed still
      // keeps the project's content, so the report must say so instead of
      // implying the seed itself was reinstalled.
      projectContentRetained = await hashFile(target) !== managedFile.targetHash;
    } else if (isManagedInstruction(contentStrategy) || isManagedToml(contentStrategy)) {
      kind = 'write';
    } else if (isManagedIgnore(contentStrategy)) {
      const hasManagedBlock = exists && Boolean(extractManagedCbmIgnoreBlock(await readFile(target, 'utf8')));
      kind = !exists || force || hasManagedBlock ? 'write' : 'conflict';
    }

    if (upgrade) {
      if (!exists || force) kind = 'write';
      else if (!managedFile && !(isManagedIgnore(contentStrategy)
        && extractManagedCbmIgnoreBlock(await readFile(target, 'utf8')))) {
        kind = 'conflict';
      }
    }

    actions.push({
      group: entry.group,
      kind,
      contentStrategy,
      executable: Boolean(entry.executable),
      projectOwned: Boolean(entry.projectOwned),
      mcpServers: isManagedToml(contentStrategy)
        ? createManagedMcpServers(path.resolve(targetDir), moduleSelection.resolvedModules)
        : undefined,
      inlineContent: entry.inlineContent,
      redZone: Boolean(entry.redZone),
      relativeSource,
      relativeTarget,
      source,
      target,
      ...(projectContentRetained ? { projectContentRetained: true } : {}),
    });
  }
  return actions;
}

async function planUpgradeRetirements(ctx, entryActions) {
  const { state, targetDir, upgrade } = ctx;
  if (!upgrade) return [];
  const actions = [];
  // A single ownership-based pass covers retired groups and Skills too.
  // Never infer ownership from a filename or the new profile's group list.
  const currentPlanTargets = new Set(entryActions.map((action) => action.relativeTarget));
  for (const managedFile of state?.files ?? []) {
    const relativeTarget = managedFile.target.replaceAll('\\', '/');
    if (currentPlanTargets.has(relativeTarget)) continue;
    assertPortableRelativePath(relativeTarget, 'obsolete managed target');
    const target = path.resolve(targetDir, relativeTarget);
    assertInsideDir(targetDir, target, 'obsolete managed target');
    await assertSafePathInside(targetDir, target, 'obsolete managed target');
    if (!(await pathExists(target))) continue;
    const managedBlock = isManagedJson(managedFile.contentStrategy) || isManagedToml(managedFile.contentStrategy) || isManagedIgnore(managedFile.contentStrategy);
    const content = managedBlock ? await readFile(target, 'utf8') : null;
    const currentHash = isManagedJson(managedFile.contentStrategy)
      ? managedJsonHash(content, managedFile.managedJson)
      : isManagedToml(managedFile.contentStrategy)
        ? hashManagedBlock(extractManagedMcpBlock(content))
        : isManagedIgnore(managedFile.contentStrategy)
          ? hashManagedBlock(extractManagedCbmIgnoreBlock(content)) : await hashFile(target);
    const expectedHash = managedBlock ? managedFile.managedBlockHash : managedFile.targetHash;
    const retireKind = isManagedJson(managedFile.contentStrategy) ? 'retire-managed-json'
      : isManagedToml(managedFile.contentStrategy) ? 'retire-managed-mcp'
        : isManagedIgnore(managedFile.contentStrategy) ? 'retire-managed-ignore' : 'retire';
    actions.push({
      created: Boolean(managedFile.originalCreated ?? managedFile.created),
      discard: true,
      expectedHash,
      group: managedFile.group,
      contentStrategy: managedFile.contentStrategy,
      kind: currentHash === expectedHash ? retireKind : 'retire-modified',
      ...(isManagedJson(managedFile.contentStrategy) ? { managedJson: managedFile.managedJson } : {}),
      redZone: Boolean(managedFile.redZone),
      relativeTarget,
      target,
    });
    currentPlanTargets.add(relativeTarget);
  }
  // Task/session data is not an installed asset. Never infer permission to
  // delete it from an upgrade, even after the commands that used it retire.
  return actions;
}

/**
 * Project-relative targets the plan removes from the project.
 *
 * A `retire`/`discard` action is how the installer releases a target, so the
 * set is the complement of what survives the run. It is what stops the resident
 * index from advertising a rule file in the very plan that deletes it — for
 * example when `--plugin none` retires the optional-tool rules.
 *
 * @param {Array<Record<string, any>>} actions planned actions
 * @returns {Set<string>} project-relative targets that leave the project
 */
function planRemovedTargets(actions) {
  return new Set(actions
    .filter((action) => action.discard === true || String(action.kind ?? '').startsWith('retire'))
    .map((action) => action.relativeTarget));
}

/**
 * Targets the project keeps after the plan.
 *
 * Retired and discarded targets leave the project, so the installed-surface
 * lines must not describe them.
 *
 * @param {Array<Record<string, any>>} actions planned actions
 * @returns {string[]} project-relative targets that survive the plan
 */
function planRetainedTargets(actions) {
  const removed = planRemovedTargets(actions);
  return actions
    .filter((action) => !removed.has(action.relativeTarget))
    .map((action) => action.relativeTarget);
}

/**
 * Release registrations whose target is gone and that this plan does not manage.
 *
 * install-state can keep a target that no longer exists: a rule file renamed
 * away, a module removed by hand, or a file the user deleted before the pack
 * declared it retired. `mergeInstallState` carries unplanned registrations
 * forward, so without this step the entry survives every install and the
 * installed surface keeps advertising a file the project does not have.
 * `checkSelfInstallConformance` reports exactly this as `orphanedStateTargets`,
 * so the installer converges the same predicate the gate fails on. Nothing is
 * deleted here — the target is already absent, so the action only drops the
 * registration.
 */
async function planOrphanedStateRetirements(ctx, plannedTargets) {
  const { state, targetDir } = ctx;
  const managed = new Set(plannedTargets);
  const actions = [];
  for (const managedFile of state?.files ?? []) {
    const relativeTarget = managedFile.target.replaceAll('\\', '/');
    if (managed.has(relativeTarget)) continue;
    assertPortableRelativePath(relativeTarget, 'orphaned managed target');
    const target = path.resolve(targetDir, relativeTarget);
    assertInsideDir(targetDir, target, 'orphaned managed target');
    // Check the cheap lexical facts before the symbolic-link walk: this loop
    // visits every registration, while only a handful become actions.
    if (await pathExists(target)) continue;
    await assertSafePathInside(targetDir, target, 'orphaned managed target');
    actions.push({ discard: true, kind: 'retire-missing', redZone: false, relativeTarget, target });
    managed.add(relativeTarget);
  }
  return actions;
}

async function planDeselectedModuleRetirements(ctx, plannedTargets) {
  const { allowedGroups, moduleSelection, state, targetDir } = ctx;
  const actions = [];
  const currentModules = new Set(moduleSelection.resolvedModules);
  const removedGroups = new Set([...retiredToolGroups, ...(state?.resolvedModules ?? [])
    .filter((id) => !currentModules.has(id) && Object.hasOwn(moduleCatalog, id))
    .flatMap((id) => moduleCatalog[id].groups)]);
  for (const managedFile of state?.files ?? []) {
    const relativeTarget = managedFile.target.replaceAll('\\', '/');
    if (!removedGroups.has(managedFile.group)
      || allowedGroups.has(managedFile.group)
      || plannedTargets.has(relativeTarget)) {
      continue;
    }
    assertPortableRelativePath(relativeTarget, 'deselected module target');
    const target = path.resolve(targetDir, relativeTarget);
    assertInsideDir(targetDir, target, 'deselected module target');
    await assertSafePathInside(targetDir, target, 'deselected module target');
    if (!(await pathExists(target))) continue;
    let currentHash;
    let expectedHash;
    let kind = 'retire';
    if (isManagedToml(managedFile.contentStrategy) || isManagedIgnore(managedFile.contentStrategy) || isManagedJson(managedFile.contentStrategy)) {
      const content = await readFile(target, 'utf8');
      const block = isManagedToml(managedFile.contentStrategy)
        ? extractManagedMcpBlock(content)
        : isManagedIgnore(managedFile.contentStrategy)
          ? extractManagedCbmIgnoreBlock(content)
          : managedJsonPayload(content, managedFile.managedJson);
      currentHash = hashManagedBlock(block);
      expectedHash = managedFile.managedBlockHash;
      kind = currentHash === expectedHash
        ? (isManagedToml(managedFile.contentStrategy)
          ? 'retire-managed-mcp'
          : isManagedIgnore(managedFile.contentStrategy)
            ? 'retire-managed-ignore'
            : 'retire-managed-json')
        : 'retire-modified';
    } else {
      currentHash = await hashFile(target);
      expectedHash = managedFile.targetHash;
      kind = currentHash === expectedHash ? 'retire' : 'retire-modified';
    }
    actions.push({
      created: Boolean(managedFile.originalCreated ?? managedFile.created),
      discard: true,
      expectedHash,
      group: managedFile.group,
      contentStrategy: managedFile.contentStrategy,
      kind,
      ...(isManagedJson(managedFile.contentStrategy) ? { managedJson: managedFile.managedJson } : {}),
      redZone: Boolean(managedFile.redZone),
      relativeTarget,
      target,
    });
    plannedTargets.add(relativeTarget);
  }
  return actions;
}

function computeGeneratedDirectories(ctx, actions) {
  const { targetDir } = ctx;
  const generatedDirectories = actions.some((action) => action.kind === 'write' && action.group === 'tools-playwright')
    ? [{
        ownerTarget: `${PLAYWRIGHT_TOOL_RELATIVE_DIR}/package.json`,
        target: PLAYWRIGHT_GENERATED_RELATIVE_DIR,
      }]
    : [];
  const stateDirectory = path.basename(path.dirname(stateFilePath(path.resolve(targetDir))));
  for (const component of ['chrome-devtools-mcp', 'open-code-review']) {
    const ownerTarget = `.agents/runtime/tools/${component}/package.json`;
    if (actions.some((action) => action.kind === 'write' && action.relativeTarget === ownerTarget)) {
      generatedDirectories.push({ ownerTarget, target: `.agents/runtime/tools/${component}/node_modules` });
      generatedDirectories.push({
        ownerTarget,
        projectScoped: true,
        target: `${stateDirectory}/tool-state/${component}`,
      });
      generatedDirectories.push({
        ownerTarget,
        projectScoped: true,
        target: `${stateDirectory}/tool-state/npm-cache/${component === 'chrome-devtools-mcp' ? 'chromeDevtoolsMcp' : component === 'open-code-review' ? 'openCodeReview' : component}`,
      });
    }
  }
  return generatedDirectories;
}

export async function renderSourceContent(action, renderData = {}) {
  if (typeof action.inlineContent === 'string') return action.inlineContent;
  const content = await readFile(action.source, 'utf8');
  return renderTemplate(content, renderData);
}

export async function renderActionContent(action, renderData = {}, existingContent = '') {
  if (isManagedJson(action.contentStrategy)) {
    return mergeManagedJsonConfig(existingContent, action.managedJson, {
      hooks: action.hooks,
      servers: action.mcpServers,
    });
  }
  if (isManagedToml(action.contentStrategy)) {
    return mergeManagedMcpBlock(existingContent, action.mcpServers).content;
  }
  // Project-owned entries are seeded once and then belong to the project. The
  // installer must never overwrite what the project wrote into its own
  // governance or runtime memory files.
  if (action.projectOwned && existingContent !== '') return existingContent;
  const rendered = await renderSourceContent(action, renderData);
  if (isManagedIgnore(action.contentStrategy)) {
    return mergeManagedCbmIgnoreBlock(existingContent, rendered);
  }
  if (isManagedInstruction(action.contentStrategy)) {
    return mergeManagedInstructionBlock(existingContent, rendered);
  }
  return rendered;
}

function actionRenderData(action, renderData) {
  return action.adapterId ? { ...renderData, target: action.adapterId } : renderData;
}

export async function previewInstallPlan(plan, { includeContent = true } = {}) {
  const previewFiles = [];
  for (const action of plan.actions) {
    if (action.kind !== 'write') {
      continue;
    }
    const existingContent = (isManagedInstruction(action.contentStrategy)
      || isManagedJson(action.contentStrategy)
      || isManagedToml(action.contentStrategy)
      || isManagedIgnore(action.contentStrategy)
      || action.projectOwned) && await pathExists(action.target)
      ? await readFile(action.target, 'utf8')
      : '';
    const mergedMcp = isManagedToml(action.contentStrategy)
      ? mergeManagedMcpBlock(existingContent, action.mcpServers, { force: plan.force })
      : null;
    const content = mergedMcp?.content ?? await renderActionContent(action, actionRenderData(action, plan.renderData), existingContent);
    previewFiles.push({
      byteCount: Buffer.byteLength(content),
      conflicts: mergedMcp?.conflicts ?? [],
      contentHash: createHash('sha256').update(content).digest('hex').slice(0, 12),
      ...(includeContent ? { content } : {}),
      target: action.relativeTarget,
    });
  }
  return previewFiles;
}

/** @param {{adapterId?: string, allowPreview?: boolean, managedAgentsBlock?: boolean, profile?: string, requestedModules?: string[], requestedPlugins?: any, renderData?: Record<string, any>, rootDir: string, targetDir: string}} options */
export async function diffTargetInstall({
  adapterId = 'codex',
  allowPreview = true,
  managedAgentsBlock = false,
  profile = 'core',
  requestedModules,
  requestedPlugins,
  renderData = {},
  rootDir,
  targetDir,
}) {
  const { adapter, installMap, selectedProfile, skillRoots, hookTargets } = await loadProfileInstallMap({ adapterId, allowPreview, profile, rootDir });
  const moduleSelection = resolveModuleSelection({
    profile,
    profileGroups: selectedProfile.groups,
    requestedModules,
    requestedPlugins,
    rolesEnabled: renderData.roles?.enabled,
  });
  const allowedGroups = moduleSelection.allowedGroups;
  const roleProjection = moduleSelection.resolvedModules.includes('roles')
    ? await resolveRoleInstallEntries({
        adapter,
        packageVersion: await packageVersion(rootDir),
        resolvedCapabilities: resolvedRoleCapabilities({
          adapter,
          allowedGroups,
          installMap,
          moduleSelection,
          targetDir,
        }),
        rolesConfig: renderData.roles,
        rootDir,
        targetDir,
      })
    : null;
  const effectiveEntries = roleProjection
    ? [...installMap.entries, ...roleProjection.entries]
    : installMap.entries;
  const selectedEntries = effectiveEntries.filter((entry) => allowedGroups.has(entry.group) && shouldInstallEntry(entry, renderData));
  const adapterConfigActions = await planAdapterConfigActions({
    adapter,
    allowedGroups,
    force: false,
    managed: new Map(),
    moduleSelection,
    renderData: withDefaultTemplateData(renderData),
    rootDir,
    targetDir,
    upgrade: false,
  });
  const installedTargets = [
    ...selectedEntries.map((entry) => memoryTargetPath(renderData, entry.target)),
    ...adapterConfigActions.map((action) => action.relativeTarget),
  ];
  const diffRuleIndex = await loadRuleIndex(rootDir);
  const renderedData = withDefaultTemplateData({
    ...renderData,
    installedSurface: renderData.installedSurface ?? createInstalledSurface({
      clarificationPosture: renderData.clarification?.posture,
      customModules: moduleSelection.requestedModules !== null,
      hookConfigTargets: hookTargets,
      memoryPath: renderData.memory?.path,
      profile,
      projectRuleSources: await existingRuleSources(targetDir, diffRuleIndex),
      ruleIndex: diffRuleIndex,
      skillRoots,
      targets: installedTargets,
    }),
  });
  const expected = [];
  const missing = [];
  const same = [];
  const changed = [];
  const redZone = [];
  const expectedTargets = new Set();

  for (const entry of selectedEntries) {
    assertPortableRelativePath(entry.source, 'install source');
    const mappedTarget = memoryTargetPath(renderData, entry.target);
    assertPortableRelativePath(mappedTarget, 'install target');
    const target = path.resolve(targetDir, mappedTarget);
    const sourceBase = entry.sourceRoot === 'project' ? targetDir : rootDir;
    const relativeSource = entry.sourceRoot === 'project' ? entry.source : sourceForEntry(entry.source, renderData);
    const source = path.resolve(sourceBase, relativeSource);
    assertInsideDir(sourceBase, source, 'install source');
    assertInsideDir(targetDir, target, 'install target');
    const item = {
      contentStrategy: entry.contentStrategy === 'managed-instruction-block'
        ? (managedAgentsBlock && mappedTarget === adapter.instructionTarget ? entry.contentStrategy : 'replace')
        : entry.contentStrategy,
      group: entry.group,
      inlineContent: entry.inlineContent,
      mcpServers: mappedTarget === '.codex/config.toml'
        ? createManagedMcpServers(path.resolve(targetDir), moduleSelection.resolvedModules)
        : undefined,
      projectOwned: Boolean(entry.projectOwned),
      redZone: Boolean(entry.redZone),
      source,
      target: mappedTarget,
    };
    expected.push(item);
    expectedTargets.add(item.target);
    if (item.redZone) {
      redZone.push({ ...item, status: await pathExists(target) ? 'present' : 'missing' });
    }

    if (await pathExists(target)) {
      const [sourceContent, targetContent] = await Promise.all([
        renderSourceContent(item, renderedData),
        readFile(target, 'utf8'),
      ]);
      // Two targets cannot drift from their source by construction:
      // project-owned seeds are written once and then edited by the project,
      // and entries whose source path is the target itself (self-installed
      // pack assets such as docs/rules/*.md) are their own source of truth.
      const matches = item.projectOwned || sameResolvedPath(item.source, target)
        ? true
        : isManagedInstruction(item.contentStrategy)
          ? extractManagedInstructionBlock(targetContent) === renderManagedInstructionBlock(sourceContent)
          : isManagedToml(item.contentStrategy)
            ? mergeManagedMcpBlock(
                targetContent,
                createManagedMcpServers(path.resolve(targetDir), moduleSelection.resolvedModules),
              ).content === targetContent
            : isManagedIgnore(item.contentStrategy)
              ? mergeManagedCbmIgnoreBlock(targetContent, sourceContent) === targetContent
              : sourceContent === targetContent;
      if (!matches) {
        changed.push(item);
      } else {
        same.push(item);
      }
    } else {
      missing.push(item);
    }
  }

  for (const action of adapterConfigActions) {
    const item = {
      contentStrategy: action.contentStrategy,
      group: action.group,
      managedJson: action.managedJson,
      mcpServers: action.mcpServers,
      hooks: action.hooks,
      redZone: action.redZone,
      source: action.source,
      target: action.relativeTarget,
    };
    const target = path.resolve(targetDir, item.target);
    expected.push(item);
    expectedTargets.add(item.target);
    if (item.redZone) {
      redZone.push({ ...item, status: await pathExists(target) ? 'present' : 'missing' });
    }
    if (!(await pathExists(target))) {
      missing.push(item);
      continue;
    }
    try {
      const targetContent = await readFile(target, 'utf8');
      const expectedContent = mergeManagedJsonConfig(targetContent, item.managedJson, {
        hooks: item.hooks,
        servers: item.mcpServers,
      });
      if (expectedContent === targetContent) same.push(item);
      else changed.push(item);
    } catch {
      changed.push(item);
    }
  }

  const unmanaged = (await collectTargetFiles(path.resolve(targetDir)))
    .filter((target) => !expectedTargets.has(target))
    .map((target) => ({ target }));
  const sample = (items) => items.slice(0, 20);

  return {
    capabilities: adapter.capabilities,
    changed,
    conflicts: changed,
    expected,
    missingCapabilities: Object.entries(adapter.capabilities)
      .filter(([, status]) => status === 'unsupported')
      .map(([name]) => name),
    missing,
    ok: missing.length === 0 && changed.length === 0,
    previewCapabilities: Object.entries(adapter.capabilities)
      .filter(([, status]) => status === 'preview')
      .map(([name]) => name),
    profile,
    roleProjection: roleProjection ? {
      ...roleProjection.diagnostics,
      roles: roleProjection.roles,
    } : null,
    redZone,
    same,
    summary: {
      changedCount: changed.length,
      missingCount: missing.length,
      sameCount: same.length,
      unmanagedCount: unmanaged.length,
      samples: {
        changed: sample(changed),
        missing: sample(missing),
        unmanaged: sample(unmanaged),
      },
    },
    targetDir: path.resolve(targetDir),
    unmanaged,
  };
}

export const inspectTargetInstall = diffTargetInstall;

/** @param {Record<string, any> & {aggregatePlan?: any, selectedTargets?: string[], targets: string[], rootDir: string, targetDir: string}} options */
export async function diffMultiTargetInstall({ aggregatePlan, selectedTargets, targets, ...options }) {
  const sampleItems = (items) => items.slice(0, 20);
  const uniqueItems = (items) => [...new Map(items.map((item) => [item.target, item])).values()];
  const activeTargets = selectedTargets?.length ? selectedTargets : targets;
  const installedState = await readInstallState(path.resolve(options.targetDir));
  const staleProjections = (installedState?.targets ?? []).filter((target) => !targets.includes(target));
  // Callers that already built the plan (validate/install flows) pass it in to
  // avoid a second full multi-target planning pass; the fallback rebuild is only
  // for direct callers without a plan.
  const plan = aggregatePlan ?? await createMultiTargetInstallPlan({
    ...options,
    dryRun: true,
    force: true,
    selectedTargets: [...new Set([...targets, ...activeTargets])],
    targets,
  });
  const renderData = { ...options.renderData, installedSurface: plan.renderData.installedSurface };
  const entries = /** @type {Array<[string, Record<string, any>]>} */ (await Promise.all(activeTargets.map(async (adapterId) => [
    adapterId,
    await diffTargetInstall({
      ...options,
      adapterId,
      renderData: { ...renderData, target: adapterId, targets },
    }),
  ])));
  const selectedAdapters = Object.fromEntries(entries.map(([adapterId, report]) => {
    const status = !report.ok
      ? 'conflict'
      : report.previewCapabilities.length > 0
        ? 'preview'
        : report.missingCapabilities.length > 0
          ? 'unsupported'
          : 'stable';
    return [adapterId, { ...report, status }];
  }));
  const adapters = Object.fromEntries(targets.map((adapterId) => [
    adapterId,
    selectedAdapters[adapterId] ?? { ok: true, status: 'skipped' },
  ]));
  const changed = uniqueItems(entries.flatMap(([, report]) => report.changed));
  const expected = uniqueItems(entries.flatMap(([, report]) => report.expected));
  const missing = uniqueItems(entries.flatMap(([, report]) => report.missing));
  const same = uniqueItems(entries.flatMap(([, report]) => report.same));
  const unmanaged = uniqueItems(entries.flatMap(([, report]) => report.unmanaged));
  return {
    adapters,
    changed,
    conflicts: uniqueItems(entries.flatMap(([, report]) => report.conflicts)),
    enforcementPolicy: plan.enforcementPolicy ?? 'advisory',
    expected,
    missing,
    ok: entries.every(([, report]) => report.ok) && staleProjections.length === 0,
    profile: options.profile,
    redZone: uniqueItems(entries.flatMap(([, report]) => report.redZone)),
    same,
    staleProjections,
    strictEnforcementRefusals: plan.strictEnforcementRefusals ?? [],
    summary: {
      changedCount: changed.length,
      missingCount: missing.length,
      sameCount: same.length,
      staleProjectionCount: staleProjections.length,
      unmanagedCount: unmanaged.length,
      samples: {
        changed: sampleItems(changed),
        missing: sampleItems(missing),
        unmanaged: sampleItems(unmanaged),
      },
    },
    targetDir: path.resolve(options.targetDir),
    targets: activeTargets,
    unmanaged,
  };
}

export async function applyInstallPlan(plan, hooks = {}) {
  if (plan.dryRun) {
    return {
      mcpConflicts: [],
      retired: [],
      retained: plan.preserveRetired ? retirementTargets(plan.actions) : [],
      skipped: [],
      written: [],
    };
  }

  validatePlanGuards(plan);
  await assertActionPaths(plan);
  // A true no-op must not rotate install-state, create a transaction or prune
  // backups. Metadata-only upgrades still take the normal transaction path.
  if (await installPlanIsNoOp(plan)) {
    return { mcpConflicts: [], retired: [], retained: [], skipped: [], written: [], unchanged: true };
  }

  const transactionId = createTransactionId();
  const transaction = await prepareTransaction(plan, transactionId);

  let installStatePersisted = false;
  try {
    const ctx = await prepareApplyContext(plan, transactionId);
    const writeResult = await executeWriteActions(plan, ctx, hooks);
    const retireResult = await executeRetireActions(plan, ctx);
    const installState = mergeInstallState(plan, ctx, retireResult);
    await writeInstallState(plan.targetDir, installState);

    installStatePersisted = true;
    await finalizeTransaction(transaction);
    // Retention runs after the commit: the install is already durable, so a
    // prune failure is reported instead of failing an applied transaction.
    const retention = await safePruneBackups(plan.targetDir);
    return {
      baseline: ctx.baseline,
      backupRetentionError: retention.error,
      mcpConflicts: [...new Set(writeResult.mcpConflicts)],
      prunedBackups: retention.pruned,
      retired: retireResult.retired,
      retained: retireResult.retained,
      skipped: retireResult.skipped,
      written: writeResult.written,
    };
  } catch (error) {
    if (installStatePersisted) throw error;
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], error.message);
    }
    throw error;
  }
}

function stableInstallValue(value) {
  if (Array.isArray(value)) return value.map(stableInstallValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableInstallValue(value[key])]));
}

async function installPlanIsNoOp(plan) {
  if (plan.configUpdate || !plan.baselinePlan.baseline || !plan.actions.length
    || plan.actions.some((action) => action.kind !== 'unchanged')) return false;
  const previous = await readInstallState(plan.targetDir);
  if (!previous) return false;
  const same = (left, right) => JSON.stringify(stableInstallValue(left)) === JSON.stringify(stableInstallValue(right));
  for (const key of ['version', 'profile', 'requestedModules', 'requestedPlugins', 'resolvedModules', 'previewCapabilities']) {
    if (!same(previous[key], plan[key])) return false;
  }
  if (!same(previous.targets, plan.targets ?? [plan.adapter])
    || !same(previous.generatedDirectories, plan.generatedDirectories)) return false;
  for (const file of previous.generatedFiles ?? []) {
    assertPortableRelativePath(file.target, 'install-state generated file');
    const target = path.join(plan.targetDir, file.target);
    await assertSafePathInside(plan.targetDir, target, 'install-state generated file');
    if (!await pathExists(target) || await hashFile(target) !== file.targetHash) return false;
  }
  for (const action of plan.actions) {
    if (await hashFile(action.target) !== action.expectedTargetHash) throw new Error(`Install target changed after planning: ${action.relativeTarget}`);
    if (await hashFile(action.source) !== action.expectedSourceHash) throw new Error(`Install input changed after planning: ${action.relativeSource}`);
    if (action.executable && process.platform !== 'win32' && ((await stat(action.target)).mode & 0o777) !== 0o755) {
      throw new Error(`Install target permissions changed after planning: ${action.relativeTarget}`);
    }
    const recorded = previous.files.find((file) => file.target === action.relativeTarget);
    if (!recorded || recorded.source !== action.relativeSource
      || recorded.sourceHash !== await hashFile(action.source)
      || !same(recorded.owners, action.owners) || Boolean(recorded.redZone) !== Boolean(action.redZone)
      || recorded.contentStrategy !== action.contentStrategy) return false;
  }
  return true;
}

function retirementTargets(actions = []) {
  return [...new Set(actions
    .filter((action) => action.kind?.startsWith('retire'))
    .map((action) => action.relativeTarget))];
}

function validatePlanGuards(plan) {
  if (plan.actions.some((action) => ['retire-runtime-state', 'retire-generated-directory'].includes(action.kind))) {
    throw new Error('Refusing automatic retirement of runtime state or generated directories.');
  }
  const modifiedExecutableConfig = plan.actions.find((action) => action.kind === 'retire-modified'
    && (isManagedJson(action.contentStrategy) || isManagedToml(action.contentStrategy)
      || action.managedJson || (['hooks', 'adapter-config', 'mcp-config'].includes(action.group)
        && /\.(?:jsonc?|toml)$/u.test(action.relativeTarget))));
  if (modifiedExecutableConfig) {
    throw new Error(`Cannot safely detach modified executable configuration: ${modifiedExecutableConfig.relativeTarget}`);
  }
  if (plan.preserveUserModified && !plan.upgrade) {
    throw new Error('--preserve-user-modified requires --upgrade.');
  }
  if (plan.preserveUserModified && plan.force) {
    throw new Error('--preserve-user-modified cannot be combined with --force.');
  }

  // Project-owned seeds are reported as retained instead of blocking the plan;
  // every other managed target that drifted still fails closed here.
  const userModified = plan.actions.find((action) => action.kind === 'user-modified' && !action.projectOwned);
  if (userModified && !plan.preserveUserModified) {
    throw new Error(`Refusing to upgrade user-modified file: ${userModified.target}`);
  }

  if (!plan.force) {
    const conflict = plan.actions.find((action) => action.kind === 'conflict');
    if (conflict) {
      throw new Error(`Refusing to overwrite existing file: ${conflict.target}`);
    }
  }

  // hooks.enforcement "strict" has no bypass flag: the config value is the
  // operator's decision, so the only remedies are dropping the unsupported
  // targets or modules, or switching the policy back to "advisory".
  if (!plan.dryRun && (plan.strictEnforcementRefusals ?? []).length > 0) {
    throw new Error(
      'Refusing red-zone writes for '
      + plan.strictEnforcementRefusals.join(', ')
      + ': hooks.enforcement is "strict" and these targets do not support runtime Hooks. Drop the unsupported targets or the hooks-facing modules, or set hooks.enforcement to "advisory".',
    );
  }

  if (!plan.dryRun && !plan.redZoneConfirmed && plan.actions.some((action) => action.redZone && isMutatingInstallAction(action))) {
    throw new Error('Refusing to write red-zone files without explicit red-zone confirmation.');
  }
}

const TRACKED_ACTION_KINDS = ['write', 'retire', 'retire-managed-ignore', 'retire-managed-json', 'retire-managed-mcp'];

async function assertActionPaths(plan) {
  for (const action of plan.actions.filter((item) => item.kind === 'unchanged' || TRACKED_ACTION_KINDS.includes(item.kind))) {
    assertPortableRelativePath(action.relativeTarget, 'install target');
    assertInsideDir(plan.targetDir, action.target, 'install target outside target directory');
    await assertSafePathInside(plan.targetDir, action.target, 'install target');
    if (String(action.kind).startsWith('retire')
      && (isManagedJson(action.contentStrategy) || isManagedToml(action.contentStrategy) || action.managedJson)) {
      const content = await readFile(action.target, 'utf8');
      const currentHash = isManagedJson(action.contentStrategy) || action.managedJson
        ? managedJsonHash(content, action.managedJson)
        : hashManagedBlock(extractManagedMcpBlock(content));
      if (currentHash !== action.expectedHash) {
        throw new Error(`Executable configuration changed after planning: ${action.relativeTarget}`);
      }
    }
  }
}

async function prepareTransaction(plan, transactionId) {
  const statePath = stateFilePath(plan.targetDir);
  const backupRoot = path.join(path.dirname(statePath), 'backups', transactionId);
  const trackedPaths = [
    ...plan.actions
      .filter((action) => TRACKED_ACTION_KINDS.includes(action.kind))
      .map((action) => action.target),
    ...plan.baselinePlan.actions.map((action) => path.join(plan.targetDir, action.target)),
    ...(plan.baselinePlan.manifestTarget ? [path.join(plan.targetDir, plan.baselinePlan.manifestTarget)] : []),
    statePath,
    ...(plan.configUpdate ? [plan.configUpdate.path] : []),
  ];
  return beginFileTransaction({
    cleanupPaths: [
      backupRoot,
      ...(plan.baselinePlan.root ? [plan.baselinePlan.root] : []),
    ],
    id: transactionId,
    operation: 'install',
    targetDir: plan.targetDir,
    trackedPaths,
  });
}

async function prepareApplyContext(plan, transactionId) {
  const backupId = transactionId;
  const previousState = await readInstallState(plan.targetDir);
  const retiredFiles = [...(previousState?.retiredFiles ?? [])];
  const discardedTargets = new Set();
  if (plan.configUpdate) {
    if (await pathExists(plan.configUpdate.path)) {
      await backupFile({ backupId, target: plan.configUpdate.path, targetDir: plan.targetDir });
    }
    await writeFile(plan.configUpdate.path, `${JSON.stringify(plan.configUpdate.config, null, 2)}\n`, 'utf8');
  }
  const baseline = await applyBaselinePlan(plan.baselinePlan);
  const generatedFiles = [];
  for (const file of previousState?.generatedFiles ?? []) {
    assertPortableRelativePath(file.target, 'install-state generated file');
    const generatedTarget = path.join(plan.targetDir, file.target);
    assertInsideDir(plan.targetDir, generatedTarget, 'install-state generated file');
    if (await pathExists(generatedTarget) && await hashFile(generatedTarget) === file.targetHash) {
      generatedFiles.push(file);
    }
  }
  return { backupId, baseline, discardedTargets, generatedFiles, previousState, retiredFiles, transactionId };
}

async function executeWriteActions(plan, ctx, hooks) {
  const written = [];
  const files = [];
  const mcpConflicts = [];
  const { backupId } = ctx;
  for (const action of plan.actions) {
    if (action.kind === 'unchanged') {
      if (await hashFile(action.target) !== action.expectedTargetHash) throw new Error(`Install target changed after planning: ${action.relativeTarget}`);
      if (await hashFile(action.source) !== action.expectedSourceHash) throw new Error(`Install input changed after planning: ${action.relativeSource}`);
      if (action.executable && process.platform !== 'win32' && ((await stat(action.target)).mode & 0o777) !== 0o755) {
        throw new Error(`Install target permissions changed after planning: ${action.relativeTarget}`);
      }
      const previous = ctx.previousState?.files?.find((file) => file.target === action.relativeTarget);
      const targetContent = await readFile(action.target, 'utf8');
      const managedBlock = isManagedInstruction(action.contentStrategy)
        ? extractManagedInstructionBlock(targetContent) : isManagedJson(action.contentStrategy)
          ? managedJsonPayload(targetContent, action.managedJson) : isManagedToml(action.contentStrategy)
            ? extractManagedMcpBlock(targetContent) : isManagedIgnore(action.contentStrategy)
              ? extractManagedCbmIgnoreBlock(targetContent) : undefined;
      files.push({ backup: null, created: false, previousHash: action.expectedTargetHash,
        originalBackup: null, originalCreated: false, owner: 'vibe-harness', transactionId: ctx.transactionId,
        ...previous, owners: action.owners ?? previous?.owners, group: action.group,
        contentStrategy: action.contentStrategy, redZone: Boolean(action.redZone),
        ...(managedBlock === undefined ? {} : { managedBlockHash: hashManagedBlock(managedBlock) }),
        ...(isManagedJson(action.contentStrategy) ? { managedJson: action.managedJson } : {}),
        source: action.relativeSource, sourceHash: action.expectedSourceHash,
        target: action.relativeTarget, targetHash: action.expectedTargetHash });
      continue;
    }
    if (action.kind !== 'write') {
      continue;
    }
    assertPortableRelativePath(action.relativeSource, 'install source');
    assertPortableRelativePath(action.relativeTarget, 'install target');
    assertInsideDir(plan.targetDir, action.target, 'install target');
    await assertSafePathInside(plan.targetDir, action.target, 'install target');
    const existed = await pathExists(action.target);
    let backup = null;
    let previousHash = null;
    const existingContent = existed ? await readFile(action.target, 'utf8') : '';
    if (action.expectedTargetHash !== undefined
      && (existed ? createHash('sha256').update(existingContent).digest('hex') : null) !== action.expectedTargetHash) {
      throw new Error(`Install target changed after planning: ${action.relativeTarget}`);
    }
    if (existed
      && !isManagedInstruction(action.contentStrategy)
      && !isManagedJson(action.contentStrategy)
      && !isManagedToml(action.contentStrategy)
      && !isManagedIgnore(action.contentStrategy)) {
      previousHash = await hashFile(action.target);
      backup = await backupFile({ backupId, target: action.target, targetDir: plan.targetDir });
    }

    await mkdir(path.dirname(action.target), { recursive: true });
    const mergedMcp = isManagedToml(action.contentStrategy)
      ? mergeManagedMcpBlock(existingContent, action.mcpServers, { force: plan.force })
      : null;
    if (mergedMcp) mcpConflicts.push(...mergedMcp.conflicts);
    const targetContent = mergedMcp?.content ?? await renderActionContent(action, actionRenderData(action, plan.renderData), existingContent);
    if (action.plannedContentHash && createHash('sha256').update(targetContent).digest('hex') !== action.plannedContentHash) {
      throw new Error(`Install input changed after planning: ${action.relativeSource}`);
    }
    await writeFile(action.target, targetContent, 'utf8');
    await hooks.afterFileWrite?.({ action, writtenCount: written.length + 1 });
    if (action.executable) await chmod(action.target, 0o755);
    written.push(action.target);
    files.push({
      backup,
      contentStrategy: action.contentStrategy,
      created: !existed,
      group: action.group,
      ...(isManagedJson(action.contentStrategy) ? { managedJson: action.managedJson } : {}),
      managedBlockHash: isManagedInstruction(action.contentStrategy) || isManagedJson(action.contentStrategy) || isManagedToml(action.contentStrategy) || isManagedIgnore(action.contentStrategy)
        ? hashManagedBlock(
            isManagedInstruction(action.contentStrategy)
              ? extractManagedInstructionBlock(targetContent)
              : isManagedJson(action.contentStrategy)
                ? managedJsonPayload(targetContent, action.managedJson)
              : isManagedToml(action.contentStrategy)
                ? extractManagedMcpBlock(targetContent)
                : extractManagedCbmIgnoreBlock(targetContent),
          )
        : undefined,
      previousHash,
      originalBackup: backup,
      originalCreated: !existed,
      redZone: Boolean(action.redZone),
      source: action.relativeSource,
      sourceHash: await hashFile(action.source),
      owner: 'vibe-harness',
      owners: action.owners ?? ['shared'],
      target: toTargetPath(plan.targetDir, action.target),
      targetHash: await hashFile(action.target),
      transactionId: ctx.transactionId,
    });
  }
  ctx.files = files;
  return { mcpConflicts, written };
}

async function executeRetireActions(plan, ctx) {
  const retired = [];
  const skipped = [];
  if (plan.preserveRetired) {
    return { retired, retiredFiles: ctx.retiredFiles, retained: retirementTargets(plan.actions), skipped };
  }
  const { backupId, discardedTargets, retiredFiles } = ctx;
  const isSkillRootTarget = skillRootMatcher(plan.skillRoots ?? []);

  for (const action of plan.actions) {
    if (action.kind === 'retire-missing') {
      // The target is already gone; only the registration is dropped.
      discardedTargets.add(action.relativeTarget);
      continue;
    }
    if (action.kind === 'retire-modified') {
      skipped.push({
        reason: isSkillRootTarget(action.relativeTarget)
          ? 'retained-user-modified'
          : 'target-modified',
        target: action.relativeTarget,
      });
      continue;
    }
    if (action.kind === 'retire-managed-mcp') {
      if (!(await pathExists(action.target))) {
        discardedTargets.add(action.relativeTarget);
        continue;
      }
      const content = await readFile(action.target, 'utf8');
      const blockHash = hashManagedBlock(extractManagedMcpBlock(content));
      if (blockHash !== action.expectedHash) {
        skipped.push({ reason: 'managed-block-modified', target: action.relativeTarget });
        continue;
      }
      await backupFile({ backupId, target: action.target, targetDir: plan.targetDir });
      const remaining = removeManagedMcpBlock(content);
      if (remaining) await writeFile(action.target, remaining, 'utf8');
      else await rm(action.target, { force: true });
      retired.push(action.relativeTarget);
      discardedTargets.add(action.relativeTarget);
      continue;
    }
    if (action.kind === 'retire-managed-json') {
      if (!(await pathExists(action.target))) {
        discardedTargets.add(action.relativeTarget);
        continue;
      }
      let remaining;
      try {
        const content = await readFile(action.target, 'utf8');
        if (managedJsonHash(content, action.managedJson) !== action.expectedHash) {
          skipped.push({ reason: 'managed-block-modified', target: action.relativeTarget });
          continue;
        }
        await backupFile({ backupId, target: action.target, targetDir: plan.targetDir });
        remaining = removeManagedJsonConfig(content, action.managedJson);
      } catch {
        skipped.push({ reason: 'managed-block-modified', target: action.relativeTarget });
        continue;
      }
      if (remaining.trim() === '{}' && action.created) await rm(action.target, { force: true });
      else await writeFile(action.target, remaining, 'utf8');
      retired.push(action.relativeTarget);
      discardedTargets.add(action.relativeTarget);
      continue;
    }
    if (action.kind === 'retire-managed-ignore') {
      if (!(await pathExists(action.target))) {
        discardedTargets.add(action.relativeTarget);
        continue;
      }
      const content = await readFile(action.target, 'utf8');
      const blockHash = hashManagedBlock(extractManagedCbmIgnoreBlock(content));
      if (blockHash !== action.expectedHash) {
        skipped.push({ reason: 'managed-block-modified', target: action.relativeTarget });
        continue;
      }
      await backupFile({ backupId, target: action.target, targetDir: plan.targetDir });
      const remaining = removeManagedCbmIgnoreBlock(content);
      if (remaining) await writeFile(action.target, remaining, 'utf8');
      else if (action.created) await rm(action.target, { force: true });
      else await writeFile(action.target, '', 'utf8');
      retired.push(action.relativeTarget);
      discardedTargets.add(action.relativeTarget);
      continue;
    }
    if (action.kind !== 'retire') {
      continue;
    }
    assertPortableRelativePath(action.relativeTarget, 'retired install target');
    assertInsideDir(plan.targetDir, action.target, 'retired install target');
    await assertSafePathInside(plan.targetDir, action.target, 'retired install target');
    if (!(await pathExists(action.target))) {
      skipped.push({ reason: 'target-missing', target: action.relativeTarget });
      continue;
    }
    const currentHash = await hashFile(action.target);
    if (currentHash !== action.expectedHash) {
      skipped.push({ reason: 'target-modified', target: action.relativeTarget });
      continue;
    }
    const backup = await backupFile({ backupId, target: action.target, targetDir: plan.targetDir });
    await rm(action.target, { force: true });
    try {
      await rmdir(path.dirname(action.target));
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
    retired.push(action.relativeTarget);
    if (action.discard) {
      discardedTargets.add(action.relativeTarget);
    } else {
      retiredFiles.push({
        backup,
        group: action.group,
        owners: action.owners ?? ['shared'],
        redZone: Boolean(action.redZone),
        target: action.relativeTarget,
        targetHash: currentHash,
      });
    }
  }

  return { retired, retiredFiles, retained: [], skipped };
}

function mergeInstallState(plan, ctx, retireResult) {
  const { files = [], previousState, discardedTargets } = ctx;
  const { retiredFiles } = retireResult;
  const retiredTargets = new Set([...retiredFiles.map((file) => file.target), ...discardedTargets]);
  const mergedFiles = new Map((previousState?.files ?? [])
    .filter((file) => !retiredTargets.has(file.target))
    .map((file) => [file.target, file]));
  for (const file of files) {
    const previous = mergedFiles.get(file.target);
    mergedFiles.set(file.target, previous ? {
      ...file,
      owners: mergeOwners(previous.owners, file.owners),
      originalBackup: Object.hasOwn(previous, 'originalBackup') ? previous.originalBackup : previous.backup,
      originalCreated: previous.originalCreated ?? previous.created,
    } : file);
  }
  const generatedDirectories = [...new Map([
    ...(previousState?.generatedDirectories ?? []),
    ...plan.generatedDirectories,
  ].map((item) => [item.target, item])).values()];
  return {
    targets: plan.targets ?? previousState?.targets ?? [plan.adapter],
    baseline: ctx.baseline,
    files: [...mergedFiles.values()],
    generatedDirectories,
    generatedFiles: ctx.generatedFiles,
    installedAt: new Date().toISOString(),
    profile: plan.profile,
    previewCapabilities: plan.previewCapabilities,
    requestedModules: plan.requestedModules,
    requestedPlugins: plan.requestedPlugins,
    resolvedModules: plan.resolvedModules,
    retiredFiles,
    stateVersion: 5,
    transactionId: ctx.transactionId,
    version: plan.version,
  };
}

async function finalizeTransaction(transaction) {
  try {
    await transaction.commit();
  } catch (error) {
    try {
      await transaction.release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], error.message);
    }
    throw error;
  }
}

async function safePruneBackups(targetDir) {
  try {
    const pruned = await pruneBackups(targetDir);
    return { error: null, pruned };
  } catch (error) {
    return { error: error.message, pruned: [] };
  }
}
