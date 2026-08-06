import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultProjectConfig, validateProjectConfigWithSchema } from '../scripts/lib/project-config.js';
import { assertSupportedSchemaKeywords, validateJsonAgainstSchema } from '../scripts/lib/schema-validation.js';

test('validateJsonAgainstSchema reports type mismatches with instance and schema paths', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 0 } },
    additionalProperties: false,
  };
  const errors = validateJsonAgainstSchema({ name: 42, rogue: true }, schema, 'config');
  assert.ok(errors.some((e) => e.includes('config.name') && e.includes('must be string')));
  assert.ok(errors.some((e) => e.includes('config.rogue') && e.includes('is not allowed')));
  assert.equal(errors.length, 2);
});

test('validateJsonAgainstSchema enforces numeric minimum/maximum and enum constraints', () => {
  const schema = {
    type: 'object',
    properties: {
      level: { type: 'integer', minimum: 1, maximum: 3 },
      mood: { type: 'string', enum: ['low', 'high'] },
    },
  };
  const errors = validateJsonAgainstSchema({ level: 5, mood: 'medium' }, schema);
  assert.ok(errors.some((e) => e.includes('level') && e.includes('must be <= 3')));
  assert.ok(errors.some((e) => e.includes('mood') && e.includes('must be one of')));
});

test('validateJsonAgainstSchema handles anyOf for nullable string fields', () => {
  const schema = {
    type: 'object',
    properties: {
      cmd: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    },
  };
  assert.deepEqual(validateJsonAgainstSchema({ cmd: 'pnpm test' }, schema), []);
  assert.deepEqual(validateJsonAgainstSchema({ cmd: null }, schema), []);
  assert.ok(validateJsonAgainstSchema({ cmd: 42 }, schema).length > 0);
});

test('validateJsonAgainstSchema enforces array uniqueItems and minItems', () => {
  const schema = { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true };
  assert.ok(validateJsonAgainstSchema([], schema).some((e) => e.includes('at least 1')));
  assert.ok(validateJsonAgainstSchema(['a', 'a'], schema).some((e) => e.includes('unique items')));
  assert.deepEqual(validateJsonAgainstSchema(['a', 'b'], schema), []);
});

test('assertSupportedSchemaKeywords rejects unsupported keywords', () => {
  assert.throws(
    () => assertSupportedSchemaKeywords({ type: 'string', $defs: {} }),
    /Unsupported schema keyword/u,
  );
  assert.throws(
    () => assertSupportedSchemaKeywords({ properties: { a: { type: 'string', format: 'uri' } } }),
    /Unsupported schema keyword/u,
  );
});

test('assertSupportedSchemaKeywords accepts the supported keyword set', () => {
  const schema = {
    type: 'object',
    properties: { id: { type: 'string', pattern: '^[a-z]+$' } },
    required: ['id'],
    additionalProperties: false,
  };
  assertSupportedSchemaKeywords(schema);
});

test('project config accepts legacy and canonical targets while enforcing the multi-host contract', () => {
  const legacy = { ...defaultProjectConfig, target: 'codex' };
  delete legacy.targets;
  assert.equal(validateProjectConfigWithSchema(legacy), true);
  assert.equal(validateProjectConfigWithSchema({ ...defaultProjectConfig, targets: ['antigravity'] }), true);
  assert.throws(
    () => validateProjectConfigWithSchema({ ...defaultProjectConfig, target: 'codex' }),
    /exactly one of target/u,
  );
  assert.throws(
    () => validateProjectConfigWithSchema({ ...defaultProjectConfig, targets: ['codex', 'codex'] }),
    /unique items|duplicate adapters/u,
  );
});
