#!/usr/bin/env node
// Task DAG validator.
//
// Validates the lightweight Task DAG from docs/rules/ai-collab-rules.md before
// any write node is dispatched: node contract, dependency edges, cycles,
// writeScope conflicts, resource locks, the ready set and the structure hash a
// checkpoint records. The JSON field names match the human table in
// docs/templates/task.md, which stays a human record and is not parsed here.
//
// Invocation surface: `pnpm task-dag check|hash` — called on demand by the
// task-decomposition skill (`check --file <dag.json> [--require-ready]`) and
// the online canary scenarios. Nothing in the installed runtime calls it
// automatically; it stays an independent pre-dispatch validator.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readJson } from './lib/manifest.js';
import { safeJsonParse } from './lib/safe-json.js';
import { checkTaskDagNode, summarizeTaskDag, validateTaskDag } from './lib/task-dag.js';
import { taskParentBatchEvidence } from '../runtime/lib/task-command.mjs';

function printUsage() {
  console.log('Usage: node scripts/task-dag.js check --file <dag.json> [--node <id>] [--require-ready] [--json]');
  console.log('       node scripts/task-dag.js check --stdin [--require-ready] [--json]');
  console.log('       node scripts/task-dag.js hash --file <dag.json> [--json]');
  console.log();
  console.log('A DAG is {"schema": "vibe-harness.task-dag/v1", "nodes": [...]} or a bare node array.');
  console.log('Node fields match docs/templates/task.md: id, kind (read|write|aggregate), output, dependsOn,');
  console.log('trigger (all_success|all_done), writeScope, resourceLocks, verification, result.');
  console.log();
  console.log('check  Validate the DAG and report the ready set. Errors fail closed: unknown predecessor,');
  console.log('       cycle, self dependency, malformed writeScope, read node with a scope, write node');
  console.log('       without a scope, and two write nodes sharing a path or lock without a dependency');
  console.log('       path (neither is ready).');
  console.log('  --require-ready  Exit non-zero when no node is ready, for a pre-dispatch check.');
  console.log('hash   Print the deterministic structure hash used by checkpoint.dagStructureHash.');
}

function usageError(message) {
  console.error(`task-dag: ${message}`);
  printUsage();
  process.exit(1);
}

/** Parse argv for `check` and `hash`. */
export function parseTaskDagArgs(argv) {
  const options = { file: null, node: null, json: false, requireReady: false, stdin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--stdin') { options.stdin = true; continue; }
    if (token === '--json') { options.json = true; continue; }
    if (token === '--require-ready') { options.requireReady = true; continue; }
    if (token === '--help' || token === '-h') { printUsage(); process.exit(0); }
    if (!['--file', '--node'].includes(token)) usageError(`unknown argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) usageError(`${token} requires a value`);
    if (token === '--node') options.node = value;
    else options.file = value;
    index += 1;
  }
  if (options.file === null && !options.stdin) usageError('--file <path> or --stdin is required');
  if (options.file !== null && options.stdin) usageError('accepts either --file or --stdin, not both');
  return options;
}

async function readDag(options) {
  if (!options.stdin) {
    try {
      return await readJson(path.resolve(options.file));
    } catch (error) {
      usageError(`--file ${options.file} is not readable JSON: ${error.message}`);
      return null;
    }
  }
  try {
    return safeJsonParse(readFileSync(0, 'utf8'));
  } catch (error) {
    usageError(`stdin is not valid JSON: ${error.message}`);
    return null;
  }
}

async function runCheck(argv) {
  const options = parseTaskDagArgs(argv);
  const analysis = await analyzeDag(await readDag(options));
  if (options.node) {
    const dispatch = checkTaskDagNode(analysis, options.node);
    console.log(options.json ? JSON.stringify({ ...analysis, dispatch, ok: dispatch.ready }, null, 2)
      : `${summarizeTaskDag(analysis)}\nnode ${dispatch.id}: ${dispatch.code}`);
    if (!dispatch.ready) process.exitCode = 1;
    return;
  }
  if (options.json) console.log(JSON.stringify(analysis, null, 2));
  else console.log(summarizeTaskDag(analysis));
  if (!analysis.ok) process.exitCode = 1;
  else if (options.requireReady && (!analysis.readyComputed || analysis.ready.length === 0)) {
    console.error('task-dag: no node is ready to dispatch');
    process.exitCode = 1;
  }
}

async function runHash(argv) {
  const options = parseTaskDagArgs(argv);
  const analysis = await analyzeDag(await readDag(options));
  if (options.json) console.log(JSON.stringify({ ok: analysis.ok, structureHash: analysis.structureHash }, null, 2));
  else console.log(analysis.structureHash);
  if (!analysis.ok) process.exitCode = 1;
}

async function analyzeDag(value) {
  const pointer = value?.executionBatch;
  let batchEvidence = null;
  if (pointer && typeof pointer.worktree === 'string' && path.isAbsolute(pointer.worktree) && typeof pointer.parentId === 'string') {
    try { batchEvidence = await taskParentBatchEvidence(pointer.worktree, pointer.parentId); }
    catch { /* An unreadable batch fails closed in the validator. */ }
  }
  return validateTaskDag(value, { batchEvidence });
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') { printUsage(); return; }
  if (subcommand === 'check') return runCheck(rest);
  if (subcommand === 'hash') return runHash(rest);
  usageError(`unknown subcommand: ${subcommand}`);
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
