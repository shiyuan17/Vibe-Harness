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
import { scanForForbiddenTerms } from './redaction.js';

const forbiddenTerms = ['SYBaseProjectWeb', 'SYBaseProject', 'D:\\Github\\JW', 'T-019', 'T-024', '患者', '病理', '医疗'];
const redactionDirs = ['rules', 'templates', 'skills/core', 'skills/integrations', 'memory', 'runtime', 'workflows', 'adapters/codex', 'manifests', 'schemas'];

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
      if (frontmatter.description.length > 240) {
        errors.push(`${item.id} description must be 240 characters or fewer`);
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

  for (const item of skillItems) {
    for (const dependency of item.requiresSkills ?? []) {
      if (!itemsById.has(dependency)) errors.push(`${item.id} requires unknown skill: ${dependency}`);
    }
    for (const dependency of item.optionalSkills ?? []) {
      if (!itemsById.has(dependency)) errors.push(`${item.id} optional skill is unknown: ${dependency}`);
    }
    if (['router', 'compatibility'].includes(item.kind)) {
      if (!item.canonicalId) errors.push(`${item.id} requires canonicalId`);
      else if (!itemsById.has(item.canonicalId)) errors.push(`${item.id} canonical skill is unknown: ${item.canonicalId}`);
    } else if (item.canonicalId) {
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
      const maxLines = ['router', 'compatibility'].includes(item.kind) ? 30 : 160;
      if (lineCount > maxLines) errors.push(`${item.id} exceeds ${maxLines} line SKILL.md budget`);
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

export async function validateGovernanceQuality(rootDir) {
  const checks = [
    {
      file: 'workflows/fast-path.md',
      terms: ['阶段目标', '输入内容', '输出内容', '完成标准', '常见异常', '异常处理方式'],
    },
    {
      file: 'workflows/lightweight.md',
      terms: ['阶段目标', '输入内容', '输出内容', '完成标准', '常见异常', '异常处理方式'],
    },
    {
      file: 'workflows/full.md',
      terms: ['阶段目标', '输入内容', '输出内容', '完成标准', '常见异常', '异常处理方式'],
    },
    {
      file: 'workflows/review.md',
      terms: ['阶段目标', '输入内容', '输出内容', '完成标准', '常见异常', '异常处理方式'],
    },
    {
      file: 'workflows/loop.md',
      terms: ['阶段目标', '输入内容', '输出内容', '完成标准', '常见异常', '异常处理方式'],
    },
    {
      file: 'templates/spec-template.md',
      terms: ['必填', '禁止空泛', '完成标准'],
    },
    {
      file: 'templates/plan-template.md',
      terms: ['必填', '禁止空泛', '验证命令', 'implementation-notes.md', '偏离说明'],
    },
    {
      file: 'templates/task-intake.md',
      terms: ['必填', '写入范围', '禁止动作', '盲点审查结论', '下一步建议提问', '关键未决问题'],
    },
    {
      file: 'templates/implementation-notes.md',
      terms: ['原计划摘要', '当前假设', '边缘 case', '采用的保守备选', '偏离说明', '影响范围', '验证证据', '后续处理'],
    },
    {
      file: 'templates/review-packet.md',
      terms: ['必填', '阻断条件', '严重度'],
    },
    {
      file: 'templates/handoff-template.md',
      terms: ['必填', '恢复提示', '下一步最小动作'],
    },
    {
      file: 'templates/workflow-packet.md',
      terms: ['必填', '工作流档位', '安装配置'],
    },
    {
      file: 'rules/test-rules.md',
      terms: ['验收矩阵', '退出码', '未验证项'],
    },
    {
      file: 'rules/review-rules.md',
      terms: ['输入', '输出', '阻断条件'],
    },
    {
      file: 'rules/workflow.md',
      terms: ['澄清', '复盘', '失败记录包'],
    },
    {
      file: 'rules/handoff-rules.md',
      terms: ['触发条件', '必填字段', '恢复提示', '完成标准'],
    },
    {
      file: 'rules/retrospective-rules.md',
      terms: ['触发条件', '失败模式', '根因', '验证方式'],
    },
    {
      file: 'rules/dynamic-workflow.md',
      terms: ['工作流档位', '安装配置', 'implementation-notes.md', '偏离说明'],
    },
    {
      file: 'rules/session-protocol.md',
      terms: ['会话开始协议', '会话结束协议', '盲点审查', '红区确认'],
    },
    {
      file: 'rules/task-intake.md',
      terms: ['必填字段', '入口门禁', '写入范围', '回滚计划'],
    },
    {
      file: 'rules/task-management.md',
      terms: ['真值来源', '父子任务规则', 'resumeHint', 'merge-back'],
    },
    {
      file: 'rules/ai-collab-rules.md',
      terms: ['证据边界', '角色边界', '实现 Agent', 'reviewer'],
    },
    {
      file: 'rules/pencil-rules.md',
      terms: ['交付门禁', '.pen', '.png', '验证'],
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
      file: 'schemas/task.schema.json',
      terms: ['writeScope', 'forbiddenActions', 'verification', 'rollbackPlan'],
    },
    {
      file: 'skills/core/brainstorming/SKILL.md',
      terms: ['反向采访', '盲点审查', '每次只问一个'],
    },
    {
      file: 'skills/core/task-intake/SKILL.md',
      terms: ['反向采访', '盲点审查', '每次只问一个'],
    },
  ];

  const results = await Promise.all(checks.map((check) => checkRequiredTerms(rootDir, check)));
  return results.flat().sort();
}

export async function validateCapabilityMatrix(rootDir, matrix, { checkFiles = true } = {}) {
  const errors = [];
  const allowed = new Set(['generalize', 'validator', 'template', 'project-only', 'excluded-with-reason']);
  if (matrix?.schemaVersion !== 1 || !Array.isArray(matrix?.items)) {
    return ['manifests/capabilities.json must use schemaVersion 1 with an items array'];
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
    if (['project-only', 'excluded-with-reason'].includes(item?.disposition)) {
      if (typeof item?.reason !== 'string' || !item.reason.trim()) errors.push(`${id} requires a reason`);
    } else if (!Array.isArray(item?.targets) || item.targets.length === 0) {
      errors.push(`${id} requires at least one target`);
    }
    if (checkFiles) {
      for (const candidate of [...(item?.targets ?? []), ...(item?.tests ?? [])]) {
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
    'entry-and-session',
    'task-intake',
    'task-lifecycle',
    'task-backlog-semantics',
    'workflow-packet',
    'review',
    'git-and-worktree',
    'engineering-rules',
    'governance-memory',
    'pencil-assets',
    'release',
    'project-business-contracts',
    'runtime-application-code',
  ];
  for (const id of requiredCapabilities) {
    if (!ids.has(id)) errors.push(`Missing required capability: ${id}`);
  }
  return errors.sort();
}

export async function validatePack(rootDir) {
  const manifests = await loadAllManifests(rootDir);
  const schemas = await loadAllManifestSchemas(rootDir);
  const installMapSchema = await readJson(path.join(rootDir, 'schemas/install-map.schema.json'));
  validateAllManifestShapes(manifests);
  const schemaErrors = validateAllManifestSchemas(manifests, schemas);

  const knownGroups = new Set(manifests.profiles.items.flatMap((item) => item.groups));
  const installMapMissing = [];
  const installedSources = new Set();
  for (const profile of manifests.profiles.items) {
    const installMap = await readJson(path.join(rootDir, profile.installMap));
    schemaErrors.push(...validateJsonAgainstSchema(installMap, installMapSchema, profile.installMap));
    validateInstallMapShape(installMap, knownGroups);
    for (const entry of installMap.entries) {
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
  const skillGraphErrors = await validateSkillGraph(rootDir, manifests.skills.items, manifests.profiles.items, {
    installEntries: (await readJson(path.join(rootDir, manifests.profiles.items[0].installMap))).entries,
  });
  const governanceQualityErrors = await validateGovernanceQuality(rootDir);
  const capabilityMatrix = await readJson(path.join(rootDir, 'manifests/capabilities.json'));
  const capabilityErrors = await validateCapabilityMatrix(rootDir, capabilityMatrix);
  const leaks = await scanForForbiddenTerms({
    forbiddenTerms,
    includeDirs: redactionDirs,
    rootDir,
  });

  return {
    capabilityErrors,
    leaks,
    missing: [...missing, ...installMapMissing].sort(),
    missingSkillInstalls,
    invalidSkillDirs,
    skillMetadataErrors,
    skillGraphErrors,
    governanceQualityErrors,
    ok: missing.length === 0
      && installMapMissing.length === 0
      && missingSkillInstalls.length === 0
      && invalidSkillDirs.length === 0
      && skillMetadataErrors.length === 0
      && skillGraphErrors.length === 0
      && governanceQualityErrors.length === 0
      && capabilityErrors.length === 0
      && leaks.length === 0
      && schemaErrors.length === 0,
    schemaErrors: schemaErrors.sort(),
  };
}
