const defaultTemplateData = {
  codebaseMemoryStateDirectory: '.cognis',
  hookRunnerPath: '.agents/runtime/hooks/codex-hook.mjs',
  installedSurface: {
    clarificationPostureLine: '',
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
    reviewGuidance: '按风险与改动范围选择验证方式，并明确未覆盖路径。',
    stackSummary: '未识别到主技术栈；以目标项目现有文件为准。',
    vcsStatusCommand: 'git status --short',
    vcsStatusInstruction: '编辑前运行 `git status --short`，保护用户未归属改动。',
    vcsSummary: '未识别 VCS',
    verificationSummary: '使用目标项目配置的验证命令，并补充聚焦测试或人工核对证据。',
  },
  projectName: 'target project',
  validationCommands: {
    lint: '未配置',
    typecheck: '未配置',
    test: '未配置',
    eval: '未配置',
  },
};

export const managedInstructionBlockStart = '<!-- COGNIS:START -->';
export const managedInstructionBlockEnd = '<!-- COGNIS:END -->';

const managedInstructionBlockPattern = /<!-- COGNIS:START -->[\s\S]*?<!-- COGNIS:END -->\n?/u;

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
  return content.includes(managedInstructionBlockStart) !== content.includes(managedInstructionBlockEnd);
}

function managedInstructionMatch(content = '') {
  const canonical = content.match(managedInstructionBlockPattern);
  return canonical
    ? { end: managedInstructionBlockEnd, match: canonical, pattern: managedInstructionBlockPattern, start: managedInstructionBlockStart }
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

export function mergeManagedInstructionBlock(existingContent, managedContent) {
  if (hasIncompleteManagedInstructionBlock(existingContent)) {
    throw new Error('Instruction file contains an incomplete Cognis managed block.');
  }

  const managedBlock = renderManagedInstructionBlock(managedContent);
  if (!existingContent || existingContent.trim().length === 0) {
    return managedBlock;
  }

  const found = managedInstructionMatch(existingContent);
  if (found) {
    return existingContent.replace(found.pattern, managedBlock);
  }

  const separator = existingContent.endsWith('\n')
    ? (existingContent.endsWith('\n\n') ? '' : '\n')
    : '\n\n';
  return `${existingContent}${separator}${managedBlock}`;
}
