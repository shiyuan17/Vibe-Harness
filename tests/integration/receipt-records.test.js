import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  AUTO_CLAIM_RECEIPT_SOURCE,
  analyzeReceiptLedger,
  buildHandoffPayload,
  buildStartReceipt,
  buildTerminalEvent,
  handoffClaimsComplete,
  scanSensitiveFields,
  summarizeReceiptLedger,
  START_RECEIPT_SCHEMA_V2,
  validateHandoffPayload,
  validateStartReceipt,
  validateTerminalEvent,
} from '../../scripts/lib/receipt-records.js';
import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const RECEIPT_CLI = path.join(repositoryRoot, 'scripts', 'receipt.js');

const EXECUTION_A = '11111111-2222-4333-8444-555555555555';
const EXECUTION_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const EVENT_A = '99999999-8888-4777-8666-555555555555';
const GRANT_A = '12345678-1234-4234-8234-123456789abc';

function receipt(overrides = {}) {
  return buildStartReceipt({
    agentKey: 'codex',
    dagNodeIssue: 'ENG-123',
    executionId: EXECUTION_A,
    hostKind: 'codex-desktop',
    runtimeInstanceId: '0f0f0f0f-1e1e-4d4d-8c8c-2b2b2b2b2b2b',
    startedAt: '2026-09-13T00:00:00.000Z',
    ...overrides,
  });
}

function event(overrides = {}) {
  return buildTerminalEvent({
    eventId: EVENT_A,
    executionId: EXECUTION_A,
    eventType: 'released',
    occurredAt: '2026-09-13T01:00:00.000Z',
    ...overrides,
  });
}

function completeHandoff(overrides = {}) {
  return {
    ...buildHandoffPayload({ accepted: true, finalCheckReceiptId: 'verification-1', status: 'complete' }),
    ...overrides,
  };
}

async function runCli(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [RECEIPT_CLI, ...args], { windowsHide: true, ...options });
    return { code: 0, stderr, stdout };
  } catch (error) {
    return { code: error.code, stderr: error.stderr ?? '', stdout: error.stdout ?? '' };
  }
}

test('start receipts use fresh run identifiers and only the fixed v1 fields', () => {
  const record = buildStartReceipt({ agentKey: 'codex', dagNodeIssue: 'ENG-123', hostKind: 'codex-desktop' });
  assert.equal(validateStartReceipt(record).ok, true, JSON.stringify(validateStartReceipt(record).problems));
  assert.match(record.executionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(record.executionId, record.runtimeInstanceId);
  assert.deepEqual(Object.keys(record), [
    'schema', 'executionId', 'source', 'agentKey', 'hostKind', 'delegateId', 'runtimeInstanceId', 'role', 'dagRootIssue', 'dagNodeIssue', 'startedAt',
  ]);
  assert.equal(record.schema, 'vibe-harness.linear-execution/v1');
  assert.equal(record.role, 'writer');
  assert.equal(record.delegateId, null);
  assert.equal(record.dagRootIssue, null);

  const invalid = {
    ...record,
    role: 'reviewer',
    source: 'auto-claimed',
    runtimeInstanceId: 'not-a-uuid',
    startedAt: '2026-09-13 00:00:00',
  };
  const problems = validateStartReceipt(invalid).problems.map((problem) => problem.code);
  assert.equal(validateStartReceipt(invalid).ok, false);
  assert.equal(problems.includes('RECEIPT_ROLE_INVALID'), true);
  assert.equal(problems.includes('RECEIPT_SOURCE_INVALID'), true);
  assert.equal(problems.includes('RECEIPT_FIELD_NOT_UUID_V4'), true);
  assert.equal(problems.includes('RECEIPT_FIELD_NOT_TIMESTAMP'), true);
  assert.equal(validateStartReceipt({ ...record, dagNodeIssue: undefined }).ok, false);
});

test('the redaction guard blocks host identity, local paths and credentials', () => {
  assert.deepEqual(scanSensitiveFields(receipt()), []);
  const leaks = scanSensitiveFields({
    ...receipt(),
    dagRootIssue: 'ENG-100',
    note: 'ran on DESKTOP-42 at C:\\Users\\operator\\repo',
    threadId: 'abc',
  });
  const codes = leaks.map((finding) => finding.code);
  assert.equal(codes.includes('RECEIPT_LOCAL_PATH'), true);
  assert.equal(codes.includes('RECEIPT_IDENTITY_FIELD'), true);
  assert.equal(leaks.every((finding) => finding.path.length > 0), true);

  assert.equal(validateStartReceipt({ ...receipt(), dagRootIssue: null, extra: 'ghp_abcdefghijklmnopqrstuvwxyz012345' }).problems.some((problem) => problem.code === 'RECEIPT_CREDENTIAL'), true);
  assert.equal(validateStartReceipt({ ...receipt(), owner: 'ops@example.com' }).problems.some((problem) => problem.code === 'RECEIPT_IDENTITY_VALUE'), true);

  // The guard reports locations, never the matched secret itself.
  const serialized = JSON.stringify(scanSensitiveFields({ secret: 'Bearer abcdefghijklmnopqrstuvwxyz' }));
  assert.equal(serialized.includes('abcdefghijklmnopqrstuvwxyz'), false);
});

test('terminal events carry a successor only for handed-off runs', () => {
  assert.equal(validateTerminalEvent(event()).ok, true);
  assert.equal(validateTerminalEvent(event({ eventType: 'local-work-completed' })).ok, true);
  assert.equal(validateTerminalEvent({ ...event(), successorExecutionId: EXECUTION_B }).problems
    .some((problem) => problem.code === 'RECEIPT_HANDOFF_SUCCESSOR_NOT_ALLOWED'), true);
  assert.equal(validateTerminalEvent({ ...event(), eventType: 'handed-off', successorExecutionId: null }).problems
    .some((problem) => problem.code === 'RECEIPT_HANDOFF_SUCCESSOR_REQUIRED'), true);
  assert.equal(validateTerminalEvent({ ...event(), eventType: 'handed-off', successorExecutionId: EXECUTION_A }).problems
    .some((problem) => problem.code === 'RECEIPT_HANDOFF_SUCCESSOR_SELF'), true);
  assert.equal(validateTerminalEvent(event({ eventType: 'handed-off', successorExecutionId: EXECUTION_B, handoff: completeHandoff() })).ok, true);
  assert.equal(validateTerminalEvent(event({ eventType: 'released', handoff: completeHandoff() })).problems
    .some((problem) => problem.code === 'RECEIPT_HANDOFF_PAYLOAD_NOT_ALLOWED'), true);
  assert.equal(validateTerminalEvent(event({ eventType: 'expired' })).problems
    .some((problem) => problem.code === 'RECEIPT_EVENT_TYPE_INVALID'), true);
  assert.throws(() => buildTerminalEvent({ executionId: EXECUTION_A, eventType: 'handed-off' }), /pre-generated successorExecutionId/u);
  assert.throws(() => buildTerminalEvent({ executionId: EXECUTION_A, eventType: 'released', successorExecutionId: EXECUTION_B }), /only valid on handed-off/u);
});

test('handoff payloads only claim completion with a reviewed and passed final check', () => {
  const complete = completeHandoff();
  assert.equal(validateHandoffPayload(complete).ok, true, JSON.stringify(validateHandoffPayload(complete).problems));
  assert.equal(handoffClaimsComplete(complete), true);

  const optimistic = buildHandoffPayload({ accepted: true, finalCheckReceiptId: 'verification-1', status: 'in-progress' });
  const optimisticProblems = validateHandoffPayload(optimistic).problems;
  assert.equal(validateHandoffPayload(optimistic).ok, false);
  assert.equal(optimisticProblems.some((problem) => problem.code === 'RECEIPT_HANDOFF_COMPLETION_UNSUPPORTED'), true);
  assert.equal(handoffClaimsComplete(optimistic), false);

  const unreviewed = completeHandoff({ finalCheck: { receiptId: 'verification-1', relevance: 'referenced', status: 'passed' } });
  const unreviewedValidation = validateHandoffPayload(unreviewed);
  assert.equal(unreviewedProblems(unreviewedValidation).includes('RECEIPT_FINAL_CHECK_NOT_REVIEWED'), true);
  assert.equal(unreviewedValidation.ok, false);

  const failedCheck = validateHandoffPayload(completeHandoff({ finalCheck: { receiptId: 'verification-1', relevance: 'reviewed', status: 'failed' } }));
  assert.equal(failedCheck.ok, false);
  assert.equal(failedCheck.problems.some((problem) => problem.code === 'RECEIPT_HANDOFF_COMPLETION_UNSUPPORTED'), true);

  const progress = validateHandoffPayload({ schema: 'vibe-harness.handoff/v1', completion: { status: 'blocked', accepted: false }, finalCheck: { receiptId: 'verification-1', relevance: 'reviewed', status: 'failed' }, unresolvedItems: [] });
  assert.equal(progress.ok, true, JSON.stringify(progress.problems));
  assert.equal(handoffClaimsComplete({ schema: 'vibe-harness.handoff/v1', completion: { status: 'blocked', accepted: false }, finalCheck: { receiptId: 'verification-1', relevance: 'reviewed', status: 'failed' }, unresolvedItems: [] }), false);

  assert.equal(validateHandoffPayload({ schema: 'vibe-harness.handoff/v1', completion: { status: 'complete', accepted: true }, finalCheck: { receiptId: 'v', relevance: 'reviewed', status: 'passed' } }).problems
    .some((problem) => problem.code === 'RECEIPT_FIELD_MISSING'), true);
  assert.equal(validateHandoffPayload(completeHandoff({ unresolvedItems: [{ id: 'follow-up-1', owner: '', summary: 'x' }] })).problems
    .some((problem) => problem.code === 'RECEIPT_UNRESOLVED_OWNER_MISSING'), true);
  assert.equal(validateHandoffPayload(completeHandoff({ unresolvedItems: [{ id: 'a', owner: 'team', summary: 'x' }, { id: 'a', owner: 'team', summary: 'y' }] })).problems
    .some((problem) => problem.code === 'RECEIPT_UNRESOLVED_DUPLICATE_ID'), true);
});

function unreviewedProblems(validation) {
  return validation.problems.map((problem) => problem.code);
}

test('ledger analysis detects conflicts, idempotent retries and handoff gaps', () => {
  const active = receipt();
  assert.equal(summarizeReceiptLedger(analyzeReceiptLedger([active])).includes('status: passed'), true);
  assert.deepEqual(analyzeReceiptLedger([active]).activeExecutions, [EXECUTION_A]);
  assert.equal(analyzeReceiptLedger([active, active]).duplicateCount, 1);
  assert.equal(analyzeReceiptLedger([active, active]).conflicts.length, 0);

  const conflicting = analyzeReceiptLedger([active, { ...active, agentKey: 'claude' }]);
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.conflicts.some((conflict) => conflict.code === 'RECEIPT_ID_CONFLICT'), true);

  const secondActive = analyzeReceiptLedger([active, receipt({ agentKey: 'claude', executionId: EXECUTION_B })]);
  assert.equal(secondActive.conflicts.some((conflict) => conflict.code === 'RECEIPT_MULTIPLE_ACTIVE_EXECUTIONS'), true);
  assert.deepEqual(secondActive.activeByIssue, { 'ENG-123': [EXECUTION_A, EXECUTION_B] });

  const released = event();
  const releasedLedger = analyzeReceiptLedger([active, released]);
  assert.equal(releasedLedger.status, 'passed');
  assert.deepEqual(releasedLedger.activeExecutions, []);
  assert.equal(releasedLedger.executions[0].terminalEventType, 'released');

  assert.equal(analyzeReceiptLedger([released]).conflicts.some((conflict) => conflict.code === 'RECEIPT_EVENT_ORPHANED'), true);
  assert.equal(analyzeReceiptLedger([active, released, event({ eventId: '77777777-6666-4555-8444-333333333333', occurredAt: '2026-09-13T02:00:00.000Z' })]).conflicts
    .some((conflict) => conflict.code === 'RECEIPT_MULTIPLE_TERMINAL_EVENTS'), true);
  assert.equal(analyzeReceiptLedger([{ hello: 'world' }]).conflicts.some((conflict) => conflict.code === 'LEDGER_UNKNOWN_RECORD'), true);
  assert.equal(analyzeReceiptLedger('nope').conflicts.some((conflict) => conflict.code === 'LEDGER_NOT_A_LIST'), true);
  assert.equal(analyzeReceiptLedger([active, released], { issue: 'ENG-999' }).conflicts
    .some((conflict) => conflict.code === 'LEDGER_ISSUE_MISMATCH'), true);

  const handedOff = event({ eventId: '55555555-4444-4333-8222-111111111111', eventType: 'handed-off', handoff: completeHandoff(), successorExecutionId: EXECUTION_B });
  const successor = receipt({ executionId: EXECUTION_B, source: 'authorized-handoff' });
  const completed = analyzeReceiptLedger([active, handedOff, successor]);
  assert.equal(completed.ok, true, JSON.stringify(completed.conflicts));
  assert.equal(completed.status, 'passed');
  assert.deepEqual(completed.activeExecutions, [EXECUTION_B]);

  const unconfirmed = analyzeReceiptLedger([active, handedOff]);
  assert.equal(unconfirmed.ok, true);
  assert.equal(unconfirmed.status, 'incomplete');
  assert.equal(unconfirmed.pendings.some((pending) => pending.code === 'RECEIPT_HANDOFF_INCOMPLETE'), true);

  const wrongSource = analyzeReceiptLedger([active, handedOff, receipt({ executionId: EXECUTION_B })]);
  assert.equal(wrongSource.conflicts.some((conflict) => conflict.code === 'RECEIPT_HANDOFF_SOURCE_INVALID'), true);
  const wrongTarget = analyzeReceiptLedger([active, handedOff, receipt({ dagNodeIssue: 'ENG-999', executionId: EXECUTION_B, source: 'authorized-handoff' })]);
  assert.equal(wrongTarget.conflicts.some((conflict) => conflict.code === 'RECEIPT_HANDOFF_TARGET_MISMATCH'), true);

  const noPayload = analyzeReceiptLedger([active, event({ eventId: '55555555-4444-4333-8222-111111111111', eventType: 'handed-off', successorExecutionId: EXECUTION_B }), successor]);
  assert.equal(noPayload.pendings.some((pending) => pending.code === 'RECEIPT_HANDOFF_PAYLOAD_MISSING'), true);
  const progressPayload = analyzeReceiptLedger([
    active,
    event({ eventId: '55555555-4444-4333-8222-111111111111', eventType: 'handed-off', handoff: buildHandoffPayload({ finalCheckReceiptId: 'verification-1', status: 'blocked' }), successorExecutionId: EXECUTION_B }),
    successor,
  ]);
  assert.equal(progressPayload.pendings.some((pending) => pending.code === 'RECEIPT_HANDOFF_NOT_COMPLETE'), true);

  const bundle = analyzeReceiptLedger({ comments: [active], issue: 'ENG-123' });
  assert.equal(bundle.ok, true);
  assert.equal(bundle.issue, 'ENG-123');
  assert.equal(analyzeReceiptLedger({ comments: [active], issue: 'ENG-123' }, { issue: 'ENG-999' }).conflicts
    .some((conflict) => conflict.code === 'LEDGER_ISSUE_MISMATCH'), true);
});

test('receipt CLI builds records, returns a verdict and refuses unsupported claims', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'vibe-receipt-'));
  try {
    const startFile = path.join(outDir, 'start.json');
    const started = await runCli(['start', '--issue', 'ENG-123', '--agent', 'codex', '--host', 'codex-desktop', '--out', startFile, '--write', '--json']);
    assert.equal(started.code, 0, started.stderr);
    const record = JSON.parse(await readFile(startFile, 'utf8'));
    assert.equal(record.dagNodeIssue, 'ENG-123');
    assert.equal(record.source, 'explicit-user-request');

    const leaked = await runCli(['start', '--issue', 'ENG-123', '--agent', 'codex', '--host', 'codex-desktop', '--delegate', 'C:\\Users\\operator']);
    assert.equal(leaked.code, 1);
    assert.match(leaked.stderr, /RECEIPT_LOCAL_PATH/u);

    const handoffFile = path.join(outDir, 'handoff.json');
    const complete = await runCli(['handoff', '--status', 'complete', '--accepted', '--final-check', 'verification-1', '--unresolved', 'follow-up-1|pending human check|platform-team', '--out', handoffFile, '--write']);
    assert.equal(complete.code, 0, complete.stderr);
    assert.equal(JSON.parse(await readFile(handoffFile, 'utf8')).completion.accepted, true);

    const optimistic = await runCli(['handoff', '--status', 'complete', '--final-check', 'verification-1']);
    assert.equal(optimistic.code, 1);
    assert.match(optimistic.stderr, /RECEIPT_HANDOFF_COMPLETION_UNSUPPORTED/u);

    const blocked = await runCli(['handoff', '--status', 'blocked', '--final-check', 'verification-1']);
    assert.equal(blocked.code, 0, blocked.stderr);

    const eventFile = path.join(outDir, 'event.json');
    const handedOff = await runCli(['event', '--execution-id', record.executionId, '--type', 'handed-off', '--generate-successor', '--handoff', handoffFile, '--out', eventFile, '--write', '--json']);
    assert.equal(handedOff.code, 0, handedOff.stderr);
    const terminalEvent = JSON.parse(await readFile(eventFile, 'utf8'));
    assert.notEqual(terminalEvent.successorExecutionId, record.executionId);
    assert.equal(terminalEvent.handoff.schema, 'vibe-harness.handoff/v1');
    assert.match(handedOff.stderr, /successor executionId/u);

    const noSuccessor = await runCli(['event', '--execution-id', record.executionId, '--type', 'handed-off']);
    assert.equal(noSuccessor.code, 1);
    const wrongEvent = await runCli(['event', '--execution-id', record.executionId, '--type', 'released', '--successor', EXECUTION_B]);
    assert.equal(wrongEvent.code, 1);
    assert.match(wrongEvent.stderr, /only valid with --type handed-off/u);

    const successor = receipt({ executionId: terminalEvent.successorExecutionId, source: 'authorized-handoff' });
    const ledgerFile = path.join(outDir, 'ledger.json');
    await writeFile(ledgerFile, `${JSON.stringify({ comments: [record, terminalEvent, successor], issue: 'ENG-123' }, null, 2)}\n`, 'utf8');
    const passed = await runCli(['check', '--file', ledgerFile, '--json']);
    assert.equal(passed.code, 0, passed.stderr);
    assert.equal(JSON.parse(passed.stdout).status, 'passed');

    await writeFile(ledgerFile, `${JSON.stringify([record, receipt({ agentKey: 'claude', executionId: EXECUTION_B })], null, 2)}\n`, 'utf8');
    const conflicted = await runCli(['check', '--file', ledgerFile]);
    assert.equal(conflicted.code, 1);
    assert.match(conflicted.stdout, /RECEIPT_MULTIPLE_ACTIVE_EXECUTIONS/u);
  } finally {
    await removeTemporaryDirectory(outDir);
  }
});

test('auto-claim v2 receipts require a grant reference and preserve v1 validation', () => {
  const claimed = buildStartReceipt({
    agentKey: 'codex',
    dagNodeIssue: 'ENG-123',
    grantId: GRANT_A,
    hostKind: 'codex-desktop',
    schema: START_RECEIPT_SCHEMA_V2,
    source: AUTO_CLAIM_RECEIPT_SOURCE,
  });
  assert.equal(validateStartReceipt(claimed).ok, true, JSON.stringify(validateStartReceipt(claimed).problems));
  assert.deepEqual(Object.keys(claimed).slice(-1), ['grantId']);
  assert.equal(validateStartReceipt({ ...claimed, grantId: undefined }).ok, false);
  assert.equal(validateStartReceipt({ ...claimed, grantId: 'not-a-uuid' }).ok, false);
  assert.equal(validateStartReceipt({ ...claimed, source: 'explicit-user-request' }).problems
    .some((problem) => problem.code === 'RECEIPT_SOURCE_INVALID'), true);
  assert.equal(validateStartReceipt({ ...claimed, schema: 'vibe-harness.linear-execution/v1' }).problems
    .some((problem) => problem.code === 'RECEIPT_SOURCE_INVALID'), true);
  assert.equal(validateStartReceipt(receipt()).ok, true);
});

test('ledger checks auto-claim and v1 executions for the same Issue together', () => {
  const claimed = buildStartReceipt({
    agentKey: 'codex',
    dagNodeIssue: 'ENG-123',
    executionId: EXECUTION_B,
    grantId: GRANT_A,
    hostKind: 'codex-desktop',
    schema: START_RECEIPT_SCHEMA_V2,
    source: AUTO_CLAIM_RECEIPT_SOURCE,
  });
  assert.equal(analyzeReceiptLedger([claimed]).ok, true);
  assert.deepEqual(analyzeReceiptLedger([claimed, event({ executionId: EXECUTION_B })]).activeExecutions, []);
  assert.equal(analyzeReceiptLedger([claimed, claimed]).duplicateCount, 1);
  assert.equal(analyzeReceiptLedger([claimed, { ...claimed, grantId: '99999999-8888-4777-8666-555555555555' }]).conflicts
    .some((item) => item.code === 'RECEIPT_ID_CONFLICT'), true);
  const conflict = analyzeReceiptLedger([receipt(), claimed]);
  assert.equal(conflict.conflicts.some((item) => item.code === 'RECEIPT_MULTIPLE_ACTIVE_EXECUTIONS'), true);
  assert.deepEqual(conflict.activeByIssue, { 'ENG-123': [EXECUTION_A, EXECUTION_B] });
});

test('receipt CLI emits v2 only with an explicit auto-claim source and grant ID', async () => {
  const args = ['start', '--issue', 'ENG-123', '--agent', 'codex', '--host', 'codex-desktop'];
  const claimed = await runCli([...args, '--source', AUTO_CLAIM_RECEIPT_SOURCE, '--grant-id', GRANT_A]);
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.equal(JSON.parse(claimed.stdout).schema, START_RECEIPT_SCHEMA_V2);
  assert.equal(JSON.parse(claimed.stdout).grantId, GRANT_A);
  assert.equal((await runCli([...args, '--source', AUTO_CLAIM_RECEIPT_SOURCE])).code, 1);
  assert.equal((await runCli([...args, '--grant-id', GRANT_A])).code, 1);
});
