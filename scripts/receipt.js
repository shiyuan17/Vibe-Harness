#!/usr/bin/env node
// Linear execution receipt CLI.
//
// Builds the immutable structured comments defined by
// skills/integrations/linear-workflow/references/execution-receipt.md:
// `start` generates a Start Receipt with fresh run identifiers, `event` builds
// a Terminal Event, `handoff` builds the Handoff Completion Payload, and
// `check` analyses an Issue's comment history for protocol conflicts. Posting
// to Linear stays with the caller; nothing here writes to a provider.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readJson } from './lib/manifest.js';
import {
  analyzeReceiptLedger,
  buildHandoffPayload,
  buildStartReceipt,
  buildTerminalEvent,
  HANDOFF_STATUSES,
  RECEIPT_SOURCES,
  summarizeReceiptLedger,
  TERMINAL_EVENT_TYPES,
  validateHandoffPayload,
  validateStartReceipt,
  validateTerminalEvent,
} from './lib/receipt-records.js';
import { safeJsonParse } from './lib/safe-json.js';

const VALUE_OPTIONS = new Set([
  '--agent', '--dag-root', '--delegate', '--event-id', '--execution-id', '--file', '--final-check',
  '--final-check-relevance', '--final-check-status', '--handoff', '--host', '--issue', '--occurred-at', '--out',
  '--role', '--runtime-instance-id', '--source', '--started-at', '--status', '--successor', '--type', '--unresolved',
]);

function printUsage() {
  console.log('Usage: node scripts/receipt.js start --issue <ID> --agent <key> --host <kind> [options]');
  console.log('       node scripts/receipt.js event --execution-id <uuid> --type <eventType> [options]');
  console.log('       node scripts/receipt.js handoff --status <status> [options]');
  console.log('       node scripts/receipt.js check --file <comments.json> [--issue <ID>] [--json]');
  console.log();
  console.log('Every subcommand is read-only unless --write names an explicit --out path, and none of them');
  console.log('posts to Linear: the caller does that and re-reads the field values afterwards.');
  console.log();
  console.log('start   Build a Start Receipt (vibe-harness.linear-execution/v1).');
  console.log('  --issue <ID>                 current Issue (dagNodeIssue); required');
  console.log('  --agent <key> --host <kind>  stable product keys, e.g. codex / codex-desktop; required');
  console.log(`  --source <value>             ${RECEIPT_SOURCES.join(' | ')} (default explicit-user-request)`);
  console.log('  --delegate <id>              native Delegate/App User id; omit or null for fallback labels');
  console.log('  --dag-root <ID>              top-level parent Issue; omit for a standalone Issue');
  console.log('  --execution-id <uuid> --runtime-instance-id <uuid> --started-at <RFC3339Z>');
  console.log('                               generated fresh when omitted');
  console.log();
  console.log('event   Build a Terminal Event (vibe-harness.linear-execution-event/v1).');
  console.log('  --execution-id <uuid>        the run being terminated; required');
  console.log(`  --type <eventType>           ${TERMINAL_EVENT_TYPES.join(' | ')}; required`);
  console.log('  --successor <uuid>           required for handed-off (or use --generate-successor)');
  console.log('  --handoff <file>             handoff payload JSON to embed; handed-off only');
  console.log('  --event-id <uuid> --occurred-at <RFC3339Z>');
  console.log();
  console.log('handoff Build a Handoff Completion Payload (vibe-harness.handoff/v1).');
  console.log(`  --status <status>            ${HANDOFF_STATUSES.join(' | ')} (default in-progress)`);
  console.log('  --accepted                   only with --status complete and a passed final check');
  console.log('  --final-check <receiptId>    verification receipt the final check referenced');
  console.log('  --final-check-relevance <v>  reviewed (default)');
  console.log('  --final-check-status <v>     passed (default)');
  console.log('  --unresolved <id|summary|owner>   repeatable; empty owner is rejected');
  console.log();
  console.log('check   Analyse one Issue comment history for execution conflicts.');
  console.log('  --file <path> | --stdin      comments in posted order, or {issue, comments}');
  console.log('  --issue <ID>                 assert every receipt targets this Issue');
  console.log('  --json                       print the complete analysis');
  console.log();
  console.log('Shared: --out <path> [--write] [--json]');
}

function usageError(message) {
  console.error(`receipt: ${message}`);
  printUsage();
  process.exit(1);
}

function parseArgs(argv, { allowGenerateSuccessor = false } = {}) {
  const options = { json: false, out: null, write: false, values: new Map(), lists: new Map() };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--write') { options.write = true; continue; }
    if (token === '--json') { options.json = true; continue; }
    if (token === '--stdin') { options.values.set('--stdin', true); continue; }
    if (token === '--accepted') { options.values.set('--accepted', true); continue; }
    if (token === '--not-accepted') { options.values.set('--accepted', false); continue; }
    if (allowGenerateSuccessor && token === '--generate-successor') { options.values.set('--generate-successor', true); continue; }
    if (token === '--help' || token === '-h') { printUsage(); process.exit(0); }
    if (!VALUE_OPTIONS.has(token)) usageError(`unknown argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) usageError(`${token} requires a value`);
    index += 1;
    if (token === '--unresolved') options.lists.set(token, [...(options.lists.get(token) ?? []), value]);
    else options.values.set(token, value);
  }
  options.out = options.values.get('--out') ?? null;
  if (options.write && options.out === null) usageError('--write requires --out <path>');
  return options;
}

function requireValue(options, token, label = token) {
  const value = options.values.get(token);
  if (value === undefined) usageError(`${label} is required`);
  return value;
}

async function readJsonFile(filePath, label) {
  try {
    return await readJson(path.resolve(filePath));
  } catch (error) {
    usageError(`${label} ${filePath} is not readable JSON: ${error.message}`);
    return null;
  }
}

async function emit(record, validation, options, { label }) {
  for (const problem of validation.problems) {
    const stream = problem.severity === 'error' ? process.stderr : process.stdout;
    stream.write(`${label} ${problem.severity}: ${problem.code} ${problem.message}\n`);
  }
  if (!validation.ok) {
    process.stderr.write(`${label}: refused to emit an invalid record\n`);
    process.exitCode = 1;
    return;
  }
  if (options.write) {
    await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }
  if (options.json || !options.write) console.log(JSON.stringify(record, null, 2));
  else console.log(`wrote ${label} to ${options.out}`);
}

function parseUnresolved(items = []) {
  return items.map((item) => {
    const segments = item.split('|').map((segment) => segment.trim());
    if (segments.length !== 3) usageError(`--unresolved expects <id|summary|owner>, received ${item}`);
    const [id, summary, owner] = segments;
    return { id, owner, summary };
  });
}

async function runStart(argv) {
  const options = parseArgs(argv);
  const receipt = buildStartReceipt({
    agentKey: requireValue(options, '--agent', '--agent <key>'),
    ...(options.values.get('--dag-root') === undefined ? {} : { dagRootIssue: options.values.get('--dag-root') }),
    ...(options.values.get('--delegate') === undefined ? {} : { delegateId: options.values.get('--delegate') }),
    dagNodeIssue: requireValue(options, '--issue', '--issue <ISSUE-ID>'),
    ...(options.values.get('--execution-id') === undefined ? {} : { executionId: options.values.get('--execution-id') }),
    hostKind: requireValue(options, '--host', '--host <kind>'),
    ...(options.values.get('--role') === undefined ? {} : { role: options.values.get('--role') }),
    ...(options.values.get('--runtime-instance-id') === undefined ? {} : { runtimeInstanceId: options.values.get('--runtime-instance-id') }),
    ...(options.values.get('--source') === undefined ? {} : { source: options.values.get('--source') }),
    ...(options.values.get('--started-at') === undefined ? {} : { startedAt: options.values.get('--started-at') }),
  });
  await emit(receipt, validateStartReceipt(receipt), options, { label: 'start receipt' });
}

async function runEvent(argv) {
  const options = parseArgs(argv, { allowGenerateSuccessor: true });
  const eventType = requireValue(options, '--type', '--type <eventType>');
  const successor = options.values.get('--successor');
  if (successor !== undefined && eventType !== 'handed-off') usageError('--successor is only valid with --type handed-off');
  const generate = options.values.get('--generate-successor') === true;
  if (generate && successor !== undefined) usageError('--generate-successor cannot be combined with --successor');
  if (eventType === 'handed-off' && successor === undefined && !generate) {
    usageError('--type handed-off requires --successor <uuid> or --generate-successor');
  }
  const handoffPath = options.values.get('--handoff');
  const handoff = handoffPath === undefined ? null : await readJsonFile(handoffPath, '--handoff');
  if (handoff !== null && eventType !== 'handed-off') usageError('--handoff is only valid with --type handed-off');
  let event;
  try {
    event = buildTerminalEvent({
      ...(options.values.get('--event-id') === undefined ? {} : { eventId: options.values.get('--event-id') }),
      executionId: requireValue(options, '--execution-id', '--execution-id <uuid>'),
      eventType,
      handoff,
      ...(options.values.get('--occurred-at') === undefined ? {} : { occurredAt: options.values.get('--occurred-at') }),
      successorExecutionId: successor ?? (generate ? randomUUID() : null),
    });
  } catch (error) {
    usageError(error.message);
  }
  await emit(event, validateTerminalEvent(event), options, { label: 'terminal event' });
  if (generate && event.eventType === 'handed-off') {
    process.stderr.write(`successor executionId: ${event.successorExecutionId}\n`);
  }
}

async function runHandoff(argv) {
  const options = parseArgs(argv);
  const accepted = options.values.get('--accepted') === true;
  const status = options.values.get('--status') ?? 'in-progress';
  const payload = buildHandoffPayload({
    accepted,
    ...(options.values.get('--final-check') === undefined ? {} : { finalCheckReceiptId: options.values.get('--final-check') }),
    ...(options.values.get('--final-check-relevance') === undefined ? {} : { finalCheckRelevance: options.values.get('--final-check-relevance') }),
    ...(options.values.get('--final-check-status') === undefined ? {} : { finalCheckStatus: options.values.get('--final-check-status') }),
    status,
    unresolvedItems: parseUnresolved(options.lists.get('--unresolved')),
  });
  await emit(payload, validateHandoffPayload(payload), options, { label: 'handoff payload' });
}

async function runCheck(argv) {
  const options = parseArgs(argv);
  const file = options.values.get('--file');
  const stdin = options.values.get('--stdin') === true;
  if (file === undefined && !stdin) usageError('check requires --file <path> or --stdin');
  if (file !== undefined && stdin) usageError('check accepts either --file or --stdin, not both');
  let ledger;
  if (stdin) {
    try {
      ledger = safeJsonParse(readFileSync(0, 'utf8'));
    } catch (error) {
      usageError(`stdin is not valid JSON: ${error.message}`);
    }
  } else {
    ledger = await readJsonFile(file, '--file');
  }
  const analysis = analyzeReceiptLedger(ledger, { issue: options.values.get('--issue') ?? null });
  if (options.json) console.log(JSON.stringify(analysis, null, 2));
  else console.log(summarizeReceiptLedger(analysis));
  if (!analysis.ok) process.exitCode = 1;
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') { printUsage(); return; }
  if (subcommand === 'start') return runStart(rest);
  if (subcommand === 'event') return runEvent(rest);
  if (subcommand === 'handoff') return runHandoff(rest);
  if (subcommand === 'check') return runCheck(rest);
  usageError(`unknown subcommand: ${subcommand}`);
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
