import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  AUTO_CLAIM_RECEIPT_SOURCE,
  analyzeReceiptLedger,
  START_RECEIPT_KEYS_V3,
  START_RECEIPT_KEYS_V3_OPTIONAL,
  START_RECEIPT_SCHEMA_V3,
  summarizeReceiptLedger,
  TERMINAL_EVENT_KEYS,
  TERMINAL_EVENT_SCHEMA,
  validateStartReceipt,
  validateTerminalEvent,
} from '../../scripts/lib/receipt-records.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const RECEIPT_CLI = path.join(repositoryRoot, 'scripts', 'receipt.js');
const SAMPLE_PATH = path.join(
  import.meta.dirname,
  '..',
  'fixtures',
  'symphony-hosted',
  'guarded-execution.sample.json',
);

async function loadSample() {
  return JSON.parse(await readFile(SAMPLE_PATH, 'utf8'));
}

test('Symphony 宿主写出的 v3 Receipt 与 v1 终止事件通过消费方校验', async () => {
  const sample = await loadSample();
  assert.equal(sample.length, 2);
  const [receipt, event] = sample;

  assert.equal(receipt.schema, START_RECEIPT_SCHEMA_V3);
  assert.equal(receipt.source, AUTO_CLAIM_RECEIPT_SOURCE);
  assert.equal(receipt.hostKind, 'symphony-elixir');
  assert.equal(receipt.claimProvider, 'symphony-postgresql');
  assert.deepEqual(
    Object.keys(receipt).sort(),
    [...START_RECEIPT_KEYS_V3, ...START_RECEIPT_KEYS_V3_OPTIONAL].sort(),
  );
  assert.deepEqual(validateStartReceipt(receipt).problems, []);

  assert.equal(event.schema, TERMINAL_EVENT_SCHEMA);
  assert.equal(event.eventType, 'local-work-completed');
  assert.deepEqual(Object.keys(event).sort(), [...TERMINAL_EVENT_KEYS].sort());
  assert.ok(Object.hasOwn(event, 'successorExecutionId'));
  assert.equal(event.successorExecutionId, null);
  assert.deepEqual(validateTerminalEvent(event).problems, []);
});

test('消费方把宿主样例判定为已完结且无冲突的执行台账', async () => {
  const analysis = analyzeReceiptLedger(await loadSample(), { issue: 'DEMO-401' });

  assert.equal(analysis.ok, true);
  assert.equal(analysis.status, 'passed');
  assert.equal(analysis.conflictCount, 0);
  assert.deepEqual(analysis.activeExecutions, []);
  assert.equal(analysis.executions.length, 1);
  assert.equal(analysis.executions[0].executionId, '9c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f');
  assert.equal(analysis.executions[0].terminalEventType, 'local-work-completed');
  assert.equal(analysis.executions[0].source, AUTO_CLAIM_RECEIPT_SOURCE);
  assert.match(summarizeReceiptLedger(analysis), /status: passed/u);
});

test('消费方拒绝被篡改的宿主记录而不是照单全收', async () => {
  const [receipt, event] = await loadSample();

  const expiredLease = { ...receipt, leaseExpiresAt: receipt.startedAt };
  assert.equal(validateStartReceipt(expiredLease).ok, false);
  assert.ok(
    validateStartReceipt(expiredLease).problems.some((problem) => problem.code === 'RECEIPT_LEASE_EXPIRED'),
  );

  const orphaned = analyzeReceiptLedger([{ ...event, executionId: '11111111-2222-4333-8444-555555555555' }]);
  assert.equal(orphaned.ok, false);
  assert.ok(orphaned.conflicts.some((conflict) => conflict.code === 'RECEIPT_EVENT_ORPHANED'));

  const secondRun = {
    ...receipt,
    executionId: '22222222-3333-4444-8555-666666666666',
  };
  const duplicated = analyzeReceiptLedger([receipt, secondRun]);
  assert.equal(duplicated.ok, false);
  assert.ok(duplicated.conflicts.some((conflict) => conflict.code === 'RECEIPT_MULTIPLE_ACTIVE_EXECUTIONS'));
  assert.equal(duplicated.conflicts.length, 1);
});

test('receipt.js 校验子命令接受宿主样例台账', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    RECEIPT_CLI,
    'check',
    '--file',
    SAMPLE_PATH,
    '--issue',
    'DEMO-401',
    '--json',
  ]);
  const analysis = JSON.parse(stdout);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.status, 'passed');
  assert.equal(analysis.conflictCount, 0);
});
