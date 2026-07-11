export function validateJsonAgainstSchema(value, schema, label = 'value') {
  const errors = [];
  function typeMatches(current, type) {
    if (type === 'array') return Array.isArray(current);
    if (type === 'integer') return Number.isInteger(current);
    if (type === 'object') return Boolean(current) && typeof current === 'object' && !Array.isArray(current);
    return typeof current === type;
  }
  function visit(current, currentSchema, currentLabel) {
    if (Array.isArray(currentSchema.anyOf)) {
      const variants = currentSchema.anyOf.map((candidate) => validateJsonAgainstSchema(current, candidate, currentLabel));
      if (!variants.some((variantErrors) => variantErrors.length === 0)) errors.push(...variants[0]);
      return;
    }
    if (currentSchema.type && !typeMatches(current, currentSchema.type)) {
      errors.push(`${currentLabel} 必须是 ${currentSchema.type}`);
      return;
    }
    if (Array.isArray(currentSchema.enum) && !currentSchema.enum.includes(current)) {
      errors.push(`${currentLabel} 必须是以下值之一：${currentSchema.enum.join('、')}`);
      return;
    }
    if (currentSchema.type === 'object') {
      for (const key of currentSchema.required ?? []) {
        if (!Object.hasOwn(current, key)) errors.push(`${currentLabel}.${key} 为必填项`);
      }
      const properties = currentSchema.properties ?? {};
      if (currentSchema.additionalProperties === false) {
        for (const key of Object.keys(current)) {
          if (!Object.hasOwn(properties, key)) errors.push(`${currentLabel}.${key} 不允许出现`);
        }
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (Object.hasOwn(current, key)) visit(current[key], propertySchema, `${currentLabel}.${key}`);
      }
    }
    if (currentSchema.type === 'array') {
      if (currentSchema.minItems !== undefined && current.length < currentSchema.minItems) errors.push(`${currentLabel} 至少需要 ${currentSchema.minItems} 项`);
      if (currentSchema.uniqueItems && new Set(current.map((item) => JSON.stringify(item))).size !== current.length) errors.push(`${currentLabel} 不得包含重复项`);
      if (currentSchema.items) current.forEach((item, index) => visit(item, currentSchema.items, `${currentLabel}[${index}]`));
    }
    if (currentSchema.type === 'string' && currentSchema.minLength !== undefined && current.length < currentSchema.minLength) errors.push(`${currentLabel} 长度不得小于 ${currentSchema.minLength}`);
    if (currentSchema.type === 'integer' && currentSchema.minimum !== undefined && current < currentSchema.minimum) errors.push(`${currentLabel} 不得小于 ${currentSchema.minimum}`);
  }
  visit(value, schema, label);
  return errors;
}
