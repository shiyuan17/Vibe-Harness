const defaultTemplateData = {
  governance: {
    mode: 'basic',
    workflow: 'strict',
  },
  hookRunnerPath: '.agents/cognis/hooks/codex-hook.mjs',
  installedSurface: {
    codebaseMemoryMcpLine: '',
    discoveryLine: '使用仓库搜索和已安装规则定位相关代码；需要结构化索引时先确认目标项目已有能力。',
    engineeringRulesLine: '',
    hooksLine: '',
    memorySkillsLine: '',
    operationalRulesLine: '',
    profileLine: '- 当前 profile 使用 Cognis Codex 安装面。',
    reviewLoopLine: '',
    rulesLine: '- 规则位于 `docs/rules/`。',
    skillRoutingLine: '',
    skillsLine: '',
    templatesLine: '- 模板位于 `docs/templates/`。',
    toolingLine: '',
  },
  packageManager: 'pnpm',
  projectProfile: {
    codingStandards: '未发现专用 lint/format 配置；沿用仓库现有代码风格并保持最小改动。',
    directoryGuidance: '未发现显式模块清单；按现有目录职责就近修改。',
    packageManager: 'pnpm',
    reviewGuidance: 'Review 必须核对目标项目事实、风险区、验证证据和未覆盖路径。',
    stackSummary: '未识别到主技术栈；以目标项目现有文件为准。',
    vcsStatusCommand: 'git status --short',
    vcsStatusInstruction: '编辑前运行 `git status --short`，保护用户未归属改动。',
    vcsSummary: '未识别 VCS',
    verificationSummary: '使用目标项目配置的验证命令，并补充聚焦测试或人工核对证据。',
  },
  projectName: 'target project',
  validationCommands: {
    governance: 'node .agents/cognis/governance/validate.mjs',
    lint: '未配置',
    typecheck: '未配置',
  },
};

export const managedInstructionBlockStart = '<!-- COGNIS:START -->';
export const managedInstructionBlockEnd = '<!-- COGNIS:END -->';
export const legacyManagedInstructionBlockStart = '<!-- LOOPENGINE:START -->';
export const legacyManagedInstructionBlockEnd = '<!-- LOOPENGINE:END -->';
export const managedAgentsBlockStart = managedInstructionBlockStart;
export const managedAgentsBlockEnd = managedInstructionBlockEnd;

const managedInstructionBlockPattern = /<!-- COGNIS:START -->[\s\S]*?<!-- COGNIS:END -->\n?/u;
const legacyManagedInstructionBlockPattern = /<!-- LOOPENGINE:START -->[\s\S]*?<!-- LOOPENGINE:END -->\n?/u;
const legacyAgentsMarkers = [
  '## 最小启动步骤',
  '## 五条红线',
  '## 核心位置',
  'docs/rules/quickstart.md',
  'docs/rules/agent-collaboration.md',
  'docs/workflows/',
];

function lookup(data, expression) {
  return expression.split('.').reduce((value, key) => {
    if (value && Object.hasOwn(value, key)) {
      return value[key];
    }
    return undefined;
  }, data);
}

export function withDefaultTemplateData(data = {}) {
  return {
    ...defaultTemplateData,
    ...data,
    governance: {
      ...defaultTemplateData.governance,
      ...(data.governance ?? {}),
    },
    installedSurface: {
      ...defaultTemplateData.installedSurface,
      ...(data.installedSurface ?? {}),
    },
    projectProfile: {
      ...defaultTemplateData.projectProfile,
      ...(data.projectProfile ?? {}),
    },
    validationCommands: {
      ...defaultTemplateData.validationCommands,
      ...(data.validationCommands ?? {}),
    },
  };
}

export function renderTemplate(template, data = {}) {
  const resolvedData = withDefaultTemplateData(data);
  return template.replaceAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/gu, (match, expression) => {
    const value = lookup(resolvedData, expression);
    if (value === undefined) {
      throw new Error(`Missing template variable: ${expression}`);
    }
    if (value === null) {
      return '未配置';
    }
    return String(value);
  });
}

export function hasIncompleteManagedInstructionBlock(content = '') {
  const canonicalIncomplete = content.includes(managedInstructionBlockStart) !== content.includes(managedInstructionBlockEnd);
  const legacyIncomplete = content.includes(legacyManagedInstructionBlockStart) !== content.includes(legacyManagedInstructionBlockEnd);
  return canonicalIncomplete || legacyIncomplete;
}

function managedInstructionMatch(content = '') {
  const canonical = content.match(managedInstructionBlockPattern);
  const legacy = content.match(legacyManagedInstructionBlockPattern);
  if (canonical && legacy) {
    throw Object.assign(new Error('Instruction file contains both Cognis and LoopEngine managed blocks.'), {
      code: 'COGNIS_MANAGED_BLOCK_CONFLICT',
    });
  }
  return canonical
    ? { end: managedInstructionBlockEnd, match: canonical, pattern: managedInstructionBlockPattern, start: managedInstructionBlockStart }
    : legacy
      ? { end: legacyManagedInstructionBlockEnd, match: legacy, pattern: legacyManagedInstructionBlockPattern, start: legacyManagedInstructionBlockStart }
      : null;
}

export function renderManagedInstructionBlock(content) {
  return `${managedInstructionBlockStart}\n${String(content).trimEnd()}\n${managedInstructionBlockEnd}\n`;
}

export function extractManagedInstructionBlock(content = '') {
  const found = managedInstructionMatch(content);
  return found ? renderManagedInstructionBlock(found.match[0]
    .replace(found.start, '')
    .replace(found.end, '')
    .trim()) : null;
}

export function removeManagedInstructionBlock(content = '') {
  if (hasIncompleteManagedInstructionBlock(content)) {
    throw new Error('Instruction file contains an incomplete Cognis managed block.');
  }
  const found = managedInstructionMatch(content);
  if (!found) return content;
  const { match } = found;
  const start = match.index > 0 && content[match.index - 1] === '\n' ? match.index - 1 : match.index;
  const remaining = `${content.slice(0, start)}${content.slice(match.index + match[0].length)}`.trimEnd();
  return remaining ? `${remaining}\n` : '';
}

function isLegacyLoopEngineAgentsContent(content = '') {
  const normalized = content.trim();
  if (!normalized || !/^# AGENTS\.md(?:\s|$)/u.test(normalized)) {
    return false;
  }
  const markerCount = legacyAgentsMarkers.filter((marker) => normalized.includes(marker)).length;
  return markerCount >= 3;
}

function stripLegacyLoopEngineAgentsContent(content = '') {
  const found = managedInstructionMatch(content);
  if (!found) {
    return isLegacyLoopEngineAgentsContent(content) ? '' : content;
  }
  const { match } = found;

  const legacyPrefix = content.slice(0, match.index);
  if (!isLegacyLoopEngineAgentsContent(legacyPrefix)) {
    return content;
  }

  return content.slice(match.index).replace(/^\s+/u, '');
}

export function mergeManagedInstructionBlock(existingContent, managedContent) {
  if (hasIncompleteManagedInstructionBlock(existingContent)) {
    throw new Error('Instruction file contains an incomplete Cognis managed block.');
  }

  const normalizedExistingContent = stripLegacyLoopEngineAgentsContent(existingContent);
  const managedBlock = renderManagedInstructionBlock(managedContent);
  if (!normalizedExistingContent || normalizedExistingContent.trim().length === 0) {
    return managedBlock;
  }

  const found = managedInstructionMatch(normalizedExistingContent);
  if (found) {
    return normalizedExistingContent.replace(found.pattern, managedBlock);
  }

  const separator = normalizedExistingContent.endsWith('\n')
    ? (normalizedExistingContent.endsWith('\n\n') ? '' : '\n')
    : '\n\n';
  return `${normalizedExistingContent}${separator}${managedBlock}`;
}

// Legacy names remain exported for schemaVersion 1 Codex integrations.
export const hasIncompleteManagedAgentsBlock = hasIncompleteManagedInstructionBlock;
export const renderManagedAgentsBlock = renderManagedInstructionBlock;
export const extractManagedAgentsBlock = extractManagedInstructionBlock;
export const removeManagedAgentsBlock = removeManagedInstructionBlock;
export const mergeManagedAgentsBlock = mergeManagedInstructionBlock;
