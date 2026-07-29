import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

import {
  assertInsideDir,
  assertPortableRelativePath,
  loadAllManifests,
  loadAllManifestSchemas,
  pathExists,
  readJson,
  validateAllManifestShapes,
  validateAllManifestSchemas,
  validateJsonAgainstSchema,
  validateInstallMapShape,
  validateManifestSources,
} from './manifest.js';
import { moduleCatalog } from './module-selection.js';
import { scanForForbiddenTerms } from './redaction.js';
import { resolveAdapterEntry } from './adapter.js';
import { validateDocumentation } from './docs-validation.js';

const forbiddenTerms = ['SYBaseProjectWeb', 'SYBaseProject', 'D:\\Github\\JW', 'T-019', 'T-024', '患者', '病理', '医疗'];
const redactionDirs = ['rules', 'templates', 'skills/core', 'skills/integrations', 'memory', 'runtime', 'adapters', 'manifests', 'schemas'];

async function collectEmptyDirs(dir, rootDir, results = []) {
  if (!(await pathExists(dir))) {
    return results;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await collectEmptyDirs(path.join(dir, entry.name), rootDir, results);
    }
  }

  const refreshedEntries = await readdir(dir, { withFileTypes: true });
  if (refreshedEntries.length === 0) {
    results.push(path.relative(rootDir, dir).replaceAll('\\', '/'));
  }
  return results;
}

export async function findInvalidSkillDirs(rootDir) {
  const roots = ['skills/core', 'skills/integrations'];
  const invalid = [];
  for (const root of roots) {
    const skillRoot = path.join(rootDir, root);
    assertInsideDir(rootDir, skillRoot, 'skill root');
    invalid.push(...await collectEmptyDirs(skillRoot, rootDir));
  }
  return invalid.sort();
}

async function checkRequiredTerms(rootDir, { file, terms }) {
  const fullPath = path.join(rootDir, file);
  if (!(await pathExists(fullPath))) {
    return [`${file} is missing`];
  }

  const content = await readFile(fullPath, 'utf8');
  return terms
    .filter((term) => !content.includes(term))
    .map((term) => `${file} must document ${term}`);
}

function parseSkillFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  if (!match) {
    return null;
  }

  const fields = {};
  const lines = match[1].split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fieldMatch = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/u);
    if (!fieldMatch) {
      continue;
    }

    const [, key, rawValue] = fieldMatch;
    if (rawValue === '>' || rawValue === '|') {
      const valueLines = [];
      for (index += 1; index < lines.length; index += 1) {
        const nextLine = lines[index];
        if (/^[a-zA-Z][\w-]*:\s*/u.test(nextLine)) {
          index -= 1;
          break;
        }
        valueLines.push(nextLine.trim());
      }
      fields[key] = valueLines.join(' ').trim();
      continue;
    }

    fields[key] = rawValue.replace(/^["']|["']$/gu, '').trim();
  }

  return fields;
}

function hasWorkflowHeavyDescription(description) {
  const processWords = ['先写', '再写', '再重构', '运行测试', '提交', '步骤', '流程'];
  return processWords.filter((word) => description.includes(word)).length >= 2;
}

export async function validateSkillMetadataQuality(rootDir, skillItems) {
  const errors = [];
  for (const item of skillItems) {
    const sourcePath = path.join(rootDir, item.source);
    assertInsideDir(rootDir, sourcePath, 'skill source');
    if (!(await pathExists(sourcePath))) {
      errors.push(`${item.id} skill source is missing: ${item.source}`);
      continue;
    }

    const content = await readFile(sourcePath, 'utf8');
    const frontmatter = parseSkillFrontmatter(content);
    if (!frontmatter) {
      errors.push(`${item.id} SKILL.md must start with YAML frontmatter`);
      continue;
    }

    if (frontmatter.name !== item.id) {
      errors.push(`${item.id} frontmatter name must match manifest id`);
    }
    if (!frontmatter.description) {
      errors.push(`${item.id} frontmatter description is required`);
    } else {
      if (frontmatter.description.length > 300) {
        errors.push(`${item.id} description must be 300 characters or fewer`);
      }
      if (hasWorkflowHeavyDescription(frontmatter.description)) {
        errors.push(`${item.id} description should describe triggers, not workflow steps`);
      }
    }
  }
  return errors.sort();
}

function findCanonicalCycle(itemsById, startId) {
  const pathIds = [];
  const positions = new Map();
  let currentId = startId;
  while (currentId) {
    if (positions.has(currentId)) {
      return [...pathIds.slice(positions.get(currentId)), currentId];
    }
    positions.set(currentId, pathIds.length);
    pathIds.push(currentId);
    currentId = itemsById.get(currentId)?.canonicalId;
  }
  return null;
}

export async function validateSkillGraph(
  rootDir,
  skillItems,
  profiles,
  { checkFiles = true, installEntries = [] } = {},
) {
  const errors = [];
  const itemsById = new Map(skillItems.map((item) => [item.id, item]));
  const reportedCycles = new Set();
  const proseOwners = new Map();
  let nativeBodyLines = 0;
  let nativeIdentityCharacters = 0;

  for (const item of skillItems) {
    for (const dependency of item.requiresSkills ?? []) {
      if (!itemsById.has(dependency)) errors.push(`${item.id} requires unknown skill: ${dependency}`);
    }
    for (const dependency of item.optionalSkills ?? []) {
      if (!itemsById.has(dependency)) errors.push(`${item.id} optional skill is unknown: ${dependency}`);
    }
    if (item.kind === 'compatibility') {
      if (!item.canonicalId) errors.push(`${item.id} requires canonicalId`);
      else if (!itemsById.has(item.canonicalId)) errors.push(`${item.id} canonical skill is unknown: ${item.canonicalId}`);
    } else if (item.kind === 'router' && item.canonicalId && !itemsById.has(item.canonicalId)) {
      errors.push(`${item.id} canonical skill is unknown: ${item.canonicalId}`);
    } else if (item.kind !== 'router' && item.canonicalId) {
      errors.push(`${item.id} may not declare canonicalId for kind ${item.kind}`);
    }

    const cycle = findCanonicalCycle(itemsById, item.id);
    if (cycle) {
      const normalized = [...cycle.slice(0, -1)].sort().join('|');
      if (!reportedCycles.has(normalized)) {
        errors.push(`canonical skill cycle: ${cycle.join(' -> ')}`);
        reportedCycles.add(normalized);
      }
    }

    if (checkFiles && await pathExists(path.join(rootDir, item.source))) {
      const content = await readFile(path.join(rootDir, item.source), 'utf8');
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? '';
      const frontmatterValue = (name) => {
        const value = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, 'mu'))?.[1]?.trim() ?? '';
        return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, '$1$2');
      };
      if (!frontmatter) errors.push(`${item.id} frontmatter is required`);
      if (frontmatterValue('name') !== item.id) errors.push(`${item.id} frontmatter name must equal ${item.id}`);
      if (!frontmatterValue('description')) errors.push(`${item.id} frontmatter description is required`);
      const prose = content
        .replace(/^---\r?\n[\s\S]*?\r?\n---/u, '')
        .replace(/```[\s\S]*?```/gu, '');
      for (const paragraph of prose.split(/(?:\r?\n){2,}/u)) {
        const normalized = paragraph.replace(/\s+/gu, ' ').trim();
        if (normalized.length < 200) continue;
        const owner = proseOwners.get(normalized);
        if (owner && owner !== item.id) errors.push(`duplicated long skill prose in ${owner} and ${item.id}`);
        else proseOwners.set(normalized, item.id);
      }
      const declaredSkills = new Set([
        ...(item.requiresSkills ?? []),
        ...(item.optionalSkills ?? []),
        ...(item.canonicalId ? [item.canonicalId] : []),
      ]);
      const backtickIds = [...content.matchAll(/`([a-z][a-z0-9-]+)`/gu)].map((match) => match[1]);
      for (const reference of new Set(backtickIds.filter((id) => id.includes('-') && !itemsById.has(id)))) {
        errors.push(`${item.id} references unregistered skill id: ${reference}`);
      }
      const referencedSkills = backtickIds.filter((id) => itemsById.has(id) && id !== item.id);
      for (const reference of new Set(referencedSkills)) {
        if (!declaredSkills.has(reference)) errors.push(`${item.id} has undeclared skill reference: ${reference}`);
      }
      const requiresFallback = (item.optionalSkills?.length ?? 0) > 0
        || (item.requiresTools?.length ?? 0) > 0;
      if (requiresFallback && !/(回退|fallback)/iu.test(content)) {
        errors.push(`${item.id} must document fallback for optional skills or tools`);
      }
      const lineCount = content.split(/\r?\n/u).length;
      const maxLines = item.kind === 'native' ? 35 : 160;
      if (lineCount > maxLines) errors.push(`${item.id} exceeds ${maxLines} line SKILL.md budget`);
      if (item.kind === 'native') {
        const description = frontmatterValue('description');
        nativeBodyLines += lineCount;
        nativeIdentityCharacters += item.id.length + description.length;
        const skillDir = path.dirname(path.join(rootDir, item.source));
        const openaiMetadata = path.join(skillDir, 'agents/openai.yaml');
        if (!(await pathExists(openaiMetadata))) {
          errors.push(`${item.id} must provide agents/openai.yaml`);
        } else {
          const yaml = await readFile(openaiMetadata, 'utf8');
          for (const term of ['interface:', 'display_name:', 'short_description:', 'default_prompt:', 'policy:', 'allow_implicit_invocation: true']) {
            if (!yaml.includes(term)) errors.push(`${item.id} agents/openai.yaml must contain ${term}`);
          }
        }
        const assets = await readdir(skillDir, { withFileTypes: true });
        const resourceCount = assets.filter((entry) => !['SKILL.md', 'metadata.json', 'agents'].includes(entry.name)).length;
        if (resourceCount > 2) errors.push(`${item.id} may contain at most two on-demand resources`);
      }
      if (!(await pathExists(path.join(rootDir, item.metadata)))) {
        errors.push(`${item.id} metadata is missing: ${item.metadata}`);
      } else {
        const metadata = await readJson(path.join(rootDir, item.metadata));
        if (metadata.id !== item.id) errors.push(`${item.id} metadata id must match manifest id`);
      }
    } else if (!checkFiles) {
      if ((item.optionalSkills?.length ?? 0) > 0) errors.push(`${item.id} must document fallback for optional skills`);
      if ((item.requiresTools?.length ?? 0) > 0) errors.push(`${item.id} must document fallback for tools`);
    }
  }

  if (nativeBodyLines > 250) errors.push(`native Skill body budget exceeds 250 lines: ${nativeBodyLines}`);
  if (nativeIdentityCharacters > 900) errors.push(`native Skill name and description budget exceeds 900 characters: ${nativeIdentityCharacters}`);

  if (checkFiles) {
    for (const root of ['skills/core', 'skills/integrations']) {
      const base = path.join(rootDir, root);
      if (!(await pathExists(base))) continue;
      const walk = async (directory, referenceDepth = 0) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const nextDepth = entry.name === 'references' ? referenceDepth + 1 : referenceDepth;
          if (nextDepth > 1) errors.push(`nested skill references are not allowed: ${path.relative(rootDir, path.join(directory, entry.name))}`);
          await walk(path.join(directory, entry.name), nextDepth);
        }
      };
      await walk(base);
    }
  }

  const sourceToId = new Map(skillItems.map((item) => [item.source, item.id]));
  for (const item of skillItems) {
    const entry = installEntries.find((candidate) => candidate.source === item.source);
    const expectedTarget = `.agents/skills/${item.id}/SKILL.md`;
    if (entry && entry.target.replaceAll('\\', '/') !== expectedTarget) {
      errors.push(`${item.id} must install to ${expectedTarget}`);
    }
  }
  for (const profile of profiles) {
    const installedIds = new Set(installEntries
      .filter((entry) => profile.groups.includes(entry.group) && sourceToId.has(entry.source))
      .map((entry) => sourceToId.get(entry.source)));
    for (const id of installedIds) {
      for (const dependency of itemsById.get(id)?.requiresSkills ?? []) {
        if (!installedIds.has(dependency)) errors.push(`${profile.id} installs ${id} without required skill ${dependency}`);
      }
    }
  }

  return errors.sort();
}

export async function validateContentQuality(rootDir) {
  const checks = [
    {
      file: 'rules/governance-core.md',
      terms: ['获取事实 → 直接执行 → 聚焦验证 → 简洁交付', '快速', '轻量', '完整', '人工确认', '验证范围必须与完成主张匹配'],
    },
    {
      file: 'templates/task.md',
      terms: ['可选的人读记录', '档位', '状态', '目标', '验收', '下一步', '验证', '风险'],
    },
    {
      file: 'templates/delivery.md',
      terms: ['结果', '实际变更', '本轮验证', '未验证项', '风险', '后续动作'],
    },
    {
      file: 'rules/agent-skill-routing.md',
      terms: ['description', '不使用 Router', '领域 Skill', '人工确认'],
    },
    {
      file: 'rules/test-rules.md',
      terms: ['验收矩阵', '退出码', '未验证项'],
    },
    {
      file: 'rules/ai-collab-rules.md',
      terms: ['单 Agent', '人工确认', '验证与主张匹配', '保护现有工作区'],
    },
    {
      file: 'rules/pencil-rules.md',
      terms: ['.pen', '.png', '验证'],
    },
    {
      file: 'rules/project-directory.md',
      terms: ['发现顺序', '放置规则', '跨边界变更'],
    },
    {
      file: 'rules/git-rules.md',
      terms: ['分支', '提交', 'PR'],
    },
    {
      file: 'rules/api-rules.md',
      terms: ['检查清单', '兼容策略', '验证证据'],
    },
    {
      file: 'rules/db-rules.md',
      terms: ['检查清单', '回滚路径', '验证证据'],
    },
    {
      file: 'rules/coding-rules.md',
      terms: ['检查清单', '依赖', '验证证据'],
    },
    {
      file: 'rules/frontend-rules.md',
      terms: ['检查清单', '浏览器', '验证证据'],
    },
    {
      file: 'rules/log-management.md',
      terms: ['检查清单', '关联 ID', '检索', '脱敏', '验证证据'],
    },
    {
      file: 'rules/release-rules.md',
      terms: ['检查清单', '回滚', '监控'],
    },
    {
      file: 'rules/troubleshooting.md',
      terms: ['检查清单', '最小复现', '验证证据'],
    },
    {
      file: 'skills/core/clarify-requirements/SKILL.md',
      terms: ['安全审批', '阻塞产品决定', '可逆实现选择', '最多三个', '推荐项', '回答关闭分支后立即继续'],
    },
    {
      file: 'skills/core/define-goal/SKILL.md',
      terms: ['4000', '执行型', '探索型', '明确要求激活', '不得静默替换', '不扩大授权'],
    },
  ];

  const results = await Promise.all(checks.map((check) => checkRequiredTerms(rootDir, check)));
  const errors = results.flat();
  const agentsPath = path.join(rootDir, 'AGENTS.md');
  if (await pathExists(agentsPath)) {
    const agents = await readFile(agentsPath, 'utf8');
    if (!/--project[^\n]*--write/u.test(agents)) errors.push('AGENTS.md must document the --project/--write lifecycle');
    if (/pnpm cognis[^\n]*(?:codex-internal|codex-minimal|--apply)/u.test(agents)) errors.push('AGENTS.md must not contain removed legacy lifecycle commands');
  }
  const [agentsTemplate, governanceCore] = await Promise.all([
    readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/governance-core.md'), 'utf8'),
  ]);
  const residentLines = `${agentsTemplate}\n${governanceCore}`.split(/\r?\n/u).length;
  if (residentLines > 90) errors.push(`resident governance surface exceeds 90 lines: ${residentLines}`);

  const proseOwners = new Map();
  for (const directory of ['rules', 'templates']) {
    for (const entry of await readdir(path.join(rootDir, directory), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      const relative = path.relative(rootDir, file).replaceAll('\\', '/');
      const content = await readFile(file, 'utf8');
      if (/更严格(?:的本地)?规则/u.test(content)) {
        errors.push(`${relative} uses ambiguous stricter-rule precedence`);
      }
      for (const paragraph of content.replace(/```[\s\S]*?```/gu, '').split(/(?:\r?\n){2,}/u)) {
        const normalized = paragraph.replace(/\s+/gu, ' ').trim();
        if (normalized.length < 240) continue;
        const owner = proseOwners.get(normalized);
        if (owner && owner !== relative) errors.push(`duplicated long policy prose in ${owner} and ${relative}`);
        else proseOwners.set(normalized, relative);
      }
    }
  }
  return errors.sort();
}

export async function validateCapabilityMatrix(rootDir, matrix, { checkFiles = true } = {}) {
  const errors = [];
  const allowed = new Set(['generalize', 'validator', 'template', 'project-only', 'excluded-with-reason']);
  if (matrix?.schemaVersion !== 2 || !Array.isArray(matrix?.items)) {
    return ['manifests/capabilities.json must use schemaVersion 2 with an items array'];
  }
  let knownProfiles = new Set();
  let catalogDocs = new Set();
  try {
    const [profiles, catalog] = await Promise.all([
      readJson(path.join(rootDir, 'manifests/profiles.json')),
      readJson(path.join(rootDir, 'docs/catalog.json')),
    ]);
    knownProfiles = new Set(profiles.items.map((item) => item.id));
    catalogDocs = new Set(catalog.items.map((item) => item.path));
  } catch (error) {
    errors.push(`capability evidence catalogs are unavailable: ${error.message}`);
  }
  const ids = new Set();
  for (const item of matrix.items) {
    const id = item?.id ?? '<missing-id>';
    if (ids.has(id)) errors.push(`Duplicate capability id: ${id}`);
    ids.add(id);
    if (!allowed.has(item?.disposition)) errors.push(`${id} has invalid disposition`);
    if (!Array.isArray(item?.tests) || item.tests.length === 0) {
      errors.push(`${id} requires at least one test`);
    }
    if (!Array.isArray(item?.profiles)) errors.push(`${id} requires a profiles array`);
    else for (const profile of item.profiles) {
      if (!knownProfiles.has(profile)) errors.push(`${id} references unknown profile: ${profile}`);
    }
    if (!Array.isArray(item?.docs) || item.docs.length === 0) errors.push(`${id} requires at least one documentation path`);
    else for (const document of item.docs) {
      if (!catalogDocs.has(document)) errors.push(`${id} documentation path is not in the documentation catalog: ${document}`);
    }
    if (typeof item?.evaluation?.required !== 'boolean') {
      errors.push(`${id} requires an evaluation policy`);
    } else if (item.evaluation.required && (!Array.isArray(item.evaluation.suites) || item.evaluation.suites.length === 0)) {
      errors.push(`${id} requires at least one evaluation suite`);
    } else if (!item.evaluation.required && (typeof item.evaluation.reason !== 'string' || !item.evaluation.reason.trim())) {
      errors.push(`${id} requires an evaluation reason when model evaluation is not required`);
    }
    if (['project-only', 'excluded-with-reason'].includes(item?.disposition)) {
      if (typeof item?.reason !== 'string' || !item.reason.trim()) errors.push(`${id} requires a reason`);
    } else if (!Array.isArray(item?.targets) || item.targets.length === 0) {
      errors.push(`${id} requires at least one target`);
    }
    if (checkFiles) {
      for (const candidate of [
        ...(item?.targets ?? []),
        ...(item?.tests ?? []),
        ...(item?.docs ?? []),
        ...(item?.evaluation?.suites ?? []),
      ]) {
        try {
          assertPortableRelativePath(candidate, `${id} evidence path`);
          const candidatePath = path.join(rootDir, candidate);
          assertInsideDir(rootDir, candidatePath, `${id} evidence path`);
          if (!await pathExists(candidatePath)) errors.push(`${id} evidence path is missing: ${candidate}`);
        } catch (error) {
          errors.push(error.message);
        }
      }
    }
  }
  const requiredCapabilities = [
    'execution-kernel',
    'native-skill-selection',
    'goal-definition',
    'git-and-worktree',
    'engineering-rules',
    'memory-templates',
    'pencil-assets',
    'release',
    'eval-driven-development',
    'project-business-contracts',
    'runtime-application-code',
    'installer-lifecycle',
    'hook-policy',
    'docs-governance',
    'tool-provisioning',
    'skill-quality',
    'eval-observability',
    'cross-platform-adapters',
  ];
  for (const id of requiredCapabilities) {
    if (!ids.has(id)) errors.push(`Missing required capability: ${id}`);
  }
  return errors.sort();
}

// Cognis render placeholders take the form {{name}} or {{name.field}}. Sources
// containing them are rendered at install time, so the installed artifact is
// not expected to be byte-identical to the source and is excluded from the
// self-install drift check.
const renderPlaceholderPattern = /\{\{[a-zA-Z][\w]*(?:\.[\w]+)*\}\}/u;

function normalizeLineEndings(value) {
  return value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

// Cognis installs into its own repository to dogfood the installer. For
// `replace` entries whose source carries no render placeholders, the
// self-installed artifact must stay byte-identical (modulo line endings) to
// the source. This catches drift such as a schema gaining a field in `schemas/`
// but the rendered copy in `docs/schemas/` not being regenerated.
export async function validateSelfInstalledArtifacts(rootDir, adapters, installMaps) {
  const errors = [];
  const codex = adapters.items.find((item) => item.id === 'codex');
  if (!codex) return errors;
  const installMap = installMaps.get(codex.installMap);
  if (!installMap) return errors;

  for (const rawEntry of installMap.entries) {
    if (rawEntry.contentStrategy !== 'replace') continue;
    const entry = resolveAdapterEntry(codex, rawEntry);
    if (!entry) continue;
    const sourcePath = path.join(rootDir, entry.source);
    const targetPath = path.join(rootDir, entry.target);
    let sourceContent;
    try {
      sourceContent = await readFile(sourcePath, 'utf8');
    } catch {
      // Missing sources are already reported by install-map source checks.
      continue;
    }
    if (renderPlaceholderPattern.test(sourceContent)) continue;
    let targetContent;
    try {
      targetContent = await readFile(targetPath, 'utf8');
    } catch {
      // The artifact is absent in this repository (e.g. a plugin not enabled
      // for the self-install). Nothing to compare against.
      continue;
    }
    if (normalizeLineEndings(sourceContent) !== normalizeLineEndings(targetContent)) {
      errors.push(`self-installed artifact drifted from source: ${entry.source} -> ${entry.target}`);
    }
  }
  return errors.sort();
}

export async function validatePack(rootDir) {
  const manifests = await loadAllManifests(rootDir);
  const schemas = await loadAllManifestSchemas(rootDir);
  const installMapSchema = await readJson(path.join(rootDir, 'schemas/install-map.schema.json'));
  validateAllManifestShapes(manifests);
  const schemaErrors = validateAllManifestSchemas(manifests, schemas);

  const knownGroups = new Set([
    ...manifests.profiles.items.flatMap((item) => item.groups),
    ...Object.values(moduleCatalog).flatMap((module) => module.groups),
  ]);
  const installMapMissing = [];
  const installedSources = new Set();
  const installMaps = new Map();
  for (const adapter of manifests.adapters.items) {
    let installMap = installMaps.get(adapter.installMap);
    if (!installMap) {
      installMap = await readJson(path.join(rootDir, adapter.installMap));
      installMaps.set(adapter.installMap, installMap);
      schemaErrors.push(...validateJsonAgainstSchema(installMap, installMapSchema, adapter.installMap));
    }
    validateInstallMapShape(installMap, knownGroups);
    for (const rawEntry of installMap.entries) {
      const entry = resolveAdapterEntry(adapter, rawEntry);
      if (!entry) continue;
      installedSources.add(entry.source);
      assertPortableRelativePath(entry.source, 'install-map source');
      const sourcePath = path.join(rootDir, entry.source);
      assertInsideDir(rootDir, sourcePath, 'install-map source');
      if (!(await pathExists(sourcePath))) {
        installMapMissing.push(entry.source);
      }
    }
  }

  const missing = await validateManifestSources(rootDir, manifests);
  const missingSkillInstalls = manifests.skills.items
    .filter((item) => !installedSources.has(item.source))
    .map((item) => item.source)
    .sort();
  const invalidSkillDirs = await findInvalidSkillDirs(rootDir);
  const skillMetadataErrors = await validateSkillMetadataQuality(rootDir, manifests.skills.items);
  // Merge install entries across all adapters so skill-graph validation covers
  // every adapter's install map, not just the first. Entries are deduped by
  // source so a skill installed by multiple adapters is counted once.
  const mergedInstallEntries = [];
  const seenEntrySources = new Set();
  for (const adapter of manifests.adapters.items) {
    const installMap = installMaps.get(adapter.installMap);
    for (const rawEntry of installMap.entries) {
      const entry = resolveAdapterEntry(adapter, rawEntry);
      if (!entry) continue;
      if (seenEntrySources.has(entry.source)) continue;
      seenEntrySources.add(entry.source);
      mergedInstallEntries.push(entry);
    }
  }
  const skillGraphErrors = await validateSkillGraph(rootDir, manifests.skills.items, manifests.profiles.items, {
    installEntries: mergedInstallEntries,
  });
  const contentQualityErrors = await validateContentQuality(rootDir);
  const capabilityMatrix = await readJson(path.join(rootDir, 'manifests/capabilities.json'));
  const capabilityErrors = await validateCapabilityMatrix(rootDir, capabilityMatrix);
  const leaks = await scanForForbiddenTerms({
    forbiddenTerms,
    includeDirs: redactionDirs,
    rootDir,
  });
  const documentation = await validateDocumentation({ rootDir });
  const selfInstallErrors = await validateSelfInstalledArtifacts(rootDir, manifests.adapters, installMaps);

  return {
    capabilityErrors,
    contentQualityErrors,
    leaks,
    missing: [...missing, ...installMapMissing].sort(),
    missingSkillInstalls,
    invalidSkillDirs,
    skillMetadataErrors,
    skillGraphErrors,
    documentationErrors: documentation.errors,
    documentationWarnings: documentation.warnings,
    selfInstallErrors,
    ok: missing.length === 0
      && installMapMissing.length === 0
      && missingSkillInstalls.length === 0
      && invalidSkillDirs.length === 0
      && skillMetadataErrors.length === 0
      && skillGraphErrors.length === 0
      && contentQualityErrors.length === 0
      && capabilityErrors.length === 0
      && documentation.errors.length === 0
      && leaks.length === 0
      && schemaErrors.length === 0
      && selfInstallErrors.length === 0,
    schemaErrors: schemaErrors.sort(),
  };
}
