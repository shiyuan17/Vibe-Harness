const supportedKeywords = new Set([
  '$defs', '$id', '$ref', '$schema', 'additionalProperties', 'allOf', 'anyOf', 'const', 'default', 'description', 'enum',
  'exclusiveMaximum', 'exclusiveMinimum', 'items', 'maxItems', 'maxLength', 'maxProperties', 'maximum',
  'format', 'minItems', 'minLength', 'minProperties', 'minimum', 'multipleOf', 'not', 'oneOf', 'pattern',
  'properties', 'required', 'title', 'type', 'uniqueItems',
]);

function assertSchemaObject(schema, schemaPath) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`Schema at ${schemaPath} must be an object.`);
  }
}

export function assertSupportedSchemaKeywords(schema, schemaPath = '$') {
  assertSchemaObject(schema, schemaPath);
  for (const key of Object.keys(schema)) {
    if (!supportedKeywords.has(key)) throw new Error(`Unsupported schema keyword at ${schemaPath}: ${key}`);
  }
  if (schema.format !== undefined && schema.format !== 'date-time') {
    throw new Error(`Unsupported schema format at ${schemaPath}: ${schema.format}`);
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    assertSupportedSchemaKeywords(child, `${schemaPath}.properties.${key}`);
  }
  for (const [key, child] of Object.entries(schema.$defs ?? {})) {
    assertSupportedSchemaKeywords(child, `${schemaPath}.$defs.${key}`);
  }
  if (schema.items) assertSupportedSchemaKeywords(schema.items, `${schemaPath}.items`);
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    for (const [index, child] of (schema[keyword] ?? []).entries()) {
      assertSupportedSchemaKeywords(child, `${schemaPath}.${keyword}[${index}]`);
    }
  }
  if (schema.not) assertSupportedSchemaKeywords(schema.not, `${schemaPath}.not`);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    assertSupportedSchemaKeywords(schema.additionalProperties, `${schemaPath}.additionalProperties`);
  }
}

function typeMatches(value, type) {
  if (Array.isArray(type)) return type.some((candidate) => typeMatches(value, candidate));
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isMultipleOf(value, divisor) {
  const quotient = value / divisor;
  return Math.abs(quotient - Math.round(quotient)) < Number.EPSILON * 10;
}

export function validateJsonAgainstSchema(value, schema, label = 'value') {
  assertSupportedSchemaKeywords(schema);
  const errors = [];

  function resolveReference(reference) {
    if (typeof reference !== 'string' || !reference.startsWith('#/')) {
      throw new Error(`Only local JSON Schema references are supported: ${reference}`);
    }
    return reference.slice(2).split('/').reduce((current, segment) => {
      const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
      if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) {
        throw new Error(`Unresolved JSON Schema reference: ${reference}`);
      }
      return current[key];
    }, schema);
  }

  function addError(instancePath, schemaPath, message) {
    errors.push(`${instancePath} ${message} [schema: ${schemaPath}]`);
  }

  function evaluate(current, currentSchema, instancePath, schemaPath) {
    if (currentSchema.$ref) {
      evaluate(current, resolveReference(currentSchema.$ref), instancePath, currentSchema.$ref);
    }
    for (const [index, candidate] of (currentSchema.allOf ?? []).entries()) {
      evaluate(current, candidate, instancePath, `${schemaPath}.allOf[${index}]`);
    }
    if (Array.isArray(currentSchema.anyOf)) {
      const variants = currentSchema.anyOf.map((candidate, index) => {
        const start = errors.length;
        evaluate(current, candidate, instancePath, `${schemaPath}.anyOf[${index}]`);
        return errors.splice(start);
      });
      if (!variants.some((variantErrors) => variantErrors.length === 0)) {
        addError(instancePath, `${schemaPath}.anyOf`, 'must match at least one allowed schema');
      }
      return;
    }
    if (Array.isArray(currentSchema.oneOf)) {
      const matches = currentSchema.oneOf.filter((candidate, index) => {
        const start = errors.length;
        evaluate(current, candidate, instancePath, `${schemaPath}.oneOf[${index}]`);
        return errors.splice(start).length === 0;
      }).length;
      if (matches !== 1) addError(instancePath, `${schemaPath}.oneOf`, 'must match exactly one allowed schema');
      return;
    }
    if (currentSchema.not) {
      const start = errors.length;
      evaluate(current, currentSchema.not, instancePath, `${schemaPath}.not`);
      if (errors.splice(start).length === 0) addError(instancePath, `${schemaPath}.not`, 'must not match the forbidden schema');
    }

    if (currentSchema.type && !typeMatches(current, currentSchema.type)) {
      addError(instancePath, `${schemaPath}.type`, `must be ${Array.isArray(currentSchema.type) ? currentSchema.type.join(' or ') : currentSchema.type}`);
      return;
    }
    if (Array.isArray(currentSchema.enum) && !currentSchema.enum.some((item) => jsonEquals(item, current))) {
      addError(instancePath, `${schemaPath}.enum`, `must be one of ${currentSchema.enum.join(', ')}`);
      return;
    }
    if (Object.hasOwn(currentSchema, 'const') && !jsonEquals(currentSchema.const, current)) {
      addError(instancePath, `${schemaPath}.const`, 'must equal the configured constant');
      return;
    }

    if (currentSchema.type === 'object') {
      const properties = currentSchema.properties ?? {};
      for (const key of currentSchema.required ?? []) {
        if (!Object.hasOwn(current, key)) addError(`${instancePath}.${key}`, `${schemaPath}.required`, 'is required');
      }
      const keys = Object.keys(current);
      if (currentSchema.minProperties !== undefined && keys.length < currentSchema.minProperties) {
        addError(instancePath, `${schemaPath}.minProperties`, `must contain at least ${currentSchema.minProperties} properties`);
      }
      if (currentSchema.maxProperties !== undefined && keys.length > currentSchema.maxProperties) {
        addError(instancePath, `${schemaPath}.maxProperties`, `must contain at most ${currentSchema.maxProperties} properties`);
      }
      for (const key of keys) {
        if (Object.hasOwn(properties, key)) continue;
        if (currentSchema.additionalProperties === false) {
          addError(`${instancePath}.${key}`, `${schemaPath}.additionalProperties`, 'is not allowed');
        } else if (currentSchema.additionalProperties && typeof currentSchema.additionalProperties === 'object') {
          evaluate(current[key], currentSchema.additionalProperties, `${instancePath}.${key}`, `${schemaPath}.additionalProperties`);
        }
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (Object.hasOwn(current, key)) evaluate(current[key], propertySchema, `${instancePath}.${key}`, `${schemaPath}.properties.${key}`);
      }
    }

    if (currentSchema.type === 'array') {
      if (currentSchema.minItems !== undefined && current.length < currentSchema.minItems) {
        addError(instancePath, `${schemaPath}.minItems`, `must contain at least ${currentSchema.minItems} item(s)`);
      }
      if (currentSchema.maxItems !== undefined && current.length > currentSchema.maxItems) {
        addError(instancePath, `${schemaPath}.maxItems`, `must contain at most ${currentSchema.maxItems} item(s)`);
      }
      if (currentSchema.uniqueItems && new Set(current.map((item) => JSON.stringify(item))).size !== current.length) {
        addError(instancePath, `${schemaPath}.uniqueItems`, 'must contain unique items');
      }
      current.forEach((item, index) => {
        if (currentSchema.items) evaluate(item, currentSchema.items, `${instancePath}[${index}]`, `${schemaPath}.items`);
      });
    }

    if (currentSchema.type === 'string') {
      if (currentSchema.minLength !== undefined && current.length < currentSchema.minLength) {
        addError(instancePath, `${schemaPath}.minLength`, `must have length >= ${currentSchema.minLength}`);
      }
      if (currentSchema.maxLength !== undefined && current.length > currentSchema.maxLength) {
        addError(instancePath, `${schemaPath}.maxLength`, `must have length <= ${currentSchema.maxLength}`);
      }
      if (currentSchema.pattern !== undefined && !(new RegExp(currentSchema.pattern, 'u')).test(current)) {
        addError(instancePath, `${schemaPath}.pattern`, `must match pattern ${currentSchema.pattern}`);
      }
      if (currentSchema.format === 'date-time' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(current)) {
        addError(instancePath, `${schemaPath}.format`, 'must use RFC 3339 date-time format');
      }
    }

    if (['integer', 'number'].includes(currentSchema.type)) {
      if (currentSchema.minimum !== undefined && current < currentSchema.minimum) addError(instancePath, `${schemaPath}.minimum`, `must be >= ${currentSchema.minimum}`);
      if (currentSchema.maximum !== undefined && current > currentSchema.maximum) addError(instancePath, `${schemaPath}.maximum`, `must be <= ${currentSchema.maximum}`);
      if (currentSchema.exclusiveMinimum !== undefined && current <= currentSchema.exclusiveMinimum) addError(instancePath, `${schemaPath}.exclusiveMinimum`, `must be > ${currentSchema.exclusiveMinimum}`);
      if (currentSchema.exclusiveMaximum !== undefined && current >= currentSchema.exclusiveMaximum) addError(instancePath, `${schemaPath}.exclusiveMaximum`, `must be < ${currentSchema.exclusiveMaximum}`);
      if (currentSchema.multipleOf !== undefined && !isMultipleOf(current, currentSchema.multipleOf)) addError(instancePath, `${schemaPath}.multipleOf`, `must be a multiple of ${currentSchema.multipleOf}`);
    }
  }

  evaluate(value, schema, label, '$');
  return errors;
}
