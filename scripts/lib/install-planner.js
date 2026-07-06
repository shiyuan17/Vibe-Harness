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
import { pathExists, readJson, validateCatalogManifest, validateInstallMapShape } from './manifest.js';
import { renderTemplate, withDefaultTemplateData } from './template-renderer.js';

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

export function createInstalledSurface({ profile, targets }) {
  const installedTargets = targets.map((target) => target.replaceAll('\\', '/'));
  const hasTarget = (expectedTarget) => installedTargets.includes(expectedTarget);
  const hasPrefix = (prefix) => installedTargets.some((target) => target.startsWith(prefix));
  const hasReviewLoop = hasTarget('docs/workflows/review.md')
    || hasTarget('docs/workflows/loop.md')
    || hasTarget('docs/rules/review-rules.md')
    || hasTarget('docs/rules/loop-engineering.md');
  const profileLines = {
    'codex-internal': '- 当前 profile: `codex-internal`，包含完整 Codex 内部安装面。',
    'codex-minimal': '- 当前 profile: `codex-minimal`，安装最小 Codex 入口规则和模板。',
    core: '- 当前 profile: `core`，安装核心规则、模板、skills 和 workflows。',
    'docs-only': '- 当前 profile: `docs-only`，仅安装文档类资产。',
    full: '- 当前 profile: `full`，安装完整 MVP 规则、模板、skills 和 workflows。',
    minimal: '- 当前 profile: `minimal`，安装最小 Codex 入口规则和模板。',
  };

  return {
    hooksLine: hasTarget('.codex/hooks.json') ? '- Codex hook 配置位于 `.codex/hooks.json`。' : '',
    profileLine: profileLines[profile] ?? `- 当前 profile: \`${profile}\`。`,
    reviewLoopLine: hasReviewLoop ? '- 当前 profile 包含 review / loop 资产。' : '',
    rulesLine: hasPrefix('docs/rules/') ? '- 规则位于 `docs/rules/`。' : '',
    skillsLine: hasPrefix('.agents/skills/') ? '- Skills 位于 `.agents/skills/`。' : '',
    templatesLine: hasPrefix('docs/templates/') ? '- 模板位于 `docs/templates/`。' : '',
    workflowsLine: hasPrefix('docs/workflows/') ? '- Workflows 位于 `docs/workflows/`。' : '',
  };
}

export async function createInstallPlan({
  dryRun = true,
  force = false,
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
    const source = path.resolve(rootDir, entry.source);
    const target = path.resolve(targetDir, entry.target);
    const relativeSource = entry.source.replaceAll('\\', '/');
    const relativeTarget = entry.target.replaceAll('\\', '/');
    const exists = await pathExists(target);
    let kind = exists && !force ? 'conflict' : 'write';
    const managedFile = managed.get(relativeTarget);

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
      redZone: Boolean(entry.redZone),
      relativeSource,
      relativeTarget,
      source,
      target,
    });
  }

  const installedSurface = createInstalledSurface({
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

export async function renderActionContent(action, renderData = {}) {
  const content = await readFile(action.source, 'utf8');
  return renderTemplate(content, renderData);
}

export async function previewInstallPlan(plan) {
  const previewFiles = [];
  for (const action of plan.actions) {
    if (action.kind === 'conflict' || action.kind === 'user-modified') {
      continue;
    }
    previewFiles.push({
      content: await renderActionContent(action, plan.renderData),
      group: action.group,
      redZone: action.redZone,
      target: action.relativeTarget,
    });
  }
  return previewFiles;
}

export async function diffTargetInstall({ profile = 'codex-internal', renderData = {}, rootDir, targetDir }) {
  const { installMap, selectedProfile } = await loadProfileInstallMap({ profile, rootDir });
  const allowedGroups = new Set(selectedProfile.groups);
  const selectedEntries = installMap.entries.filter((entry) => allowedGroups.has(entry.group));
  const renderedData = withDefaultTemplateData({
    ...renderData,
    installedSurface: createInstalledSurface({
      profile,
      targets: selectedEntries.map((entry) => entry.target),
    }),
  });
  const expected = [];
  const missing = [];
  const same = [];
  const changed = [];
  const redZone = [];
  const expectedTargets = new Set();

  for (const entry of selectedEntries) {
    const target = path.resolve(targetDir, entry.target);
    const source = path.resolve(rootDir, entry.source);
    const item = {
      group: entry.group,
      redZone: Boolean(entry.redZone),
      source,
      target: entry.target.replaceAll('\\', '/'),
    };
    expected.push(item);
    expectedTargets.add(item.target);
    if (item.redZone) {
      redZone.push({ ...item, status: await pathExists(target) ? 'present' : 'missing' });
    }

    if (await pathExists(target)) {
      const [sourceContent, targetContent] = await Promise.all([
        renderActionContent({ source }, renderedData),
        readFile(target, 'utf8'),
      ]);
      if (sourceContent !== targetContent) {
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

  return {
    changed,
    conflicts: changed,
    expected,
    missing,
    ok: missing.length === 0 && changed.length === 0,
    profile,
    redZone,
    same,
    targetDir: path.resolve(targetDir),
    unmanaged,
  };
}

export const inspectTargetInstall = diffTargetInstall;

export async function applyInstallPlan(plan) {
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
  if (plan.dryRun) {
    return { written };
  }

  for (const action of plan.actions) {
    if (action.kind !== 'write') {
      continue;
    }
    const existed = await pathExists(action.target);
    let backup = null;
    let previousHash = null;
    if (existed) {
      previousHash = await hashFile(action.target);
      backup = await backupFile({ backupId, target: action.target, targetDir: plan.targetDir });
    }

    await mkdir(path.dirname(action.target), { recursive: true });
    await writeFile(action.target, await renderActionContent(action, plan.renderData), 'utf8');
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
