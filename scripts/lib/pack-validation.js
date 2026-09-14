import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

import {
  assertInsideDir,
  assertPortableRelativePath,
  loadAllManifests,
  loadAllManifestSchemas,
  pathExists,
  readPackJson,
  RED_ZONE_PATTERNS,
  validateAllManifestShapes,
  validateAllManifestSchemas,
  validateJsonAgainstSchema,
  validateInstallMapShape,
  validateManifestSources,
} from './manifest.js';
import { moduleCatalog } from './module-selection.js';
import { scanForForbiddenTerms } from './redaction.js';
import { canonicalAgentsTemplate, loadAdapterCatalog, resolveAdapterEntry, skillRootPrefixes } from './adapter.js';
import { validateDocumentation } from './docs-validation.js';
import { renderTemplate, withDefaultTemplateData } from './template-renderer.js';
import { loadRuleIndex, renderRulesLine } from './rules-index.js';
import { DEFAULT_RED_ZONE_PATHS } from '../../runtime/hooks/lib/context.mjs';
import { redZoneMatcher } from '../../runtime/hooks/lib/policy.mjs';
import { scanWorkflowAssets } from './workflow-assets.js';

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

const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/gu;

// String.match ignores the global flag's lastIndex state; RegExp.test does not.
function containsCjk(text) {
  return text.match(CJK_PATTERN) !== null;
}

// Host routing selects skills by matching the request text against the
// description, so a description that mixes English and Chinese prose halves the
// tokens either language can match. Embedded technical tokens (command names
// such as $git-deliver, tool names such as Playwright) are unavoidable; the
// check only fails when the minority script carries a meaningful share of the
// letters.
function hasMixedScriptDescription(description) {
  const cjkCount = (description.match(CJK_PATTERN) ?? []).length;
  const latinCount = (description.match(/[A-Za-z]/gu) ?? []).length;
  const total = cjkCount + latinCount;
  if (total === 0) return false;
  return Math.min(cjkCount, latinCount) / total > 0.25;
}

export async function validateSkillMetadataQuality(rootDir, skillItems) {
  const errors = [];
  const chineseScriptIds = [];
  const englishScriptIds = [];
  const names = new Map();
  const descriptions = new Map();
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
    if (frontmatter.name && !/^[a-z][a-z0-9-]{0,63}$/u.test(frontmatter.name)) {
      errors.push(item.id + ' frontmatter name must use lowercase letters, digits, and hyphens');
    }
    if (frontmatter.name && frontmatter.name !== path.basename(path.dirname(sourcePath))) {
      errors.push(item.id + ' frontmatter name must match skill directory name');
    }
    if (frontmatter.name) {
      const owner = names.get(frontmatter.name);
      if (owner && owner !== item.id) {
        errors.push('duplicate Skill name ' + frontmatter.name + ' in ' + owner + ' and ' + item.id);
      } else {
        names.set(frontmatter.name, item.id);
      }
    }
    if (!frontmatter.description) {
      errors.push(`${item.id} frontmatter description is required`);
    } else {
      const owner = descriptions.get(frontmatter.description);
      if (owner && owner !== item.id) {
        errors.push('duplicate Skill description in ' + owner + ' and ' + item.id);
      } else {
        descriptions.set(frontmatter.description, item.id);
      }
      if (frontmatter.description.length > 300) {
        errors.push(`${item.id} description must be 300 characters or fewer`);
      }
      if (hasWorkflowHeavyDescription(frontmatter.description)) {
        errors.push(`${item.id} description should describe triggers, not workflow steps`);
      }
      if (hasMixedScriptDescription(frontmatter.description)) {
        errors.push(`${item.id} description must use a single script (all English or all Chinese); embedded technical terms are acceptable`);
      }
      if (containsCjk(frontmatter.description)) {
        chineseScriptIds.push(item.id);
      } else {
        englishScriptIds.push(item.id);
      }
    }
  }
  // Same routing argument at pack level: a description set split across scripts
  // gives each request language an inconsistent surface to match against.
  if (chineseScriptIds.length > 0 && englishScriptIds.length > 0) {
    errors.push(
      `skill descriptions must share one script across the pack; Chinese: ${chineseScriptIds.join(', ')}; English: ${englishScriptIds.join(', ')}`,
    );
  }
  return errors.sort();
}

export async function validateSkillGraph(
  rootDir,
  skillItems,
  profiles,
  { checkFiles = true, installEntries = [] } = {},
) {
  const errors = [];
  const itemsById = new Map(skillItems.map((item) => [item.id, item]));
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
    if (item.canonicalId) {
      errors.push(`${item.id} may not declare canonicalId for kind ${item.kind}`);
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
      const maxLines = item.kind === 'native' ? 50 : 160;
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
          for (const term of ['interface:', 'display_name:', 'short_description:', 'default_prompt:', 'policy:', 'allow_implicit_invocation:']) {
            if (!yaml.includes(term)) errors.push(`${item.id} agents/openai.yaml must contain ${term}`);
          }
          if (!/allow_implicit_invocation:\s+(?:true|false)/u.test(yaml)) errors.push(item.id + ' agents/openai.yaml allow_implicit_invocation must be boolean');
        }
        const assets = await readdir(skillDir, { withFileTypes: true });
        const resourceCount = assets.filter((entry) => !['SKILL.md', 'metadata.json', 'agents'].includes(entry.name)).length;
        if (resourceCount > 2) errors.push(`${item.id} may contain at most two on-demand resources`);
      }
      if (!(await pathExists(path.join(rootDir, item.metadata)))) {
        errors.push(`${item.id} metadata is missing: ${item.metadata}`);
      } else {
        const metadata = await readPackJson(path.join(rootDir, item.metadata));
        for (const forbidden of ['name', 'description']) {
          if (Object.hasOwn(metadata, forbidden)) {
            errors.push(item.id + ' metadata must not define ' + forbidden + '; use SKILL.md frontmatter');
          }
        }
        if (Object.hasOwn(metadata, 'entry') && metadata.entry !== 'SKILL.md') {
          errors.push(item.id + ' metadata entry must be SKILL.md when provided');
        }
        if (metadata.id !== item.id) errors.push(`${item.id} metadata id must match manifest id`);
      }
    } else if (!checkFiles) {
      if ((item.optionalSkills?.length ?? 0) > 0) errors.push(`${item.id} must document fallback for optional skills`);
      if ((item.requiresTools?.length ?? 0) > 0) errors.push(`${item.id} must document fallback for tools`);
    }
  }

  if (nativeBodyLines > 300) errors.push(`native Skill body budget exceeds 300 lines: ${nativeBodyLines}`);
  // The identity budget keeps the always-loaded routing surface compact. It is
  // calibrated for the English-description era (2026-09 unification): 1300
  // characters is roughly 330 tokens at 4 bytes/token, still well under the
  // Chinese-era 1100-character surface that weighed in near 625 tokens because
  // CJK characters carry ~3 bytes and ~1 token each.
  if (nativeIdentityCharacters > 1500) errors.push(`native Skill name and description budget exceeds 1500 characters: ${nativeIdentityCharacters}`);

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

/**
 * Wording anchors shared by more than one governed document.
 *
 * Several rule files, templates, or adapter instruction files must state the
 * same convention in the same words. Defining the phrase once here keeps that
 * convention a single edit instead of one edit per file; every consuming entry
 * below references the constant rather than repeating the text.
 */
export const SHARED_RULE_PHRASES = Object.freeze({
  optionalToolActivation: '本规则仅在',
  degradedEvidence: '验证受阻（degraded）',
  evidenceVerdictBoundary: '推断产品通过或失败',
  referenceImplementation: '参考实现',
  taskDagNotParsed: '不由 Vibe-Harness 解析',
  testScopeReference: '测试范围细则',
  gitFlowDefault: 'feat/*、fix/* → develop → main',
  gitFlowHotfix: 'hotfix/* → main → develop',
  developNoRemoteCi: '不要求远端 CI',
  releaseOnlyCiBoundary: '只在发布边界',
  releaseGateBranches: '`main`、`release/*`',
  prohibitedAutoClaimMechanisms: 'Webhook 调度器、Linear Loop、leader lease、自动超时回收或自动重派',
  noAssertionWeakening: '降低断言、删除断言或无理由跳过相关测试绕过',
});

/**
 * The declared wording contract for rule, template, and adapter prose.
 *
 * These files are prose, so "this clause is still stated" can only be checked
 * by matching text. Declaring the matches here keeps that contract in one owned
 * table: rewording a rule is one edit, and `pnpm validate` reports the missing
 * anchor by file and phrase instead of an anonymous regex diff somewhere in a
 * test file. A previous revision spread roughly 210 sentence-level regexes
 * across three test files, so a single rewording had to be located and repeated
 * per assertion, and a legitimate editorial change looked like a rule
 * regression.
 *
 * Each anchor is the shortest phrase that still carries the normative meaning —
 * a modal verb, an enumeration, a field set, or a distinctive label — rather
 * than a whole sentence, so ordinary paraphrase does not break it. Contracts
 * that are genuinely structural (section order, enum membership, absence of
 * forbidden content) stay in tests and read the shared enums exported by the
 * modules that already own them.
 */
export const CONTENT_QUALITY_CHECKS = [
  {
    file: 'docs/rules/governance-core.md',
    terms: [
      // 默认循环与事实充分性
      '获取可信事实 → 判定并执行 → 聚焦验证 → 简洁交付',
      '事实充分性与歧义路由',
      '证据强度匹配行动风险',
      '不要求机械双来源',
      '不得任意择一',
      '可发现事实继续只读探索',
      '阻塞产品决定',
      '每轮最多三个',
      '明确授权',
      '最小可逆默认值',
      '清晰、已授权、证据充分',
      '任务 Markdown 是可选的人读记录',
      '按实际依赖、写入隔离和独立并行收益',
      '不按信号数量或公共契约变化强制拆分',
      '宿主 Plan 模式保持只读',
      // 风险档位
      '快速',
      '轻量',
      '完整',
      // 验证范围与证据标签
        '验证范围必须与完成主张匹配',
        '先按变更类型选择项目已定义的聚焦检查',
        SHARED_RULE_PHRASES.noAssertionWeakening,
        '最后一次实质修改后的状态重跑同一检查',
      '覆盖同一受影响行为的等价检查及理由',
      'handoff 只引用晚于最后一次实质修改的结果',
      '已确认事实',
      '静态结论',
      '待验证假设',
      '验证受阻',
      SHARED_RULE_PHRASES.evidenceVerdictBoundary,
      '不形成机器状态、完成门禁或固定交付格式',
      // 硬边界与批准恢复
        '不得声称完成',
        '同一目标、对象、操作和风险范围',
        '密码、Secret、Token、Cookie、验证码、认证头、会话标识和个人敏感数据',
      '不得进入回复、日志、错误、快照、Eval、任务记录或持久记忆',
      '授权持续有效，不重复确认',
      '不得以准备为名执行待批准动作',
      '必要验证受阻时报告具体缺口',
      '一个内部步骤完成不等于整个请求完成',
      // 任务与协作
      '两个以上协作单元',
      '轻量 Task DAG',
      '简单任务不创建 DAG',
      'ready 节点',
      'fan-in 后重新读取实际工作区与 diff',
    ],
  },
  {
    file: 'templates/task.md',
    terms: [
      '可选的人读记录',
      '档位',
      '状态',
      '目标',
      '验收',
      '下一步',
      '验证',
      '风险',
      '技术栈',
      '目录结构',
      '业务流',
      '数据流',
      '模块依赖',
      '仅显式要求或影响范围无法缩小时填写',
      '实施任务拆分（仅判定为拆分时填写）',
      '协作图（仅使用协作时填写）',
      '执行判定',
      '不由 Vibe-Harness 解析或作为完成门禁',
    ],
  },
  {
    file: 'templates/task.en-US.md',
    terms: [
      'only when explicitly requested or impact cannot be narrowed',
      'Implementation task split (complete only when the plan is split)',
      'Collaboration Graph (complete only when collaborating)',
      'Execution disposition',
      'does not parse it or use it as a completion gate',
    ],
  },
  {
    file: 'templates/delivery.md',
    terms: ['结果', '实际变更', '本轮验证', '未验证项', '风险', '后续动作'],
  },
  {
    file: 'docs/rules/agent-skill-routing.md',
    terms: [
      'description',
      '不使用 Router',
      '领域 Skill',
      '人工确认',
      // Routing surface: only name and description are preloaded, so both the
      // third-person trigger wording and the negative boundary stay normative.
      '第三人称',
      '不适用边界',
      // Progressive disclosure keeps SKILL.md an entry point, not a transcript.
      '渐进披露',
      '按需读取',
    ],
  },
  {
    file: 'docs/rules/test-rules.md',
    terms: [
      '验收矩阵',
      '退出码',
      '未验证项',
      '对抗式',
      '测试类型',
      SHARED_RULE_PHRASES.referenceImplementation,
      // 验证范围与 degraded 判定
      '普通对话 / 只读诊断',
      '全量测试不是默认验证',
      SHARED_RULE_PHRASES.degradedEvidence,
      SHARED_RULE_PHRASES.evidenceVerdictBoundary,
        SHARED_RULE_PHRASES.noAssertionWeakening,
        '覆盖率是诊断信号不是目标',
        // 工程约定
        '先写暴露该缺陷的复现测试',
        'flaky 测试须隔离并限期修复，不以重跑掩盖',
      '断言行为而非实现细节',
      '仅测试使用的辅助路径',
      '项目已配置且对本次文件或语言适用时',
      '无法隔离时才串行',
      '不是目标项目通用门禁',
      // 测试与 Eval 边界
      '契约重放（contract-replay）',
      '审计与运行时测试',
      '更新须单独审查显式确认',
    ],
  },
  {
    file: 'docs/rules/ai-collab-rules.md',
    terms: [
      '单 Agent',
      '授权与批准',
      '验证与主张匹配',
      '保护现有工作区',
      // 默认方式
      '仅在实际使用两个以上协作单元时生效',
      '单 Agent、简单顺序任务和纯对话不创建 DAG',
      SHARED_RULE_PHRASES.taskDagNotParsed,
      '也不形成固定完成门禁',
      // 轻量 Task DAG 与状态解释
      'all_success',
      'all_done',
      '不得把失败图改判为成功',
      '这四种状态不是终态',
      'all_done 不得把仍 blocked 的节点视为已终结',
      '唯一节点负责写入',
      '已隔离的独立写节点仍可派发',
      'Windows 路径比较忽略大小写',
      '路径不重叠但存在接口、Schema、迁移或行为契约耦合',
      '两个消费方读取同一已稳定契约并不等于两个共享契约写入者',
      // 重验证、重试与交接
      '每次派发 write 节点前重新确认 DAG 版本或 hash',
      '子 Agent 交接至少报告节点结果',
      '最后一次实质写入后运行集成验证',
      '最多尝试三次',
      'Retry-After',
      '权限和安全拒绝不得重试绕过',
      '确定性测试失败先修复再验证',
      '未提交写入也会改变输入',
      '不要求 HEAD 永远等于 initial HEAD',
      '先只读补证或请原节点补充',
      '不得伪造退出码',
      '记为 blocked',
      '实际 running 的读写节点',
    ],
  },
  {
    file: 'docs/rules/linear-workflow.md',
    terms: [
      // 1 授权模型
      '禁止自动领取',
      '不得扫描、轮询、订阅或从 Ready Queue 选择 Issue',
      SHARED_RULE_PHRASES.prohibitedAutoClaimMechanisms,
      '用户在本轮明确要求',
      '显式启动',
      '不授权登记或执行',
      '人类 Assignee',
      'Linear Delegate/App User',
      'Execution Receipt',
      'Activity Feed',
      '保留人类 Assignee',
      'agent:<agent-key> 与 role:writer',
      'Reviewer 和 Verifier 只读，不写 Receipt',
      // 2 状态与 GitFlow
      'Ready to Merge',
      '仅对带门禁',
      SHARED_RULE_PHRASES.gitFlowDefault,
      SHARED_RULE_PHRASES.gitFlowHotfix,
      SHARED_RULE_PHRASES.developNoRemoteCi,
      '只对发布边界运行',
      SHARED_RULE_PHRASES.releaseGateBranches,
      'main-release-gate',
      '自行落地 squash merge',
      // 3 Definition of Ready
      '以 `ai-collab-rules.md` 为唯一规范来源',
      '统一遵循 `ai-collab-rules.md`',
      'Dependencies 只能是 None 或 Managed by Linear relations',
      '描述中的明确依赖陈述必须与原生关系一致',
      '不 Ready',
      '自依赖、任意依赖环、不可见前驱、关系读取不完整',
      // 4 原生 DAG 投影
      'Parent/Sub-issue 只表示分解，不隐含顺序',
      'blocked-by / blocks 是唯一执行依赖',
      'related 不进入 DAG',
      'Canceled、Duplicate、Won\'t Fix',
      '不能把失败 DAG 或 Root 判为成功',
      'Scope 是 writeScope 的 Linear 投影',
      '拒绝绝对路径、UNC、空路径、..',
      'Windows 比较忽略大小写',
      'Scope 重叠或 resourceLocks 相同',
      '不自行拆 Issue、改变 Parent、创建或删除关系',
      '关闭 Linear 的 Parent/Sub-issue 自动关闭',
      'Fan-in Verification',
      'Parent 不得 Done',
      'write 叶子由 closing PR/MR 合并',
      'read 叶子由约定输出和 Verification 证据',
      'aggregate Parent',
      // 5 显式执行登记（Receipt 生命周期）
      'vibe-harness.linear-execution/v1',
      '原 Receipt 不得编辑',
      'released、aborted、handed-off、local-work-completed',
      '同一 Issue 最多一个 active execution',
      '结果不确定时先重读',
      '幂等成功',
      '用户名、主机名、本地路径、Token、Cookie、会话凭据或个人敏感数据',
      '不得声称已登记领取',
      'write 叶子 Issue 对应一个 Writer',
      '不要求实现 worktree、分支或 PR/MR',
      // 6 Git、状态同步与安全（含快车道）
      '无 Parent、Dependencies=None 且 resourceLocks=None',
      '不得为此执行全项目 DAG 遍历',
      '当前 Issue 及其必要依赖范围',
      '顺序执行且工作区干净时允许在当前 clone 创建任务分支',
      '必须使用仓库外 worktree',
    ],
  },
  {
    file: 'docs/rules/project-directory.md',
    terms: [
      '发现顺序',
      '放置规则',
      '跨边界变更',
      '小型 Bug、单文件修改和简单问答不展开该清单',
      '长期有效、高影响且难以逆转',
      '不为普通修复、局部重命名、可逆实现选择或短期实验新建 ADR 体系',
    ],
  },
  {
    file: 'docs/rules/git-rules.md',
    terms: [
      '分支',
      '提交',
      'PR',
      SHARED_RULE_PHRASES.referenceImplementation,
      '普通单 Agent 局部修复不因任务类型自动创建 worktree',
    ],
  },
  {
    file: 'docs/rules/ast-grep.md',
    terms: [SHARED_RULE_PHRASES.optionalToolActivation, '插件或项目内等价工具已存在时生效'],
  },
  {
    file: 'docs/rules/chrome-devtools-mcp.md',
    terms: [SHARED_RULE_PHRASES.optionalToolActivation, '插件或工具已存在时生效'],
  },
  {
    file: 'docs/rules/codebase-memory-mcp.md',
    terms: [
      SHARED_RULE_PHRASES.optionalToolActivation,
      '已存在且当前任务需要其结构化能力时生效',
      '只有显式选择 `--plugin codebase-memory-mcp`',
      '未选择插件时不得假设工具存在',
    ],
  },
  {
    file: 'docs/rules/rtk.md',
    terms: [SHARED_RULE_PHRASES.optionalToolActivation, 'RTK 插件或工具已存在时生效'],
  },
  {
    file: 'docs/rules/api-rules.md',
    terms: ['检查清单', '兼容策略', '验证证据'],
  },
  {
    file: 'docs/rules/db-rules.md',
    terms: ['检查清单', '回滚路径', '验证证据'],
  },
  {
    file: 'docs/rules/coding-rules.md',
    terms: ['检查清单', '依赖', '验证证据', '先缩小改动范围'],
  },
  {
    file: 'docs/rules/frontend-rules.md',
    terms: [
      '检查清单',
      '浏览器',
      '验证证据',
      '用户输入和其他不可信内容不得直接注入 HTML',
      '破坏性操作必须要求确认或提供可恢复',
      '导航使用链接语义，操作使用按钮语义',
      '令牌体系或完整浏览器矩阵缺失不阻塞',
    ],
  },
  {
    file: 'docs/rules/log-management.md',
    terms: [
      '目标与边界',
      '最小字段与关联',
      '指标与追踪底线',
      '安全与可靠性',
      '排障与验收',
      '日志画像',
      '候选证据',
      '不引入新日志库',
      '高基数',
      '脱敏',
      '验证证据',
      '必须说明消费目的',
      '公共字段包含时间、级别',
      '`traceId` 和 `spanId`',
      '不能替代 trace context',
      '结果指标必须同时提供总量',
      '延迟使用分布并区分成功与失败',
      '用户 ID、请求 ID、邮箱、完整 URL',
      '校验、限长、编码和脱敏',
      'CR/LF',
      '不得阻塞核心业务',
      '.vibe-harness/log/',
      '.vibe-harness/artifacts/',
      '实际查询条件和验证证据',
      '候选证据不能直接当作运行事实',
      '不编造生产位置',
      '不代表目标应用日志目录',
      '不替代目标项目的日志或遥测契约',
    ],
  },
  {
    file: 'docs/rules/release-rules.md',
    terms: ['检查清单', '回滚', '监控'],
  },
  {
    file: 'docs/rules/troubleshooting.md',
    terms: [
      '检查清单',
      '最小复现',
      '验证证据',
      SHARED_RULE_PHRASES.degradedEvidence,
      '失败阶段、替代证据、未验证行为和剩余风险',
      '不得把“本地未复现”当作问题不存在或自动停止',
      '需要产品决策、额外权限或生产访问',
    ],
  },
  {
    file: 'skills/core/clarify-requirements/SKILL.md',
    terms: ['安全审批', '阻塞产品决定', '可逆实现选择', '最多三个', '推荐项', '回答关闭分支后立即继续'],
  },
  {
    file: 'skills/core/define-goal/SKILL.md',
    terms: ['4000', '执行型', '探索型', '明确要求激活', '不得静默替换', '不扩大授权'],
  },
  {
    file: 'adapters/antigravity/RULES.template.md',
    terms: ['编辑前先检查项目状态', '红区', '人工确认', '验证结果'],
  },
  {
    file: 'adapters/codex/AGENTS.template.md',
    terms: [SHARED_RULE_PHRASES.testScopeReference],
  },
  {
    file: 'adapters/claude/CLAUDE.template.md',
    terms: [SHARED_RULE_PHRASES.testScopeReference],
  },
  {
    file: 'adapters/gemini/GEMINI.template.md',
    terms: [SHARED_RULE_PHRASES.testScopeReference],
  },
    {
      file: 'skills/integrations/linear-workflow/SKILL.md',
      terms: [
        '不自动从队列领单',
        '未指定 Issue 时不得选择、认领或更新任务',
        SHARED_RULE_PHRASES.prohibitedAutoClaimMechanisms,
        '远端 CI 只在发布边界',
        SHARED_RULE_PHRASES.gitFlowDefault,
        SHARED_RULE_PHRASES.gitFlowHotfix,
        SHARED_RULE_PHRASES.developNoRemoteCi,
      ],
    },
    {
      file: 'skills/integrations/linear-workflow/references/ai-coding-task.md',
      terms: [
        'Target branch (exact remote ref): origin/develop',
        'Contract: None',
        'Dependencies: None',
        'resourceLocks: None',
      ],
    },
    {
      file: 'skills/integrations/linear-workflow/references/release-issue.md',
      terms: ['kind: aggregate', 'GitHub Release', 'Refs &lt;ISSUE-ID&gt;'],
    },
  {
    file: 'skills/integrations/linear-workflow/references/workspace-setup.md',
    terms: [
      SHARED_RULE_PHRASES.gitFlowDefault,
      SHARED_RULE_PHRASES.gitFlowHotfix,
      SHARED_RULE_PHRASES.developNoRemoteCi,
      SHARED_RULE_PHRASES.releaseOnlyCiBoundary,
    ],
  },
];

/**
 * Return the declared wording anchors for one governed file.
 *
 * @param {string} file repository-relative path
 */
export function contentQualityCheck(file) {
  const check = CONTENT_QUALITY_CHECKS.find((item) => item.file === file);
  if (!check) throw new Error(`no content-quality contract declared for ${file}`);
  return check;
}

export async function validateContentQuality(rootDir) {
  const results = await Promise.all(CONTENT_QUALITY_CHECKS.map((check) => checkRequiredTerms(rootDir, check)));
  const errors = results.flat();
  const agentsPath = path.join(rootDir, 'AGENTS.md');
  if (await pathExists(agentsPath)) {
    const agents = await readFile(agentsPath, 'utf8');
    if (!/--project[^\n]*--write/u.test(agents)) errors.push('AGENTS.md must document the --project/--write lifecycle');
    if (/pnpm vibe-harness[^\n]*(?:codex-internal|codex-minimal|--apply)/u.test(agents)) errors.push('AGENTS.md must not contain removed legacy lifecycle commands');
  }
  const [agentsTemplate, governanceCore] = await Promise.all([
    readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/rules/governance-core.md'), 'utf8'),
  ]);
  const residentLines = `${agentsTemplate}\n${governanceCore}`.split(/\r?\n/u).length;
  // Budget history: 89-90 lines across all prior revisions; the 2026-09 split of the
  // 1000+-character judgment paragraph into labeled sub-bullets added 2 structural
  // lines with zero content growth. The gate measures resident context size, and
  // blank/structural lines split prose into the same readable units the budget exists
  // to protect, so the allowance rises with them instead of forcing prose re-merging.
  // 2026-09-11: raised 92 -> 150 so rule typography (sections, lists, tables) is not
  // forced back into dense prose; the budget is a ceiling, not a target, and the
  // resident files are expected to stay well below it.
  if (residentLines > 150) errors.push(`resident governance surface exceeds 150 lines: ${residentLines}`);

  const proseOwners = new Map();
  for (const directory of ['docs/rules', 'templates']) {
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
      readPackJson(path.join(rootDir, 'manifests/profiles.json')),
      readPackJson(path.join(rootDir, 'docs/catalog.json')),
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

// Vibe-Harness render placeholders take the form {{name}} or {{name.field}}. Sources
// containing them are rendered at install time, so the installed artifact is
// not expected to be byte-identical to the source and is excluded from the
// self-install drift check.
const renderPlaceholderPattern = /\{\{[a-zA-Z][\w]*(?:\.[\w]+)*\}\}/u;

function normalizeLineEndings(value) {
  return value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

// Vibe-Harness installs into its own repository to dogfood the installer. For
// `replace` entries whose source carries no render placeholders, the
// self-installed artifact must stay byte-identical (modulo line endings) to
// the source. This catches drift such as a schema gaining a field in `schemas/`
// but the rendered copy in `docs/schemas/` not being regenerated.
//
// Project-owned seeds are excluded by design because no content comparison
// against their template can hold: they are written once and then edited inside
// the project. Their existence is still checked.
export async function validateSelfInstalledArtifacts(rootDir, adapters, installMaps, { requiredGroups = null } = {}) {
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
    let targetContent;
    try {
      targetContent = await readFile(targetPath, 'utf8');
    } catch {
      if (requiredGroups === null || requiredGroups.has(rawEntry.group)) {
        errors.push('self-installed artifact is missing: ' + entry.source + ' -> ' + entry.target);
      }
      continue;
    }
    if (rawEntry.projectOwned) continue;
    if (renderPlaceholderPattern.test(sourceContent)) continue;
    if (normalizeLineEndings(sourceContent) !== normalizeLineEndings(targetContent)) {
      errors.push(`self-installed artifact drifted from source: ${entry.source} -> ${entry.target}`);
    }
  }
  return errors.sort();
}

// Instruction-content budget gate. Codex silently truncates AGENTS.md at 32 KiB
// (`project_doc_max_bytes`); frontier models reliably follow ~150-200 instructions.
// We estimate tokens at 4 bytes/token (matching ai-context-kit's heuristic) and warn
// before the content approaches the truncation line. This runs at the pack layer over
// every adapter's instruction template, covering antigravity and opencode which the
// line-budget test (codex/claude/gemini only) does not reach.
const TOKEN_WARNING_THRESHOLD = 2000;
const TOKEN_ERROR_THRESHOLD = 5000;
const CODEX_TRUNCATION_BYTES = 32 * 1024;
const CODEX_TRUNCATION_WARN_BYTES = Math.round(CODEX_TRUNCATION_BYTES * 0.87);

export async function validateInstructionBudget(rootDir) {
  const errors = [];
  const warnings = [];
  const catalog = await loadAdapterCatalog(rootDir);
  // Measure the resident instructions the hosts actually receive: the installed
  // surface carries the rule index, so the budget must include it.
  const renderData = withDefaultTemplateData({ installedSurface: { rulesLine: renderRulesLine(await loadRuleIndex(rootDir)) } });
  for (const adapter of catalog.items) {
    const templateSource = adapter.instructionTarget === 'AGENTS.md'
      ? canonicalAgentsTemplate
      : `adapters/${adapter.id}/${adapter.instructionTemplate}.template.md`;
    let template;
    try {
      template = await readFile(path.join(rootDir, templateSource), 'utf8');
    } catch {
      // Missing sources are already reported by install-map source checks.
      continue;
    }
    const rendered = renderTemplate(template, renderData);
    const byteCount = Buffer.byteLength(rendered, 'utf8');
    const tokenEstimate = Math.ceil(byteCount / 4);
    const label = `${adapter.id}:${adapter.instructionTarget}`;
    if (tokenEstimate > TOKEN_ERROR_THRESHOLD) {
      errors.push(`${label} instruction content exceeds ${TOKEN_ERROR_THRESHOLD} token budget (~${tokenEstimate} tokens, ${byteCount} bytes)`);
    } else if (tokenEstimate > TOKEN_WARNING_THRESHOLD) {
      warnings.push(`${label} instruction content exceeds ${TOKEN_WARNING_THRESHOLD} token warning threshold (~${tokenEstimate} tokens, ${byteCount} bytes)`);
    }
    if (byteCount > CODEX_TRUNCATION_WARN_BYTES && byteCount <= CODEX_TRUNCATION_BYTES) {
      warnings.push(`${label} instruction content (${byteCount} bytes) approaches Codex 32 KiB silent truncation`);
    }
    if (byteCount > CODEX_TRUNCATION_BYTES) {
      errors.push(`${label} instruction content (${byteCount} bytes) exceeds Codex 32 KiB truncation limit`);
    }
  }
  return { errors: errors.sort(), warnings: warnings.sort() };
}

// Cross-validates the three red-zone lists so they cannot drift apart again:
// the runtime hook's DEFAULT_RED_ZONE_PATHS (runtime write gate), the adapter
// catalog's redZonePrefixes (per-adapter install-time classification of
// adapter-owned config files), and RED_ZONE_PATTERNS (install-map shape
// validation). Three directions are checked:
//   1. Every install target the runtime hook treats as red-zone must be
//      classified red-zone at install time (static flag or adapter prefix) so
//      --confirm-red-zone gates it.
//   2. Every runtime red-zone path must be gated by at least one install-time
//      mechanism (RED_ZONE_PATTERNS or some adapter's redZonePrefixes).
//   3. Every RED_ZONE_PATTERNS entry must match at least one runtime red-zone
//      path or adapter prefix, so the regex cannot accumulate dead over-broad
//      entries (this replaces the .gemini/ skill-content drift).
// The redZonePaths/redZonePatterns options exist so tests can inject mutated
// lists; production callers rely on the real runtime/manifest values.
export function validateRedZoneConsistency(adapters, installMap, { redZonePaths = DEFAULT_RED_ZONE_PATHS, redZonePatterns = RED_ZONE_PATTERNS } = {}) {
  const errors = [];
  const runtimeMatcher = redZoneMatcher(redZonePaths);
  const allPrefixes = [...new Set(adapters.flatMap((adapter) => adapter.redZonePrefixes ?? []))];

  for (const adapter of adapters) {
    const entries = [
      ...installMap.entries,
      ...(installMap.retiredEntries ?? []),
    ].map((entry) => resolveAdapterEntry(adapter, entry)).filter(Boolean);
    for (const entry of entries) {
      if (runtimeMatcher?.test(entry.target) && entry.redZone !== true) {
        errors.push(`${adapter.id} install target is a runtime red-zone path but not red-zone gated: ${entry.target}`);
      }
    }
    const configTargets = [];
    for (const kind of ['hooks', 'mcp']) {
      const config = adapter.projectConfig?.[kind];
      if (config) configTargets.push(config.target, ...(config.alternateTargets ?? []));
    }
    for (const rawTarget of configTargets) {
      const target = rawTarget.replaceAll('\\', '/');
      const gated = (adapter.redZonePrefixes ?? []).some((prefix) => target.startsWith(prefix.replaceAll('\\', '/')));
      if (runtimeMatcher?.test(target) && !gated) {
        errors.push(`${adapter.id} adapter config target is a runtime red-zone path but not covered by redZonePrefixes: ${target}`);
      }
    }
  }

  for (const redZonePath of redZonePaths) {
    const gatedByPattern = redZonePatterns.some((pattern) => pattern.test(redZonePath.replaceAll('\\', '/')));
    const gatedByPrefix = allPrefixes.some((prefix) => redZonePath.startsWith(prefix.replaceAll('\\', '/')));
    if (!gatedByPattern && !gatedByPrefix) {
      errors.push(`runtime red-zone path is not gated at install time (missing from RED_ZONE_PATTERNS and all redZonePrefixes): ${redZonePath}`);
    }
  }

  const knownPaths = [...redZonePaths, ...allPrefixes];
  for (const pattern of redZonePatterns) {
    if (!knownPaths.some((candidate) => pattern.test(candidate.replaceAll('\\', '/')))) {
      errors.push(`RED_ZONE_PATTERNS entry covers no runtime red-zone path or adapter prefix: ${pattern}`);
    }
  }

  return [...new Set(errors)].sort();
}

export async function validatePack(rootDir) {
  const manifests = await loadAllManifests(rootDir);
  const schemas = await loadAllManifestSchemas(rootDir);
  const installMapSchema = await readPackJson(path.join(rootDir, 'schemas/install-map.schema.json'));
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
      installMap = await readPackJson(path.join(rootDir, adapter.installMap));
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
  const capabilityMatrix = await readPackJson(path.join(rootDir, 'manifests/capabilities.json'));
  const capabilityErrors = await validateCapabilityMatrix(rootDir, capabilityMatrix);
  const leaks = await scanForForbiddenTerms({
    forbiddenTerms,
    includeDirs: redactionDirs,
    rootDir,
  });
  const documentation = await validateDocumentation({ rootDir });
  const fullProfileGroups = new Set(manifests.profiles.items.find((item) => item.id === 'full')?.groups ?? []);
  const selfInstallErrors = await validateSelfInstalledArtifacts(rootDir, manifests.adapters, installMaps, {
    requiredGroups: fullProfileGroups,
  });
  const instructionBudget = await validateInstructionBudget(rootDir);
  // One shared install map may serve several adapters; validate each unique
  // map once and merge the errors.
  const redZoneConsistencyErrors = [...new Set(
    [...installMaps.values()].flatMap((installMap) => validateRedZoneConsistency(manifests.adapters.items, installMap)),
  )].sort();
  const workflowScan = await scanWorkflowAssets(rootDir);

  return {
    capabilityErrors,
    contentQualityErrors,
    instructionBudgetErrors: instructionBudget.errors,
    instructionBudgetWarnings: instructionBudget.warnings,
    leaks,
    missing: [...missing, ...installMapMissing].sort(),
    missingSkillInstalls,
    invalidSkillDirs,
    redZoneConsistencyErrors,
    skillMetadataErrors,
    skillGraphErrors,
    documentationErrors: documentation.errors,
    documentationWarnings: documentation.warnings,
    selfInstallErrors,
    workflowScan,
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
      && selfInstallErrors.length === 0
      && instructionBudget.errors.length === 0
      && workflowScan.findings.length === 0
      && redZoneConsistencyErrors.length === 0,
    schemaErrors: schemaErrors.sort(),
  };
}
