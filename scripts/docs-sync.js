#!/usr/bin/env node
// Documentation projection sync CLI.
//
// Reconciles docs/catalog.json, docs/adr/catalog.json, docs/memory/DECISIONS.md,
// docs/README.md, docs/archive/README.md and the docs/schemas/ render copies
// with the governed documentation tree. docs-validation.js stays the authority:
// this command only reproduces the deterministic part of that contract, and a
// check run performs no writes.
import { pathToFileURL } from 'node:url';

import { runDocSync } from './lib/docs-projection.js';

function printUsage() {
  console.log('Usage: node scripts/docs-sync.js [--write] [--json]');
  console.log();
  console.log('Reconciles the documentation catalog, ADR catalog, DECISIONS index,');
  console.log('documentation indexes and docs/schemas/ mirrors with the governed docs.');
  console.log('  --write  Apply fixable additions; the default is a read-only check.');
  console.log('  --json   Emit the complete plan as JSON.');
}

function usageError(message) {
  console.error(`docs-sync: ${message}`);
  printUsage();
  process.exit(1);
}

export function summarizeDocSyncPlan(plan) {
  const lines = [
    `status: ${plan.ok ? 'passed' : 'failed'}`,
    `governed documents: ${plan.governedCount}`,
    `fixable additions: ${plan.fixableCount}`,
    `manual actions: ${plan.manualActions.length}`,
  ];
  for (const item of plan.manualActions) lines.push(`manual: ${item.code} ${item.message}`);
  if (!plan.ok && plan.manualActions.length === 0) lines.push('Run with --write to apply the additions.');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  let write = false;
  let json = false;
  for (const token of args) {
    if (token === '--write') write = true;
    else if (token === '--json') json = true;
    else if (token === '--help' || token === '-h') { printUsage(); return; }
    else usageError(`unknown argument: ${token}`);
  }

  const { plan, written } = await runDocSync({ rootDir: process.cwd(), write });
  if (json) console.log(JSON.stringify({ ...plan, written }, null, 2));
  else {
    if (written.length > 0) console.log(`Updated ${written.length} path(s): ${[...new Set(written)].sort().join(', ')}`);
    console.log(summarizeDocSyncPlan(plan));
  }
  if (!plan.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
