import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  backupFile,
  collectTargetFiles,
  hashFile,
  readInstallState,
  toTargetPath,
  writeInstallState,
} from './install-state.js';
import {
  assertInsideDir,
  assertPortableRelativePath,
  assertSafePathInside,
  pathExists,
  readJson,
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
import { extractManagedMcpBlock, mergeManagedMcpBlock } from './tool-provisioning.js';
import { applyBaselinePlan, createBaselinePlan } from './installation-baseline.js';
import { resolveModuleSelection } from './module-selection.js';
import { assertAdapterProfile, resolveAdapter, resolveAdapterEntry } from './adapter.js';
import { beginFileTransaction, createTransactionId } from './file-transaction.js';

const isManagedInstruction = (strategy) => ['managed-block', 'managed-instruction-block'].includes(strategy);
const isManagedToml = (strategy) => ['managed-mcp-block', 'managed-toml-block'].includes(strategy);

async function loadProfileInstallMap({ adapterId = 'codex', allowPreview = false, profile, rootDir }) {
  const profiles = await readJson(path.join(rootDir, 'manifests/profiles.json'));
  validateCatalogManifest('profiles', profiles);

  const selectedProfile = profiles.items.find((item) => item.id === profile);
  if (!selectedProfile) {
    throw new Error(`Unknown profile: ${profile}`);
  }

  const adapter = await resolveAdapter(rootDir, adapterId);
  assertAdapterProfile(adapter, profile, { allowPreview });
  const rawInstallMap = await readJson(path.join(rootDir, adapter.installMap));
  const knownGroups = new Set(profiles.items.flatMap((item) => item.groups));
  validateInstallMapShape(rawInstallMap, knownGroups);
  const installMap = {
    ...rawInstallMap,
    adapter: adapter.id,
    entries: rawInstallMap.entries.map((entry) => resolveAdapterEntry(adapter, entry)).filter(Boolean),
    retiredEntries: (rawInstallMap.retiredEntries ?? []).map((entry) => resolveAdapterEntry(adapter, entry)).filter(Boolean),
  };

  return { adapter, installMap, selectedProfile };
}

async function packageVersion(rootDir) {
  const pkg = await readJson(path.join(rootDir, 'package.json'));
  return pkg.version;
}

export function createInstalledSurface({ customModules = false, memoryPath = '.agents/memory', profile, targets }) {
  const installedTargets = targets.map((target) => target.replaceAll('\\', '/'));
  const hasTarget = (expectedTarget) => installedTargets.includes(expectedTarget);
  const hasPrefix = (prefix) => installedTargets.some((target) => target.startsWith(prefix));
  const hasSkill = (suffix) => installedTargets.some((target) => target.endsWith(`/skills/${suffix}`));
  const skillRoots = [...new Set(installedTargets
    .filter((target) => /^\.(?:agents|claude|gemini)\/skills\//u.test(target))
    .map((target) => target.split('/skills/')[0] + '/skills'))];
  const hasReviewLoop = hasSkill('adversarial-review-packet/SKILL.md')
    || hasSkill('loop-planning/SKILL.md');
  const hasEngineeringRules = [
    'docs/rules/coding-rules.md',
    'docs/rules/frontend-rules.md',
    'docs/rules/api-rules.md',
    'docs/rules/ai-collab-rules.md',
    'docs/rules/project-directory.md',
    'docs/rules/project-specific-rules.md',
  ].some(hasTarget);
  const hasOperationalRules = [
    'docs/rules/release-rules.md',
    'docs/rules/pencil-rules.md',
    'docs/rules/troubleshooting.md',
  ].some(hasTarget);
  const hasAgentMemorySkills = hasSkill('agentmemory/SKILL.md');
  const agentMemoryTarget = installedTargets.find((target) => target.endsWith('/skills/agentmemory/SKILL.md'));
  const agentMemorySkillRoot = agentMemoryTarget?.slice(0, agentMemoryTarget.indexOf('/agentmemory/SKILL.md'));
  const normalizedMemoryPath = memoryPath.replaceAll('\\', '/').replace(/\/+$/u, '');
  const hasLocalMemory = installedTargets.includes(`${normalizedMemoryPath}/README.md`);
  const profileLines = {
    core: '- 当前安装方式：通用安装（不包含扩展 MCP 或 hooks 安装面）。',
    'docs-only': '- 当前安装方式：仅文档安装。',
    full: '- 当前安装方式：全安装（包含 codebase-memory-mcp、agentmemory MCP 项目内安装面和 Codex hooks）。',
    minimal: '- 当前安装方式：最小安装。',
  };

  return {
    codebaseMemoryMcpLine: hasTarget('docs/rules/codebase-memory-mcp.md')
      ? '- codebase-memory-mcp 规则位于 `docs/rules/codebase-memory-mcp.md`。'
      : '',
    discoveryLine: hasTarget('docs/rules/codebase-memory-mcp.md')
      ? '若 `codebase-memory-mcp` 可用，先确认索引状态并用于结构化定位；不可用时说明并退回仓库搜索。'
      : '使用仓库搜索和已安装规则定位相关代码；需要结构化索引时先确认目标项目已有能力。',
    engineeringRulesLine: hasEngineeringRules ? '- 工程专项规则位于 `docs/rules/`。' : '',
    hooksLine: hasTarget('.codex/hooks.json') ? '- Codex hook 配置位于 `.codex/hooks.json`。' : '',
    memorySkillsLine: hasAgentMemorySkills
      ? `- agentmemory skills 位于 \`${agentMemorySkillRoot}/\`${hasLocalMemory ? `，本地记忆库位于 \`${normalizedMemoryPath}/\`` : ''}。`
      : '',
    operationalRulesLine: hasOperationalRules ? '- 发布 / 设计 / 排障规则位于 `docs/rules/`。' : '',
    profileLine: customModules
      ? '- 当前安装方式：自定义能力模块安装。'
      : (profileLines[profile] ?? `- 当前 profile: \`${profile}\`。`),
    reviewLoopLine: hasReviewLoop ? '- 当前 profile 包含 review / loop 资产。' : '',
    rulesLine: hasPrefix('docs/rules/') ? '- 规则位于 `docs/rules/`。' : '',
    skillRoutingLine: hasSkill('using-loopengine/SKILL.md')
      ? '先使用 `using-loopengine` 选择最小 Skill 集；详细流程按任务信号加载。'
      : '当前 profile 未安装 Skills；仅按已安装规则和模板执行，不引用未安装的 skill。',
    skillsLine: skillRoots.length > 0 ? `- Skills 位于 ${skillRoots.map((root) => `\`${root}/\``).join('、')}。` : '',
    templatesLine: hasPrefix('docs/templates/') ? '- 模板位于 `docs/templates/`。' : '',
    toolingLine: hasTarget('.agents/loopengine/tools/codebase-memory-mcp/run.mjs')
      ? '- 项目内工具位于 `.agents/loopengine/tools/`；使用 `loopengine doctor --target <path>` 查看初始化状态。'
      : (hasTarget('.agents/loopengine/tools/playwright-cli/run.mjs') ? '- Playwright CLI 将在首次使用时于项目内初始化。' : ''),
  };
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

function createManagedMcpServers(targetDir, resolvedModules) {
  const codebaseTool = path.join(targetDir, '.agents/loopengine/tools/codebase-memory-mcp/run.mjs');
  const agentmemoryTool = path.join(targetDir, '.agents/loopengine/tools/agentmemory/run.mjs');
  const memoryHome = path.join(targetDir, '.loopengine/tool-state/agentmemory/home');
  const servers = {};
  if (resolvedModules.includes('agentmemory')) servers.agentmemory = {
      args: [agentmemoryTool],
      command: process.execPath,
      env: { HOME: memoryHome, USERPROFILE: memoryHome },
    };
  if (resolvedModules.includes('codebase-memory')) servers['codebase-memory-mcp'] = {
      args: [codebaseTool],
      command: process.execPath,
      env: {
        CBM_ALLOWED_ROOT: targetDir,
        CBM_CACHE_DIR: path.join(targetDir, '.loopengine/tool-state/codebase-memory-mcp/cache'),
      },
    };
  return servers;
}

export async function createInstallPlan({
  adapterId = 'codex',
  allowPreview = false,
  dryRun = true,
  force = false,
  managedAgentsBlock = false,
  profile = 'core',
  requestedModules,
  renderData = {},
  rootDir,
  targetDir,
  upgrade = false,
}) {
  const { adapter, installMap, selectedProfile } = await loadProfileInstallMap({ adapterId, allowPreview, profile, rootDir });
  const moduleSelection = resolveModuleSelection({
    profile,
    profileGroups: selectedProfile.groups,
    requestedModules,
  });
  const allowedGroups = moduleSelection.allowedGroups;
  const actions = [];
  const state = await readInstallState(path.resolve(targetDir));
  if (state && state.adapter !== adapter.id) {
    throw new Error(`Installed adapter ${state.adapter} does not match install target ${adapter.id}; uninstall the existing adapter first.`);
  }
  const managed = new Map((state?.files ?? []).map((file) => [file.target, file]));
  const baselinePlan = await createBaselinePlan({ baseline: state?.baseline, targetDir: path.resolve(targetDir) });

  for (const entry of installMap.entries) {
    if (!allowedGroups.has(entry.group)) {
      continue;
    }
    if (!shouldInstallEntry(entry, renderData)) {
      continue;
    }
    assertPortableRelativePath(entry.source, 'install source');
    const localizedSource = renderData.language === 'en-US'
      ? ({
          'templates/delivery.md': 'templates/delivery.en-US.md',
          'templates/task.md': 'templates/task.en-US.md',
        }[entry.source] ?? entry.source)
      : entry.source;
    assertPortableRelativePath(localizedSource, 'localized install source');
    const mappedTarget = memoryTargetPath(renderData, entry.target);
    assertPortableRelativePath(mappedTarget, 'install target');
    const source = path.resolve(rootDir, localizedSource);
    const target = path.resolve(targetDir, mappedTarget);
    assertInsideDir(rootDir, source, 'install source');
    assertInsideDir(targetDir, target, 'install target');
    await assertSafePathInside(rootDir, source, 'install source');
    await assertSafePathInside(targetDir, target, 'install target');
    const relativeSource = localizedSource.replaceAll('\\', '/');
    const relativeTarget = mappedTarget;
    const contentStrategy = entry.contentStrategy === 'managed-instruction-block'
      ? (managedAgentsBlock && relativeTarget === adapter.instructionTarget ? entry.contentStrategy : 'replace')
      : entry.contentStrategy;
    const exists = await pathExists(target);
    let kind = exists && !force ? 'conflict' : 'write';
    const managedFile = managed.get(relativeTarget);

    if (exists && managedFile && !force) {
      let currentHash;
      if (isManagedInstruction(contentStrategy)) {
        const content = await readFile(target, 'utf8');
        currentHash = createHash('sha256').update(extractManagedInstructionBlock(content) ?? '').digest('hex');
      } else if (isManagedToml(contentStrategy)) {
        const content = await readFile(target, 'utf8');
        currentHash = createHash('sha256').update(extractManagedMcpBlock(content) ?? '').digest('hex');
      } else {
        currentHash = await hashFile(target);
      }
      const expectedHash = (isManagedInstruction(contentStrategy) || isManagedToml(contentStrategy))
        ? managedFile.managedBlockHash
        : managedFile.targetHash;
      kind = currentHash === expectedHash ? 'write' : 'user-modified';
    } else if (isManagedInstruction(contentStrategy) || isManagedToml(contentStrategy)) {
      kind = 'write';
    }

    if (upgrade) {
      if (!exists || force) kind = 'write';
      else if (!managedFile) {
        kind = 'conflict';
      }
    }

    actions.push({
      group: entry.group,
      kind,
      contentStrategy,
      executable: Boolean(entry.executable),
      mcpServers: isManagedToml(contentStrategy)
        ? createManagedMcpServers(path.resolve(targetDir), moduleSelection.resolvedModules)
        : undefined,
      redZone: Boolean(entry.redZone),
      relativeSource,
      relativeTarget,
      source,
      target,
    });
  }

  if (upgrade) {
    for (const entry of installMap.retiredEntries ?? []) {
      if (!allowedGroups.has(entry.group)) {
        continue;
      }
      assertPortableRelativePath(entry.target, 'retired install target');
      const relativeTarget = entry.target.replaceAll('\\', '/');
      const managedFile = managed.get(relativeTarget);
      if (!managedFile) {
        continue;
      }
      const target = path.resolve(targetDir, relativeTarget);
      assertInsideDir(targetDir, target, 'retired install target');
      await assertSafePathInside(targetDir, target, 'retired install target');
      if (!(await pathExists(target))) {
        continue;
      }
      const currentHash = await hashFile(target);
      actions.push({
        expectedHash: managedFile.targetHash,
        group: entry.group,
        kind: currentHash === managedFile.targetHash ? 'retire' : 'retire-modified',
        redZone: Boolean(entry.redZone),
        relativeTarget,
        target,
      });
    }
  }

  const installedSurface = createInstalledSurface({
    customModules: moduleSelection.requestedModules !== null,
    memoryPath: renderData.memory?.path,
    profile,
    targets: actions.map((action) => action.relativeTarget),
  });
  const generatedDirectories = actions.some((action) => action.group === 'tools-playwright')
    ? [{
        ownerTarget: `${PLAYWRIGHT_TOOL_RELATIVE_DIR}/package.json`,
        target: PLAYWRIGHT_GENERATED_RELATIVE_DIR,
      }]
    : [];
  for (const component of ['codebase-memory-mcp', 'open-code-review', 'agentmemory']) {
    const ownerTarget = `.agents/loopengine/tools/${component}/package.json`;
    if (actions.some((action) => action.relativeTarget === ownerTarget)) {
      generatedDirectories.push({ ownerTarget, target: `.agents/loopengine/tools/${component}/node_modules` });
      generatedDirectories.push({
        ownerTarget,
        projectScoped: true,
        target: `.loopengine/tool-state/${component}`,
      });
      generatedDirectories.push({
        ownerTarget,
        projectScoped: true,
        target: `.loopengine/tool-state/npm-cache/${component === 'codebase-memory-mcp' ? 'codebaseMemoryMcp' : component === 'open-code-review' ? 'openCodeReview' : component}`,
      });
    }
  }

  return {
    adapter: adapter.id,
    adapterCapabilities: adapter.capabilities,
    baselinePlan,
    dryRun,
    force,
    generatedDirectories,
    implicitModules: moduleSelection.implicitModules,
    instructionTarget: adapter.instructionTarget,
    missingCapabilities: Object.entries(adapter.capabilities).filter(([, status]) => status === 'unsupported').map(([name]) => name),
    profile,
    previewCapabilities: Object.entries(adapter.capabilities).filter(([, status]) => status === 'preview').map(([name]) => name),
    requestedModules: moduleSelection.requestedModules,
    resolvedModules: moduleSelection.resolvedModules,
    renderData: withDefaultTemplateData({
      ...renderData,
      installedSurface,
    }),
    redZoneConfirmed: false,
    targetDir: path.resolve(targetDir),
    upgrade,
    version: await packageVersion(rootDir),
    actions,
  };
}

export async function renderSourceContent(action, renderData = {}) {
  const content = await readFile(action.source, 'utf8');
  return renderTemplate(content, renderData);
}

export async function renderActionContent(action, renderData = {}, existingContent = '') {
  if (isManagedToml(action.contentStrategy)) {
    return mergeManagedMcpBlock(existingContent, action.mcpServers).content;
  }
  const rendered = await renderSourceContent(action, renderData);
  if (isManagedInstruction(action.contentStrategy)) {
    return mergeManagedInstructionBlock(existingContent, rendered);
  }
  return rendered;
}

export async function previewInstallPlan(plan, { includeContent = true } = {}) {
  const previewFiles = [];
  for (const action of plan.actions) {
    if (action.kind !== 'write') {
      continue;
    }
    const existingContent = (isManagedInstruction(action.contentStrategy) || isManagedToml(action.contentStrategy)) && await pathExists(action.target)
      ? await readFile(action.target, 'utf8')
      : '';
    const mergedMcp = isManagedToml(action.contentStrategy)
      ? mergeManagedMcpBlock(existingContent, action.mcpServers)
      : null;
    const content = mergedMcp?.content ?? await renderActionContent(action, plan.renderData, existingContent);
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

export async function diffTargetInstall({
  adapterId = 'codex',
  managedAgentsBlock = false,
  profile = 'core',
  requestedModules,
  renderData = {},
  rootDir,
  targetDir,
}) {
  const { adapter, installMap, selectedProfile } = await loadProfileInstallMap({ adapterId, profile, rootDir });
  const moduleSelection = resolveModuleSelection({
    profile,
    profileGroups: selectedProfile.groups,
    requestedModules,
  });
  const allowedGroups = moduleSelection.allowedGroups;
  const selectedEntries = installMap.entries.filter((entry) => allowedGroups.has(entry.group) && shouldInstallEntry(entry, renderData));
  const installedTargets = selectedEntries.map((entry) => memoryTargetPath(renderData, entry.target));
  const renderedData = withDefaultTemplateData({
    ...renderData,
    installedSurface: createInstalledSurface({
      customModules: moduleSelection.requestedModules !== null,
      memoryPath: renderData.memory?.path,
      profile,
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
    const source = path.resolve(rootDir, entry.source);
    assertInsideDir(rootDir, source, 'install source');
    assertInsideDir(targetDir, target, 'install target');
    const item = {
      contentStrategy: entry.contentStrategy === 'managed-instruction-block'
        ? (managedAgentsBlock && mappedTarget === adapter.instructionTarget ? entry.contentStrategy : 'replace')
        : entry.contentStrategy,
      group: entry.group,
      mcpServers: mappedTarget === '.codex/config.toml'
        ? createManagedMcpServers(path.resolve(targetDir), moduleSelection.resolvedModules)
        : undefined,
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
      const matches = isManagedInstruction(item.contentStrategy)
        ? extractManagedInstructionBlock(targetContent) === renderManagedInstructionBlock(sourceContent)
        : isManagedToml(item.contentStrategy)
          ? mergeManagedMcpBlock(
              targetContent,
              createManagedMcpServers(path.resolve(targetDir), moduleSelection.resolvedModules),
            ).content === targetContent
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

  const unmanaged = (await collectTargetFiles(path.resolve(targetDir)))
    .filter((target) => !expectedTargets.has(target))
    .map((target) => ({ target }));
  const sample = (items) => items.slice(0, 20);

  return {
    changed,
    conflicts: changed,
    expected,
    missing,
    ok: missing.length === 0 && changed.length === 0,
    profile,
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

export async function applyInstallPlan(plan, hooks = {}) {
  if (plan.dryRun) {
    return { mcpConflicts: [], retired: [], skipped: [], written: [] };
  }

  const userModified = plan.actions.find((action) => action.kind === 'user-modified');
  if (userModified) {
    throw new Error(`Refusing to upgrade user-modified file: ${userModified.target}`);
  }

  if (!plan.force) {
    const conflict = plan.actions.find((action) => action.kind === 'conflict');
    if (conflict) {
      throw new Error(`Refusing to overwrite existing file: ${conflict.target}`);
    }
  }

  if (!plan.dryRun && !plan.redZoneConfirmed && plan.actions.some((action) => action.redZone)) {
    throw new Error('Refusing to write red-zone files without explicit red-zone confirmation.');
  }

  for (const action of plan.actions.filter((item) => ['write', 'retire'].includes(item.kind))) {
    assertPortableRelativePath(action.relativeTarget, 'install target');
    assertInsideDir(plan.targetDir, action.target, 'install target outside target directory');
    await assertSafePathInside(plan.targetDir, action.target, 'install target');
  }

  const transactionId = createTransactionId();
  const backupRoot = path.join(plan.targetDir, '.loopengine', 'backups', transactionId);
  const trackedPaths = [
    ...plan.actions
      .filter((action) => ['write', 'retire'].includes(action.kind))
      .map((action) => action.target),
    ...plan.baselinePlan.actions.map((action) => path.join(plan.targetDir, action.target)),
    ...(plan.baselinePlan.manifestTarget ? [path.join(plan.targetDir, plan.baselinePlan.manifestTarget)] : []),
    path.join(plan.targetDir, '.loopengine', 'install-state.json'),
  ];
  const transaction = await beginFileTransaction({
    cleanupPaths: [
      backupRoot,
      ...(plan.baselinePlan.root ? [plan.baselinePlan.root] : []),
    ],
    id: transactionId,
    operation: 'install',
    targetDir: plan.targetDir,
    trackedPaths,
  });

  try {
  const written = [];
  const retired = [];
  const retiredFiles = [];
  const skipped = [];
  const files = [];
  const mcpConflicts = [];
  const backupId = transactionId;
  const previousState = await readInstallState(plan.targetDir);
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

  for (const action of plan.actions) {
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
    if (existed && !isManagedInstruction(action.contentStrategy) && !isManagedToml(action.contentStrategy)) {
      previousHash = await hashFile(action.target);
      backup = await backupFile({ backupId, target: action.target, targetDir: plan.targetDir });
    }

    await mkdir(path.dirname(action.target), { recursive: true });
    const mergedMcp = isManagedToml(action.contentStrategy)
      ? mergeManagedMcpBlock(existingContent, action.mcpServers)
      : null;
    if (mergedMcp) mcpConflicts.push(...mergedMcp.conflicts);
    const targetContent = mergedMcp?.content ?? await renderActionContent(action, plan.renderData, existingContent);
    await writeFile(action.target, targetContent, 'utf8');
    await hooks.afterFileWrite?.({ action, writtenCount: written.length + 1 });
    if (action.executable) await chmod(action.target, 0o755);
    written.push(action.target);
    files.push({
      backup,
      contentStrategy: action.contentStrategy,
      created: !existed,
      group: action.group,
      managedBlockHash: isManagedToml(action.contentStrategy)
        ? createHash('sha256').update(extractManagedMcpBlock(targetContent)).digest('hex')
        : (isManagedInstruction(action.contentStrategy)
            ? createHash('sha256').update(extractManagedInstructionBlock(targetContent) ?? '').digest('hex')
            : undefined),
      previousHash,
      originalBackup: backup,
      originalCreated: !existed,
      redZone: Boolean(action.redZone),
      source: action.relativeSource,
      sourceHash: await hashFile(action.source),
      owner: 'loopengine',
      target: toTargetPath(plan.targetDir, action.target),
      targetHash: await hashFile(action.target),
      transactionId,
    });
  }

  for (const action of plan.actions) {
    if (action.kind === 'retire-modified') {
      skipped.push({ reason: 'target-modified', target: action.relativeTarget });
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
    retiredFiles.push({
      backup,
      group: action.group,
      redZone: Boolean(action.redZone),
      target: action.relativeTarget,
      targetHash: currentHash,
    });
  }

  const retiredTargets = new Set(retiredFiles.map((file) => file.target));
  const mergedFiles = new Map((previousState?.files ?? [])
    .filter((file) => !retiredTargets.has(file.target))
    .map((file) => [file.target, file]));
  for (const file of files) {
    const previous = mergedFiles.get(file.target);
    mergedFiles.set(file.target, previous ? {
      ...file,
      originalBackup: Object.hasOwn(previous, 'originalBackup') ? previous.originalBackup : previous.backup,
      originalCreated: previous.originalCreated ?? previous.created,
    } : file);
  }
  const generatedDirectories = [...new Map([
    ...(previousState?.generatedDirectories ?? []),
    ...plan.generatedDirectories,
  ].map((item) => [item.target, item])).values()];
  await writeInstallState(plan.targetDir, {
    adapter: plan.adapter,
    baseline,
    files: [...mergedFiles.values()],
    generatedDirectories,
    generatedFiles,
    installedAt: new Date().toISOString(),
    profile: plan.profile,
    previewCapabilities: plan.previewCapabilities,
    requestedModules: plan.requestedModules,
    resolvedModules: plan.resolvedModules,
    retiredFiles,
    stateVersion: 3,
    transactionId,
    version: plan.version,
  });

  await transaction.commit();
  return { baseline, mcpConflicts: [...new Set(mcpConflicts)], retired, skipped, written };
  } catch (error) {
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], error.message);
    }
    throw error;
  }
}
