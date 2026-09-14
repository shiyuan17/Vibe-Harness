#!/usr/bin/env node
// Execution Envelope CLI.
//
// `plan` assembles a draft from the current workspace identity so nobody has to
// hand-copy canonical cwd, Git directories, branch or frozen SHAs; `check`
// validates an envelope against the published schema, the runtime parser and
// the current workspace. Both subcommands are read-only unless `--write` names
// an explicit `--out` path. The host-owned proof (sessionId, requestId,
// hostContext) is never invented here.
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildEnvelopeDraft,
  checkEnvelope,
  summarizeEnvelopeCheck,
  summarizeEnvelopePlan,
} from './lib/envelope-records.js';
import { readJson } from './lib/manifest.js';
import { safeJsonParse } from './lib/safe-json.js';

const ENVIRONMENTS = ['local', 'test', 'staging', 'production', 'remote'];
const PLANNED_OPTIONS = new Set(['--mode', '--version', '--issue', '--effect', '--forbid', '--objective', '--terminal', '--risk', '--base-ref', '--write-root', '--external-target', '--host-context', '--request-id', '--session-id', '--expires-at', '--cwd', '--emit', '--out']);

function printUsage() {
  console.log('Usage: node scripts/envelope.js plan [options]');
  console.log('       node scripts/envelope.js check --file <envelope.json> [--cwd <path>] [--json]');
  console.log();
  console.log('plan  Build an Execution Envelope draft from the current workspace (read-only).');
  console.log('  --mode <mode>                inspect (default) | plan | linear-sync | execute | monitor');
  console.log('  --version <1|2>              envelope version; 2 (default) is required for high risk');
  console.log('  --issue <ISSUE-ID>           target Issue, repeatable');
  console.log('  --effect <effect>            allowed effect, repeatable; default is none');
  console.log('  --forbid <effect>            forbidden effect, repeatable');
  console.log('  --objective <text>           activeObjective');
  console.log('  --terminal <text>            terminalCondition');
  console.log('  --risk <standard|high>       default standard');
  console.log('  --base-ref <ref>             frozen target ref; default origin/develop');
  console.log('  --write-root <path>          allowed write root, repeatable; default worktree root');
  console.log('  --external-target <kind:id:environment>   repeatable');
  console.log('  --host-context <file>        host-provided hostContext JSON; never generated here');
  console.log('  --request-id <id> --session-id <id>       host-owned identifiers');
  console.log('  --expires-at <RFC3339Z>      optional expiry');
  console.log('  --cwd <path>                 workspace to freeze; default the current directory');
  console.log('  --emit <receipt|envelope>    print the plan receipt (default) or the bare envelope');
  console.log('  --out <path> [--write]       write the selected object to a file');
  console.log('  --json                       print the complete plan');
  console.log();
  console.log('check Validate an envelope against the schema, the runtime parser and the current workspace.');
  console.log('  --file <path> | --stdin      envelope JSON; one of them is required');
}

function usageError(message) {
  console.error(`envelope: ${message}`);
  printUsage();
  process.exit(1);
}

function takeValue(argv, index, token) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) usageError(`${token} requires a value`);
  return value;
}

function parseExternalTarget(value) {
  const segments = value.split(':');
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    usageError(`--external-target expects <kind:id:environment>, received ${value}`);
  }
  const [kind, id, environment] = segments;
  if (!ENVIRONMENTS.includes(environment)) {
    usageError(`--external-target environment must be one of ${ENVIRONMENTS.join(', ')}, received ${environment}`);
  }
  return { environment, id, kind };
}

/** Parse the `plan` argument vector into build options. */
export function parsePlanArgs(argv) {
  const options = {
    allowedEffects: [],
    allowedWriteRoots: [],
    baseRef: undefined,
    cwd: process.cwd(),
    emit: 'receipt',
    expiresAt: null,
    externalTargets: [],
    forbiddenEffects: [],
    hostContextPath: null,
    json: false,
    mode: undefined,
    out: null,
    requestId: null,
    riskClass: undefined,
    sessionId: null,
    targetIssueIds: [],
    terminalCondition: undefined,
    activeObjective: undefined,
    version: undefined,
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--write') { options.write = true; continue; }
    if (token === '--json') { options.json = true; continue; }
    if (token === '--help' || token === '-h') { printUsage(); process.exit(0); }
    if (!PLANNED_OPTIONS.has(token)) usageError(`unknown argument: ${token}`);
    const value = takeValue(argv, index, token);
    index += 1;
    if (token === '--mode') options.mode = value;
    else if (token === '--version') options.version = Number(value);
    else if (token === '--issue') options.targetIssueIds.push(value);
    else if (token === '--effect') options.allowedEffects.push(value);
    else if (token === '--forbid') options.forbiddenEffects.push(value);
    else if (token === '--objective') options.activeObjective = value;
    else if (token === '--terminal') options.terminalCondition = value;
    else if (token === '--risk') options.riskClass = value;
    else if (token === '--base-ref') options.baseRef = value;
    else if (token === '--write-root') options.allowedWriteRoots.push(value);
    else if (token === '--external-target') options.externalTargets.push(parseExternalTarget(value));
    else if (token === '--host-context') options.hostContextPath = value;
    else if (token === '--request-id') options.requestId = value;
    else if (token === '--session-id') options.sessionId = value;
    else if (token === '--expires-at') options.expiresAt = value;
    else if (token === '--cwd') options.cwd = value;
    else if (token === '--emit') options.emit = value;
    else options.out = value;
  }
  if (!['receipt', 'envelope'].includes(options.emit)) usageError(`--emit must be receipt or envelope, received ${options.emit}`);
  if (![1, 2].includes(options.version ?? 2)) usageError(`--version must be 1 or 2, received ${options.version}`);
  if (options.write && options.out === null) usageError('--write requires --out <path>');
  return options;
}

/** Parse the `check` argument vector. */
export function parseCheckArgs(argv) {
  const options = { cwd: process.cwd(), file: null, json: false, stdin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--stdin') { options.stdin = true; continue; }
    if (token === '--json') { options.json = true; continue; }
    if (token === '--help' || token === '-h') { printUsage(); process.exit(0); }
    if (!['--file', '--cwd'].includes(token)) usageError(`unknown argument: ${token}`);
    const value = takeValue(argv, index, token);
    index += 1;
    if (token === '--file') options.file = value;
    else options.cwd = value;
  }
  if (options.file === null && !options.stdin) usageError('check requires --file <path> or --stdin');
  if (options.file !== null && options.stdin) usageError('check accepts either --file or --stdin, not both');
  return options;
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

async function readJsonFile(filePath, label) {
  try {
    return await readJson(path.resolve(filePath));
  } catch (error) {
    usageError(`${label} ${filePath} is not readable JSON: ${error.message}`);
    return null;
  }
}

async function readEnvelopeInput(options) {
  if (!options.stdin) return readJsonFile(options.file, '--file');
  try {
    return safeJsonParse(readStdin());
  } catch (error) {
    usageError(`stdin is not valid JSON: ${error.message}`);
    return null;
  }
}

async function runPlan(argv) {
  const options = parsePlanArgs(argv);
  const hostContext = options.hostContextPath === null ? null : await readJsonFile(options.hostContextPath, '--host-context');
  const plan = buildEnvelopeDraft({
    activeObjective: options.activeObjective,
    allowedEffects: options.allowedEffects,
    allowedWriteRoots: options.allowedWriteRoots,
    ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
    cwd: path.resolve(options.cwd),
    externalTargets: options.externalTargets,
    expiresAt: options.expiresAt,
    forbiddenEffects: options.forbiddenEffects,
    hostContext,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    requestId: options.requestId,
    ...(options.riskClass === undefined ? {} : { riskClass: options.riskClass }),
    sessionId: options.sessionId,
    targetIssueIds: options.targetIssueIds,
    ...(options.terminalCondition === undefined ? {} : { terminalCondition: options.terminalCondition }),
    ...(options.version === undefined ? {} : { version: options.version }),
  });
  const receipt = {
    command: 'envelope plan',
    enforcementGrade: plan.enforcementGrade,
    envelope: plan.envelope,
    generatedAt: new Date().toISOString(),
    hostInjectedFields: plan.hostInjectedFields,
    hostProof: plan.hostProof,
    modeCeiling: plan.modeCeiling,
    ok: !plan.problems.some((problem) => problem.severity === 'error'),
    problems: plan.problems,
    schemaVersion: 1,
    valid: plan.valid,
    version: plan.version,
  };
  if (options.write) {
    const target = options.emit === 'envelope' ? plan.envelope : receipt;
    await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(target, null, 2)}\n`, 'utf8');
  }
  if (options.json || options.emit === 'envelope') {
    console.log(JSON.stringify(options.emit === 'envelope' ? plan.envelope : receipt, null, 2));
  } else {
    console.log(summarizeEnvelopePlan(plan));
    if (!plan.valid) console.log('next: inject the host-owned fields, then run: pnpm envelope check --file <path>');
  }
  if (!receipt.ok) process.exitCode = 1;
}

async function runCheck(argv) {
  const options = parseCheckArgs(argv);
  const value = await readEnvelopeInput(options);
  const check = checkEnvelope(value, { cwd: path.resolve(options.cwd) });
  if (options.json) console.log(JSON.stringify(check, null, 2));
  else console.log(summarizeEnvelopeCheck(check));
  if (!check.ok) process.exitCode = 1;
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') { printUsage(); return; }
  if (subcommand === 'plan') return runPlan(rest);
  if (subcommand === 'check') return runCheck(rest);
  usageError(`unknown subcommand: ${subcommand}`);
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
