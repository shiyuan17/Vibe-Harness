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
  buildVerifiedClaimReceipt,
  buildTerminalEvent,
  handoffClaimsComplete,
  scanSensitiveFields,
  summarizeReceiptLedger,
  START_RECEIPT_SCHEMA,
  START_RECEIPT_SCHEMA_V2,
  START_RECEIPT_SCHEMA_V3,
  validateHandoffPayload,
  validateStartReceipt,
  validateTerminalEvent,
} from '../../scripts/lib/receipt-records.js';
import { atomicClaim, createClaimRequest, releaseClaim, renewClaim, verifyProviderClaim } from '../../scripts/lib/linear-claim.js';
import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const RECEIPT_CLI = path.join(repositoryRoot, 'scripts', 'receipt.js');

const EXECUTION_A = '11111111-2222-4333-8444-555555555555';
const EXECUTION_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const EVENT_A = '99999999-8888-4777-8666-555555555555';
const GRANT_A = '12345678-1234-4234-8234-123456789abc';
const CLAIM_A = '22222222-3333-4333-8444-555555555555';

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

// Historical comments remain readable; this fixture is deliberately not a
// signing API and bypasses no provider check for a live execution.
function historicalReceipt({ schema, source, grantId, claimId, leaseExpiresAt, fencingToken, claimProvider, ...core }) {
  return {
    ...buildStartReceipt(core),
    schema, source: source ?? 'explicit-user-request',
    ...(grantId === undefined ? {} : { grantId }),
    ...(claimId === undefined ? {} : { claimId, leaseExpiresAt, fencingToken, claimProvider }),
  };
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
  const claimed = historicalReceipt({
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
  const claimed = historicalReceipt({
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

test('receipt CLI generates only v1; user-supplied Claim fields cannot mint a v3 Receipt', async () => {
  const args = ['start', '--issue', 'ENG-123', '--agent', 'codex', '--host', 'codex-desktop'];
  const explicit = await runCli([...args, '--source', 'explicit-user-request']);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).schema, START_RECEIPT_SCHEMA);
  assert.equal(JSON.parse(explicit.stdout).source, 'explicit-user-request');
  assert.equal(Object.hasOwn(JSON.parse(explicit.stdout), 'claimId'), false);
  assert.equal((await runCli([...args, '--source', AUTO_CLAIM_RECEIPT_SOURCE, '--grant-id', GRANT_A])).code, 1);
  assert.equal((await runCli([...args, '--source', AUTO_CLAIM_RECEIPT_SOURCE])).code, 1);
  assert.equal((await runCli([...args, '--claim-id', CLAIM_A])).code, 1);

  const explicitClaim = await runCli([
    ...args,
    '--source', 'explicit-user-request',
    '--claim-id', CLAIM_A,
    '--lease-expires-at', '2999-01-01T00:00:00.000Z',
    '--fencing-token', 'fence-explicit',
    '--claim-provider', 'linear-host-provider',
  ]);
  assert.equal(explicitClaim.code, 1);
  assert.match(explicitClaim.stderr, /trusted host provider/u);

  const claimed = await runCli([
    ...args,
    '--source', AUTO_CLAIM_RECEIPT_SOURCE,
    '--grant-id', GRANT_A,
    '--claim-id', CLAIM_A,
    '--lease-expires-at', '2999-01-01T00:00:00.000Z',
    '--fencing-token', 'fence-17',
    '--claim-provider', 'linear-host-provider',
  ]);
  assert.equal(claimed.code, 1);
  assert.match(claimed.stderr, /trusted host provider/u);
  assert.equal((await runCli([...args, '--grant-id', GRANT_A])).code, 1);
});

test('v3 receipts preserve legacy reads and require atomic claim metadata', async () => {
  const schema = JSON.parse(await readFile(path.join(repositoryRoot, 'schemas/linear-execution-v3.schema.json'), 'utf8'));
  const claimed = historicalReceipt({
    agentKey: 'codex',
    dagNodeIssue: 'ENG-123',
    hostKind: 'codex-desktop',
    schema: START_RECEIPT_SCHEMA_V3,
    claimId: CLAIM_A,
    startedAt: '2026-09-27T10:00:00.000Z',
    leaseExpiresAt: '2026-09-27T11:00:00.000Z',
    fencingToken: 'fence-a',
    claimProvider: 'linear-provider',
  });
  assert.equal(validateStartReceipt(claimed).ok, true, JSON.stringify(validateStartReceipt(claimed).problems));
  const autoClaimBranch = schema.oneOf.find((branch) => branch.properties?.source?.const === AUTO_CLAIM_RECEIPT_SOURCE);
  assert.deepEqual(autoClaimBranch?.required, ['grantId']);
  assert.equal(analyzeReceiptLedger([claimed]).activeExecutions.length, 1);
  assert.equal(analyzeReceiptLedger([claimed]).status, 'incomplete');
  assert.equal(analyzeReceiptLedger([claimed]).pendings.some((entry) => entry.code === 'RECEIPT_CLAIM_UNVERIFIED'), true);
  const activeLedger = await mkdtemp(path.join(tmpdir(), 'receipt-unverified-'));
  try {
    const ledgerFile = path.join(activeLedger, 'comments.json');
    await writeFile(ledgerFile, `${JSON.stringify([claimed])}\n`);
    const check = await runCli(['check', '--file', ledgerFile, '--json']);
    assert.equal(check.code, 1);
    assert.equal(JSON.parse(check.stdout).status, 'incomplete');
  } finally {
    await removeTemporaryDirectory(activeLedger);
  }
  assert.equal(validateStartReceipt({ ...claimed, claimId: undefined }).ok, false);
  assert.equal(validateStartReceipt({ ...claimed, claimId: 'not-a-uuid' }).ok, false);
  assert.equal(validateStartReceipt({ ...claimed, leaseExpiresAt: '2026-09-27T19:00:00+08:00' }).ok, false);
  assert.equal(validateStartReceipt({ ...claimed, fencingToken: null }).ok, false);
  assert.equal(validateStartReceipt({ ...claimed, claimProvider: null }).ok, false);
  assert.equal(validateStartReceipt({ ...claimed, fencingToken: 'x'.repeat(257) }).ok, false);
  assert.equal(validateStartReceipt({ ...claimed, claimProvider: 'x'.repeat(129) }).ok, false);
  assert.equal(validateStartReceipt({
    ...claimed,
    leaseExpiresAt: '2026-09-27T09:00:00.000Z',
  }).ok, false);
  assert.equal(validateStartReceipt({
    ...claimed,
    startedAt: '2026-02-01T10:00:00.000Z',
    leaseExpiresAt: '2026-02-31T11:00:00.000Z',
  }).ok, false);
  const autoClaimed = {
    ...claimed,
    grantId: GRANT_A,
    source: AUTO_CLAIM_RECEIPT_SOURCE,
  };
  assert.equal(validateStartReceipt(autoClaimed).ok, true, JSON.stringify(validateStartReceipt(autoClaimed).problems));
  assert.equal(analyzeReceiptLedger([autoClaimed]).activeExecutions.length, 1);
  assert.equal(validateStartReceipt({ ...autoClaimed, grantId: undefined }).ok, false);
  assert.equal(validateStartReceipt({
    ...autoClaimed,
    schema: 'vibe-harness.linear-execution/v1',
  }).ok, false);
});

test('a v3 execution requires an authoritative host lookup, not a comment or user JSON', async () => {
  const request = createClaimRequest({
    issueId: 'ENG-123',
    executionId: EXECUTION_A,
    claimId: CLAIM_A,
    idempotencyKey: 'host-key',
    leaseExpiresAt: '2026-09-27T11:00:00.000Z',
    fencingToken: 'fence-a',
  });
  const now = new Date('2026-09-27T10:00:00.000Z');
  const claim = atomicClaim(null, request, { capabilities: { atomicClaim: true, fencing: true }, now }).claim;
  const receiptFields = {
    agentKey: 'codex', dagNodeIssue: 'ENG-123', executionId: EXECUTION_A,
    hostKind: 'codex-desktop', schema: START_RECEIPT_SCHEMA_V3,
    claimId: CLAIM_A, leaseExpiresAt: request.leaseExpiresAt,
    fencingToken: request.fencingToken, claimProvider: 'host-atomic',
    startedAt: now.toISOString(),
  };
  const provider = {
    name: 'host-atomic',
    capabilities: { atomicClaim: true, fencing: true },
    readClaim: async () => claim,
  };
  assert.throws(() => buildStartReceipt(receiptFields), /authoritative host provider/u);
  const receiptRecord = await buildVerifiedClaimReceipt(receiptFields, provider, { idempotencyKey: 'host-key', now });
  assert.equal((await verifyProviderClaim(receiptRecord, provider, { idempotencyKey: 'host-key', now })).claimId, CLAIM_A);
  await assert.rejects(verifyProviderClaim(receiptRecord, null, { idempotencyKey: 'host-key', now }),
    { code: 'CLAIM_CAPABILITY_UNAVAILABLE' });
  await assert.rejects(verifyProviderClaim(receiptRecord, { ...provider, readClaim: async () => null },
    { idempotencyKey: 'host-key', now }), { code: 'CLAIM_CONFLICT' });
  await assert.rejects(verifyProviderClaim(receiptRecord, { ...provider, readClaim: async () => ({ ...claim, issueId: 'ENG-124' }) },
    { idempotencyKey: 'host-key', now }), { code: 'CLAIM_CONFLICT' });
  await assert.rejects(verifyProviderClaim(receiptRecord, provider,
    { idempotencyKey: 'wrong-key', now }), { code: 'CLAIM_CONFLICT' });
  await assert.rejects(verifyProviderClaim({ ...receiptRecord, fencingToken: '42' }, provider,
    { idempotencyKey: 'host-key', now }), { code: 'FENCING_MISMATCH' });
  await assert.rejects(verifyProviderClaim({ ...receiptRecord, leaseExpiresAt: '2026-09-27T19:00:00+08:00' }, provider,
    { idempotencyKey: 'host-key', now }), { code: 'LEASE_EXPIRED' });
  await assert.rejects(verifyProviderClaim(receiptRecord, provider,
    { idempotencyKey: 'host-key', now: new Date('2026-09-27T11:00:00.000Z') }), { code: 'LEASE_EXPIRED' });
});

test('atomic claim is provider-gated, idempotent, fenced, and lease-aware', () => {
  const capabilities = { atomicClaim: true, fencing: true };
  const request = createClaimRequest({
    issueId: 'ENG-123',
    executionId: EXECUTION_A,
    claimId: CLAIM_A,
    idempotencyKey: 'request-a',
    leaseExpiresAt: '2026-09-27T11:00:00.000Z',
    fencingToken: 'fence-a',
  });
  const now = new Date('2026-09-27T10:00:00.000Z');
  const first = atomicClaim(null, request, { capabilities, now });
  assert.equal(first.status, 'claimed');
  assert.equal(atomicClaim(first.claim, request, { capabilities, now }).status, 'idempotent');
  assert.throws(
    () => atomicClaim(first.claim, { ...request, fencingToken: 'fence-other' }, { capabilities, now }),
    (error) => error.code === 'CLAIM_CONFLICT' && /different claim contents/u.test(error.message),
  );
  assert.throws(
    () => createClaimRequest({
      issueId: 'ENG-123',
      executionId: EXECUTION_B,
      leaseExpiresAt: '2026-09-27T11:00:00.000Z',
    }),
    /claim request fencingToken is required/u,
  );
  assert.throws(
    () => createClaimRequest({
      issueId: 'ENG-123',
      executionId: EXECUTION_B,
      claimId: 'not-a-uuid',
      leaseExpiresAt: '2026-09-27T11:00:00.000Z',
      fencingToken: 'fence-b',
    }),
    /claimId must be UUID v4/u,
  );
  assert.throws(
    () => createClaimRequest({
      issueId: 'ENG-123',
      executionId: EXECUTION_B,
      leaseExpiresAt: '2026-09-27T11:00:00-05:00',
      fencingToken: 'fence-b',
    }),
    /leaseExpiresAt must be an RFC3339 UTC timestamp/u,
  );
  assert.throws(
    () => createClaimRequest({
      issueId: 'ENG-123',
      executionId: EXECUTION_B,
      leaseExpiresAt: '2026-02-31T11:00:00.000Z',
      fencingToken: 'fence-b',
    }),
    /leaseExpiresAt must be an RFC3339 UTC timestamp/u,
  );
  assert.throws(
    () => atomicClaim(null, { ...request, leaseExpiresAt: '2026-09-27T09:00:00.000Z' }, { capabilities, now }),
    /leaseExpiresAt must be in the future/u,
  );
  assert.throws(
    () => atomicClaim(first.claim, createClaimRequest({
      issueId: 'ENG-123',
      executionId: EXECUTION_B,
      idempotencyKey: 'request-b',
      leaseExpiresAt: '2026-09-27T11:00:00.000Z',
      fencingToken: 'fence-b',
    }), { capabilities, now }),
    /already has an active claim/u,
  );
  assert.equal(renewClaim(first.claim, {
    claimId: CLAIM_A,
    fencingToken: 'fence-a',
    leaseExpiresAt: '2026-09-27T12:00:00.000Z',
  }, { now }).status, 'renewed');
  assert.throws(
    () => renewClaim({ ...first.claim, leaseExpiresAt: 'not-a-timestamp' }, {
      claimId: CLAIM_A,
      fencingToken: 'fence-a',
      leaseExpiresAt: '2026-09-27T12:00:00.000Z',
    }, { now }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.throws(
    () => renewClaim(first.claim, {
      claimId: CLAIM_A,
      fencingToken: 'fence-a',
      leaseExpiresAt: '2026-09-27T12:00:00.000Z',
    }, { now: new Date('not-a-timestamp') }),
    (error) => error instanceof TypeError && /now must be a valid date/u.test(error.message),
  );
  assert.equal(releaseClaim(first.claim, request, { fencingToken: 'fence-a' }).status, 'released');
  assert.throws(
    () => atomicClaim(first.claim, request, { capabilities: {}, now }),
    /atomic claim and fencing/u,
  );
  const afterExpiry = new Date('2026-09-27T11:00:00.000Z');
  assert.throws(
    () => atomicClaim(first.claim, request, { capabilities, now: afterExpiry }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.throws(
    () => atomicClaim(first.claim, createClaimRequest({
      issueId: 'ENG-123',
      executionId: EXECUTION_B,
      idempotencyKey: 'request-b',
      leaseExpiresAt: '2026-09-27T12:00:00.000Z',
      fencingToken: 'fence-b',
    }), { capabilities, now: afterExpiry }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  // A lease that cannot be parsed is not "still active": every comparison
  // against `NaN` is false, so an unreconciled claim would otherwise fall
  // through to `claimed` and be replaced silently.
  assert.throws(
    () => atomicClaim({ ...first.claim, leaseExpiresAt: 'not-a-timestamp' }, request, { capabilities, now }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.throws(
    () => atomicClaim({ ...first.claim, leaseExpiresAt: '2026-09-27T12:00:00-05:00' }, request, { capabilities, now }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  // The same fail-closed rule applies to the clock the caller supplies.
  assert.throws(
    () => atomicClaim(null, request, { capabilities, now: new Date('not-a-timestamp') }),
    (error) => error instanceof TypeError && /now must be a valid date/u.test(error.message),
  );
});
