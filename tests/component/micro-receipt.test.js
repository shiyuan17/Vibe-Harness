import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { validateJsonAgainstSchema } from '../../scripts/lib/schema-validation.js';

test('Micro receipt schema accepts bounded passed evidence', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const schema = JSON.parse(await readFile(path.join(root, 'schemas/micro-verification.schema.json'), 'utf8'));
  const receipt = {
    schemaVersion: 1,
    id: 'receipt-1',
    checkId: 'config-normalization',
    status: 'passed',
    inputSummary: { argsFingerprint: 'a' },
    outputSummary: { stdout: '[REDACTED]' },
    durationMs: 42,
    exitCode: 0,
    workspaceFingerprint: 'tree',
    snapshotComparison: 'match',
    cache: { status: 'miss', key: 'cache-key' },
  };
  assert.deepEqual(validateJsonAgainstSchema(receipt, schema), []);
});

test('Micro receipt schema rejects an unreviewable status', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const schema = JSON.parse(await readFile(path.join(root, 'schemas/micro-verification.schema.json'), 'utf8'));
  const errors = validateJsonAgainstSchema({
    schemaVersion: 1,
    id: 'receipt-1',
    checkId: 'probe',
    status: 'queued',
    durationMs: 0,
    snapshotComparison: 'match',
  }, schema);
  assert.ok(errors.some((item) => item.includes('status')));
});
