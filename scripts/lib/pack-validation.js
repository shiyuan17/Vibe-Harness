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
const redactionDirs = ['rules', 'templates', 'skills/core', 'skills/integrations', 'workflows', 'adapters/codex', 'manifests', 'schemas'];

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
      terms: ['必填', '禁止空泛', '验证命令'],
    },
    {
      file: 'templates/task-intake.md',
      terms: ['必填', '写入范围', '禁止动作'],
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
      terms: ['工作流档位', '安装配置'],
    },
    {
      file: 'rules/git-rules.md',
      terms: ['分支', '提交', 'PR'],
    },
    {
      file: 'rules/api-rules.md',
      terms: ['Checklist', '兼容策略', '验证证据'],
    },
    {
      file: 'rules/db-rules.md',
      terms: ['Checklist', '回滚路径', '验证证据'],
    },
    {
      file: 'rules/coding-rules.md',
      terms: ['Checklist', '依赖', '验证证据'],
    },
    {
      file: 'rules/frontend-rules.md',
      terms: ['Checklist', '浏览器', '验证证据'],
    },
    {
      file: 'rules/log-management.md',
      terms: ['Checklist', '关联 ID', '检索', '脱敏', '验证证据'],
    },
    {
      file: 'rules/release-rules.md',
      terms: ['Checklist', '回滚', '监控'],
    },
    {
      file: 'rules/troubleshooting.md',
      terms: ['Checklist', '最小复现', '验证证据'],
    },
    {
      file: 'schemas/task.schema.json',
      terms: ['writeScope', 'forbiddenActions', 'verification', 'rollbackPlan'],
    },
  ];

  const results = await Promise.all(checks.map((check) => checkRequiredTerms(rootDir, check)));
  return results.flat().sort();
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
  const governanceQualityErrors = await validateGovernanceQuality(rootDir);
  const leaks = await scanForForbiddenTerms({
    forbiddenTerms,
    includeDirs: redactionDirs,
    rootDir,
  });

  return {
    leaks,
    missing: [...missing, ...installMapMissing].sort(),
    missingSkillInstalls,
    invalidSkillDirs,
    skillMetadataErrors,
    governanceQualityErrors,
    ok: missing.length === 0
      && installMapMissing.length === 0
      && missingSkillInstalls.length === 0
      && invalidSkillDirs.length === 0
      && skillMetadataErrors.length === 0
      && governanceQualityErrors.length === 0
      && leaks.length === 0
      && schemaErrors.length === 0,
    schemaErrors: schemaErrors.sort(),
  };
}
