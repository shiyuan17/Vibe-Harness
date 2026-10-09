#!/usr/bin/env node
// Eval projection sync CLI.
//
// Regenerates the self-installed eval mirror (.agents/evals/) from the sources
// declared in adapters/install-map.json. The default is a read-only check;
// --write copies drifted files and never deletes an orphaned mirror entry.
import { pathToFileURL } from 'node:url';

import { runEvalSync } from './lib/eval-projection.js';

function printUsage() {
  console.log('Usage: node scripts/eval-sync.js [--write] [--json]');
  console.log();
  console.log('Compares adapters/install-map.json eval entries with the .agents/evals/ mirror.');
  console.log('  --write  Copy drifted files from evals/ to .agents/evals/.');
  console.log('  --json   Emit the complete plan as JSON.');
}

async function main() {
  const args = process.argv.slice(2);
  let write = false;
  let json = false;
  for (const token of args) {
    if (token === '--write') write = true;
    else if (token === '--json') json = true;
    else if (token === '--help' || token === '-h') { printUsage(); return; }
    else {
      console.error(`eval-sync: unknown argument: ${token}`);
      printUsage();
      process.exitCode = 1;
      return;
    }
  }

  const { plan, written } = await runEvalSync({ rootDir: process.cwd(), write });
  if (json) console.log(JSON.stringify({ ...plan, written }, null, 2));
  else {
    if (written.length > 0) console.log(`Updated ${written.length} mirror file(s): ${written.join(', ')}`);
    console.log(`status: ${plan.ok ? 'passed' : 'failed'}`);
    console.log(`projected eval files: ${plan.projectedCount}`);
    console.log(`drift: ${plan.drift.length}`);
    for (const item of plan.drift) console.log(`drift: ${item.target} (${item.reason})`);
    for (const item of plan.manualActions) console.log(`manual: ${item.code} ${item.message}`);
    if (!plan.ok && plan.drift.length > 0) console.log('Run with --write to restore the mirror.');
  }
  if (!plan.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
