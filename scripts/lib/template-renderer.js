const defaultTemplateData = {
  installedSurface: {
    codebaseMemoryMcpLine: '',
    engineeringRulesLine: '',
    hooksLine: '',
    memorySkillsLine: '',
    operationalRulesLine: '',
    profileLine: '- 当前 profile 使用 LoopEngine Codex 安装面。',
    reviewLoopLine: '',
    rulesLine: '- 规则位于 `docs/rules/`。',
    skillRoutingLine: '',
    skillsLine: '',
    templatesLine: '- 模板位于 `docs/templates/`。',
  },
  packageManager: 'pnpm',
  projectProfile: {
    codingStandards: '未发现专用 lint/format 配置；沿用仓库现有代码风格并保持最小改动。',
    directoryGuidance: '未发现显式模块清单；按现有目录职责就近修改。',
    packageManager: 'pnpm',
    reviewGuidance: 'Review 必须核对目标项目事实、风险区、验证证据和未覆盖路径。',
    stackSummary: '未识别到主技术栈；以目标项目现有文件为准。',
    vcsStatusCommand: 'git status --short',
    vcsSummary: '未识别 VCS',
    verificationSummary: '使用目标项目配置的验证命令，并补充聚焦测试或人工核对证据。',
  },
  projectName: 'target project',
  validationCommands: {
    governance: 'node .agents/loopengine/governance/validate.mjs',
    lint: 'Not configured; use detected project checks or manual evidence',
    typecheck: 'Not configured; use detected project checks or manual evidence',
  },
};

export const managedAgentsBlockStart = '<!-- LOOPENGINE:START -->';
export const managedAgentsBlockEnd = '<!-- LOOPENGINE:END -->';

const managedAgentsBlockPattern = /<!-- LOOPENGINE:START -->[\s\S]*?<!-- LOOPENGINE:END -->\n?/u;

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
      return 'Not configured; use detected project checks or manual evidence';
    }
    return String(value);
  });
}

export function hasIncompleteManagedAgentsBlock(content = '') {
  const hasStart = content.includes(managedAgentsBlockStart);
  const hasEnd = content.includes(managedAgentsBlockEnd);
  return hasStart !== hasEnd;
}

export function renderManagedAgentsBlock(content) {
  return `${managedAgentsBlockStart}\n${String(content).trimEnd()}\n${managedAgentsBlockEnd}\n`;
}

export function extractManagedAgentsBlock(content = '') {
  const match = content.match(managedAgentsBlockPattern);
  return match ? renderManagedAgentsBlock(match[0]
    .replace(managedAgentsBlockStart, '')
    .replace(managedAgentsBlockEnd, '')
    .trim()) : null;
}

export function mergeManagedAgentsBlock(existingContent, managedContent) {
  if (hasIncompleteManagedAgentsBlock(existingContent)) {
    throw new Error('AGENTS.md contains an incomplete LoopEngine managed block.');
  }

  const managedBlock = renderManagedAgentsBlock(managedContent);
  if (!existingContent || existingContent.trim().length === 0) {
    return managedBlock;
  }

  if (managedAgentsBlockPattern.test(existingContent)) {
    return existingContent.replace(managedAgentsBlockPattern, managedBlock);
  }

  const separator = existingContent.endsWith('\n')
    ? (existingContent.endsWith('\n\n') ? '' : '\n')
    : '\n\n';
  return `${existingContent}${separator}${managedBlock}`;
}
