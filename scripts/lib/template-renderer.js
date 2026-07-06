const defaultTemplateData = {
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
