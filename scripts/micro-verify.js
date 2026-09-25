#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readProjectConfig } from './lib/project-config.js';
import { normalizeMicroChecks } from './lib/verification-contract.js';
import { createProjectSnapshot } from './lib/project-verification.js';
import { executeStructuredMicro, microFingerprint, redactMicro } from './lib/micro-runner.js';

const CONTROL = /(?:&&|\|\||[;|&<>`$])|\$\(/u;
const INLINE_EVAL = /^(?:node|node\.exe)\s+(?:-e|--eval|-p|--print)\b/iu;
const NETWORK_OR_MUTATION = /(?:^|\/)(?:curl|wget|invoke-webrequest|irm|git|ssh|scp|nc|netcat)(?:\.exe)?$/iu;
const MUTATING_TOKEN = /^(?:--(?:write|force|fix|apply|install|update|delete|remove|clean)|(?:install|uninstall|publish|add|remove|prune|clean|rm|mv|cp|touch))$/iu;
const SECRET = /((?:api[-_]?key|authorization|token|password|secret|cookie)\s*[=:]\s*)[^\s,;]+/giu;

export function splitMicroCommand(command) {
  const tokens = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/gu)) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  const program = tokens[0] ?? '';
  if (tokens.length === 0
    || tokens.some((token) => CONTROL.test(token) || MUTATING_TOKEN.test(token))
    || INLINE_EVAL.test(command)
    || NETWORK_OR_MUTATION.test(program)) {
    const error = Object.assign(new Error('Micro command contains shell metacharacters or is empty.'), {
      code: 'MICRO_UNSAFE_COMMAND',
    });
    throw error;
  }
  return tokens;
}

function redact(value, limit) {
  return String(value ?? '').replace(SECRET, '$1[REDACTED]').slice(0, limit);
}

function parseArgs(argv) {
  const result = { id: null, json: false, run: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') result.json = true;
    else if (token === '--run') result.run = true;
    else if (token === '--id') result.id = argv[++index] ?? null;
    else if (token === '--help' || token === '-h') result.help = true;
    else throw new Error(`Unknown option: ${token}`);
  }
  return result;
}

function execute(check, targetDir) {
  if (!check.legacy) return executeStructured(check, targetDir);
  const tokens = splitMicroCommand(check.command);
  let [program, ...args] = tokens;
  if (process.platform === 'win32' && ['pnpm', 'npm', 'yarn'].includes(program)) {
    args = ['/d', '/s', '/c', [program, ...args].join(' ')];
    program = 'cmd.exe';
  }
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(program, args, { cwd: targetDir, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const append = (key, chunk) => {
      const value = String(chunk);
      const limit = check.outputLimit;
      if (key === 'stdout') stdout = (stdout + value).slice(-limit);
      else stderr = (stderr + value).slice(-limit);
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        status: 'blocked',
        code: 'MICRO_TIMEOUT',
        durationMs: Date.now() - startedAt,
        stdout: redact(stdout, check.outputLimit),
        stderr: redact(stderr, check.outputLimit),
      });
    }, check.maxDurationMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 'blocked', code: 'MICRO_EXECUTION_ERROR', error: redact(error.message, check.outputLimit), durationMs: Date.now() - startedAt });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        status: exitCode === 0 ? 'passed' : 'failed',
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        stdout: redact(stdout, check.outputLimit),
        stderr: redact(stderr, check.outputLimit),
      });
    });
  });
}

async function executeStructured(check, targetDir) {
  const before = await createProjectSnapshot(targetDir);
  /** @type {any} */
  const result = await executeStructuredMicro(check, targetDir, { snapshotBefore: before });
  const after = await createProjectSnapshot(targetDir);
  result.snapshotComparison = before.available && after.available
    ? before.fingerprint === after.fingerprint ? 'match' : 'changed'
    : 'unavailable';
  if (result.status === 'passed' && result.snapshotComparison !== 'match') result.status = 'blocked';
  result.configFingerprint = microFingerprint(check);
  result.fixtureFingerprint = microFingerprint(check.args?.fixture ?? null);
  result.toolchainFingerprint = microFingerprint({ node: process.version, platform: process.platform });
  result.cache = { status: 'miss', key: microFingerprint({ check, workspace: before.fingerprint }) };
  return result;
}

function printUsage() {
  console.log('Usage: pnpm verify:micro --id <check-id> [--run] [--json]');
}

export async function main(argv = process.argv.slice(2), targetDir = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) return printUsage();
  const config = await readProjectConfig(targetDir);
  const checks = normalizeMicroChecks(config.validationCommands?.micro);
  /** @type {any[]} */
  const selected = args.id ? checks.filter((item) => item.id === args.id) : checks;
  if (args.id && selected.length === 0) throw new Error(`Unknown micro check: ${args.id}`);
  const receipt = {
    schemaVersion: 1,
    id: randomUUID(),
    command: 'verify:micro',
    status: args.run ? 'running' : 'planned',
    checks: {},
    startedAt: new Date().toISOString(),
    environment: { status: config.verification?.environment?.mode ?? 'cold' },
  };
  if (!args.run) {
    for (const check of selected) receipt.checks[check.id] = { status: 'planned', checkId: check.id, command: check.command, entry: check.entry, deterministic: check.deterministic };
  } else {
    for (const check of selected) {
      receipt.checks[check.id] = { ...await execute(check, targetDir), command: check.command, entry: check.entry, deterministic: check.deterministic };
      if (receipt.checks[check.id].status !== 'passed') receipt.status = receipt.checks[check.id].status;
    }
    if (receipt.status === 'running') receipt.status = 'passed';
  }
  receipt.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(receipt, null, args.json ? 2 : 0));
  if (args.run && receipt.status !== 'passed') process.exitCode = 1;
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
