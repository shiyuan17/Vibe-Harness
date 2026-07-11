import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  backupFile,
  collectTargetFiles,
  createBackupId,
  hashFile,
  readInstallState,
  toTargetPath,
  writeInstallState,
} from './install-state.js';
import {
  assertInsideDir,
  assertPortableRelativePath,
  pathExists,
  readJson,
  validateCatalogManifest,
  validateInstallMapShape,
} from './manifest.js';
import {
  extractManagedAgentsBlock,
  mergeManagedAgentsBlock,
  renderManagedAgentsBlock,
  renderTemplate,
  withDefaultTemplateData,
} from './template-renderer.js';

async function loadProfileInstallMap({ profile, rootDir }) {
  const profiles = await readJson(path.join(rootDir, 'manifests/profiles.json'));
  validateCatalogManifest('profiles', profiles);

  const selectedProfile = profiles.items.find((item) => item.id === profile);
  if (!selectedProfile) {
    throw new Error(`Unknown profile: ${profile}`);
  }

  const installMap = await readJson(path.join(rootDir, selectedProfile.installMap));
  const knownGroups = new Set(profiles.items.flatMap((item) => item.groups));
  validateInstallMapShape(installMap, knownGroups);

  return { installMap, selectedProfile };
}

async function packageVersion(rootDir) {
  const pkg = await readJson(path.join(rootDir, 'package.json'));
  return pkg.version;
}

export function createInstalledSurface({ memoryPath = '.agents/memory', profile, targets }) {
  const installedTargets = targets.map((target) => target.replaceAll('\\', '/'));
  const hasTarget = (expectedTarget) => installedTargets.includes(expectedTarget);
  const hasPrefix = (prefix) => installedTargets.some((target) => target.startsWith(prefix));
  const hasReviewLoop = hasTarget('.agents/skills/adversarial-review-packet/SKILL.md')
    || hasTarget('.agents/skills/loop-planning/SKILL.md');
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
  const hasAgentMemorySkills = [
    '.agents/skills/recall/SKILL.md',
    '.agents/skills/remember/SKILL.md',
    '.agents/skills/session-history/SKILL.md',
  ].some(hasTarget);
  const normalizedMemoryPath = memoryPath.replaceAll('\\', '/').replace(/\/+$/u, '');
  const hasLocalMemory = installedTargets.includes(`${normalizedMemoryPath}/README.md`);
  const profileLines = {
    'codex-internal': '- 当前安装方式：`codex-internal` 兼容入口，等同全安装。',
    'codex-minimal': '- 当前安装方式：最小安装（兼容入口 `codex-minimal`）。',
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
      ? `- agentmemory skills 位于 \`.agents/skills/\`${hasLocalMemory ? `，本地记忆库位于 \`${normalizedMemoryPath}/\`` : ''}。`
      : '',
    operationalRulesLine: hasOperationalRules ? '- 发布 / 设计 / 排障规则位于 `docs/rules/`。' : '',
    profileLine: profileLines[profile] ?? `- 当前 profile: \`${profile}\`。`,
    reviewLoopLine: hasReviewLoop ? '- 当前 profile 包含 review / loop 资产。' : '',
    rulesLine: hasPrefix('docs/rules/') ? '- 规则位于 `docs/rules/`。' : '',
    skillRoutingLine: hasTarget('.agents/skills/using-loopengine/SKILL.md')
      ? '先使用 `using-loopengine` 选择最小 Skill 集；详细流程按任务信号加载。'
      : '当前 profile 未安装 Skills；仅按已安装规则和模板执行，不引用未安装的 skill。',
    skillsLine: hasPrefix('.agents/skills/') ? '- Skills 位于 `.agents/skills/`。' : '',
    templatesLine: hasPrefix('docs/templates/') ? '- 模板位于 `docs/templates/`。' : '',
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

export async function createInstallPlan({
  dryRun = true,
  force = false,
  managedAgentsBlock = false,
  profile = 'codex-internal',
  renderData = {},
  rootDir,
  targetDir,
  upgrade = false,
}) {
  const { installMap, selectedProfile } = await loadProfileInstallMap({ profile, rootDir });
  const allowedGroups = new Set(selectedProfile.groups);
  const actions = [];
  const state = await readInstallState(path.resolve(targetDir));
  const managed = new Map((state?.files ?? []).map((file) => [file.target, file]));

  for (const entry of installMap.entries) {
    if (!allowedGroups.has(entry.group)) {
      continue;
    }
    if (!shouldInstallEntry(entry, renderData)) {
      continue;
    }
    assertPortableRelativePath(entry.source, 'install source');
    const mappedTarget = memoryTargetPath(renderData, entry.target);
    assertPortableRelativePath(mappedTarget, 'install target');
    const source = path.resolve(rootDir, entry.source);
    const target = path.resolve(targetDir, mappedTarget);
    assertInsideDir(rootDir, source, 'install source');
    assertInsideDir(targetDir, target, 'install target');
    const relativeSource = entry.source.replaceAll('\\', '/');
    const relativeTarget = mappedTarget;
    const contentStrategy = managedAgentsBlock && relativeTarget === 'AGENTS.md' ? 'managed-block' : 'replace';
    const exists = await pathExists(target);
    let kind = exists && !force ? 'conflict' : 'write';
    const managedFile = managed.get(relativeTarget);

    if (contentStrategy === 'managed-block') {
      kind = 'write';
    }

    if (upgrade) {
      kind = 'write';
      if (exists && managedFile && !force) {
        const currentHash = await hashFile(target);
        if (currentHash !== managedFile.targetHash) {
          kind = 'user-modified';
        }
      } else if (exists && !managedFile && !force) {
        kind = 'conflict';
      }
    }

    actions.push({
      group: entry.group,
      kind,
      contentStrategy,
      redZone: Boolean(entry.redZone),
      relativeSource,
      relativeTarget,
      source,
      target,
    });
  }

  const installedSurface = createInstalledSurface({
    memoryPath: renderData.memory?.path,
    profile,
    targets: actions.map((action) => action.relativeTarget),
  });

  return {
    dryRun,
    force,
    profile,
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
  const rendered = await renderSourceContent(action, renderData);
  if (action.contentStrategy === 'managed-block') {
    return mergeManagedAgentsBlock(existingContent, rendered);
  }
  return rendered;
}

export async function previewInstallPlan(plan) {
  const previewFiles = [];
  for (const action of plan.actions) {
    if (action.kind === 'conflict' || action.kind === 'user-modified') {
      continue;
    }
    const existingContent = action.contentStrategy === 'managed-block' && await pathExists(action.target)
      ? await readFile(action.target, 'utf8')
      : '';
    previewFiles.push({
      content: await renderActionContent(action, plan.renderData, existingContent),
      group: action.group,
      redZone: action.redZone,
      target: action.relativeTarget,
    });
  }
  return previewFiles;
}

export async function diffTargetInstall({
  managedAgentsBlock = false,
  profile = 'codex-internal',
  renderData = {},
  rootDir,
  targetDir,
}) {
  const { installMap, selectedProfile } = await loadProfileInstallMap({ profile, rootDir });
  const allowedGroups = new Set(selectedProfile.groups);
  const selectedEntries = installMap.entries.filter((entry) => allowedGroups.has(entry.group) && shouldInstallEntry(entry, renderData));
  const installedTargets = selectedEntries.map((entry) => memoryTargetPath(renderData, entry.target));
  const renderedData = withDefaultTemplateData({
    ...renderData,
    installedSurface: createInstalledSurface({
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
      contentStrategy: managedAgentsBlock && mappedTarget === 'AGENTS.md' ? 'managed-block' : 'replace',
      group: entry.group,
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
      const matches = item.contentStrategy === 'managed-block'
        ? extractManagedAgentsBlock(targetContent) === renderManagedAgentsBlock(sourceContent)
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

export async function applyInstallPlan(plan) {
  if (plan.dryRun) {
    return { written: [] };
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

  const written = [];
  const files = [];
  const backupId = createBackupId();

  for (const action of plan.actions) {
    if (action.kind !== 'write') {
      continue;
    }
    assertPortableRelativePath(action.relativeSource, 'install source');
    assertPortableRelativePath(action.relativeTarget, 'install target');
    assertInsideDir(plan.targetDir, action.target, 'install target');
    const existed = await pathExists(action.target);
    let backup = null;
    let previousHash = null;
    const existingContent = existed ? await readFile(action.target, 'utf8') : '';
    if (existed && action.contentStrategy !== 'managed-block') {
      previousHash = await hashFile(action.target);
      backup = await backupFile({ backupId, target: action.target, targetDir: plan.targetDir });
    }

    await mkdir(path.dirname(action.target), { recursive: true });
    await writeFile(action.target, await renderActionContent(action, plan.renderData, existingContent), 'utf8');
    written.push(action.target);
    files.push({
      backup,
      created: !existed,
      group: action.group,
      previousHash,
      redZone: Boolean(action.redZone),
      source: action.relativeSource,
      sourceHash: await hashFile(action.source),
      target: toTargetPath(plan.targetDir, action.target),
      targetHash: await hashFile(action.target),
    });
  }

  await writeInstallState(plan.targetDir, {
    files,
    installedAt: new Date().toISOString(),
    profile: plan.profile,
    version: plan.version,
  });

  return { written };
}
