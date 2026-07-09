const defaultTemplateData = {
  installedSurface: {
    codegraphLine: '',
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
    workflowsLine: '',
  },
  packageManager: 'pnpm',
  projectName: 'target project',
  validationCommands: {
    governance: 'pnpm run check:governance',
    lint: 'pnpm lint',
    typecheck: 'pnpm check:type',
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
    if (value === undefined || value === null) {
      throw new Error(`Missing template variable: ${expression}`);
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
