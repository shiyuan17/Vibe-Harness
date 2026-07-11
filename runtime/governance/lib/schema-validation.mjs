export function validateJsonAgainstSchema(value, schema, label = 'value') {
  const errors = [];
  function typeMatches(current, type) {
    if (type === 'array') return Array.isArray(current);
    if (type === 'integer') return Number.isInteger(current);
    if (type === 'object') return Boolean(current) && typeof current === 'object' && !Array.isArray(current);
    return typeof current === type;
  }
  function visit(current, currentSchema, currentLabel) {
    if (currentSchema.type && !typeMatches(current, currentSchema.type)) {
      errors.push(`${currentLabel} must be ${currentSchema.type}`);
      return;
    }
    if (Array.isArray(currentSchema.enum) && !currentSchema.enum.includes(current)) {
      errors.push(`${currentLabel} must be one of ${currentSchema.enum.join(', ')}`);
      return;
    }
    if (currentSchema.type === 'object') {
      for (const key of currentSchema.required ?? []) {
        if (!Object.hasOwn(current, key)) errors.push(`${currentLabel}.${key} is required`);
      }
      const properties = currentSchema.properties ?? {};
      if (currentSchema.additionalProperties === false) {
        for (const key of Object.keys(current)) {
          if (!Object.hasOwn(properties, key)) errors.push(`${currentLabel}.${key} is not allowed`);
        }
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (Object.hasOwn(current, key)) visit(current[key], propertySchema, `${currentLabel}.${key}`);
      }
    }
    if (currentSchema.type === 'array') {
      if (currentSchema.minItems !== undefined && current.length < currentSchema.minItems) errors.push(`${currentLabel} must contain at least ${currentSchema.minItems} item(s)`);
      if (currentSchema.uniqueItems && new Set(current.map((item) => JSON.stringify(item))).size !== current.length) errors.push(`${currentLabel} must contain unique items`);
      if (currentSchema.items) current.forEach((item, index) => visit(item, currentSchema.items, `${currentLabel}[${index}]`));
    }
    if (currentSchema.type === 'string' && currentSchema.minLength !== undefined && current.length < currentSchema.minLength) errors.push(`${currentLabel} must have length >= ${currentSchema.minLength}`);
  }
  visit(value, schema, label);
  return errors;
}
