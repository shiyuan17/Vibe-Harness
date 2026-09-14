#!/usr/bin/env node
// Release readiness CLI.
//
// Turns the mechanically decidable part of docs/rules/release-rules.md into a
// receipt: version agreement, changelog entry, and the optional release-boundary
// facts (verified SHA, clean checkout, artifact checksum).
import { pathToFileURL } from 'node:url';

import { collectReleaseReadiness, writeReleaseReadiness } from './lib/release-readiness.js';

const OPTIONS_WITH_VALUES = new Set(['--receipt', '--sha', '--tarball']);

function printUsage() {
  console.log('Usage: node scripts/release-readiness.js [--sha <sha>] [--require-clean] [--tarball <path>] [--receipt <path>] [--json]');
  console.log();
  console.log('Checks version agreement and the changelog entry; --sha, --require-clean');
  console.log('and --tarball add the release-boundary facts used by CI.');
}

function usageError(message) {
  console.error(`release-readiness: ${message}`);
  printUsage();
  process.exit(1);
}

export function parseReleaseArgs(argv) {
  const options = { expectedSha: null, json: false, receipt: null, requireClean: false, tarball: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') { options.json = true; continue; }
    if (token === '--require-clean') { options.requireClean = true; continue; }
    if (token === '--help' || token === '-h') { printUsage(); process.exit(0); }
    if (!OPTIONS_WITH_VALUES.has(token)) usageError(`unknown argument: ${token}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) usageError(`${token} requires a value`);
    if (token === '--sha') options.expectedSha = value;
    else if (token === '--tarball') options.tarball = value;
    else options.receipt = value;
  }
  return options;
}

async function main() {
  const options = parseReleaseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const receipt = await collectReleaseReadiness({
    expectedSha: options.expectedSha,
    requireClean: options.requireClean,
    rootDir,
    tarball: options.tarball,
  });
  if (options.receipt) await writeReleaseReadiness(options.receipt, receipt);
  if (options.json) console.log(JSON.stringify(receipt, null, 2));
  else {
    console.log(`release readiness: ${receipt.status} (version ${receipt.version ?? 'unknown'})`);
    for (const check of receipt.checks) console.log(`${check.status}: ${check.id} - ${check.detail}`);
    if (!receipt.ok) console.log('Fix every failed check before publishing; local build success is not release evidence.');
  }
  if (!receipt.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
