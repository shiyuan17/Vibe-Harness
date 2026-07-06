const defaultTemplateData = {
  installedSurface: {
    hooksLine: '',
    profileLine: '- 当前 profile 使用 LoopEngine Codex 安装面。',
    reviewLoopLine: '',
    rulesLine: '- 规则位于 `docs/rules/`。',
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
