#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { syncBehavioralRunArtifact } from './lib/eval-behavioral.js';
import { validateEvalSuiteSemantics } from './lib/eval-contract.js';
import { readJson, validateJsonAgainstSchema } from './lib/manifest.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE_PATH = 'evals/suites/vibe-harness-behavioral.json';

function usage() {
  console.log('Usage: node scripts/eval-behavioral.js [--write] [--json]');
  console.log();
  console.log('Executes the behavioral suite against the real runtime (hook + focused verification)');
  console.log('and compares the result with the checked-in stub artifact (evals/results/).');
  console.log('  --write  Regenerate the checked-in artifact; the previous file is backed up under .vibe-harness/backups/.');
  console.log('  --json   Emit the complete report as JSON.');
  console.log();
  console.log('The artifact embeds the asset fingerprint, so a rule, Hook, config or suite change');
  console.log('requires regenerating it (`pnpm eval:behavioral --write`).');
}

/** @param {any} payload */
function fail(payload) {
  console.error(JSON.stringify(payload, null, 2));
  process.exitCode = 1;
}

async function main() {
  let json = false;
  let write = false;
  for (const token of process.argv.slice(2)) {
    if (token === '--write') write = true;
    else if (token === '--json') json = true;
    else if (token === '--help' || token === '-h') { usage(); return; }
    else {
      console.error(`eval-behavioral: unknown argument: ${token}`);
      usage();
      process.exitCode = 1;
      return;
    }
  }

  const suiteSchema = await readJson(path.join(rootDir, 'schemas/eval-suite.schema.json'));
  const suite = await readJson(path.join(rootDir, SUITE_PATH));
  const suiteErrors = [
    ...validateJsonAgainstSchema(suite, suiteSchema, SUITE_PATH),
    ...validateEvalSuiteSemantics(suite),
  ];
  if (suiteErrors.length > 0) {
    fail({ errors: suiteErrors, ok: false });
    return;
  }

  const report = await syncBehavioralRunArtifact({ rootDir, suite, write });
  // A failing behavioral run is a runtime regression, not an artifact to pin:
  // report it and exit non-zero without ever writing the file.
  if (report.run.status !== 'passed') {
    fail({
      changes: report.changes,
      errors: report.run.cases.filter((item) => !item.passed).map((item) => `${item.id} failed ${item.criticalFailures} critical assertion(s)`),
      ok: false,
      status: report.run.status,
    });
    return;
  }
  if (report.changed && !write) {
    fail({
      changes: report.changes,
      errors: ['behavioral run differs from the checked-in result'],
      nextAction: 'Regenerate the artifact with `pnpm eval:behavioral --write` (behavioral evidence must follow asset changes).',
      ok: false,
    });
    return;
  }
  if (json) {
    console.log(JSON.stringify({
      backups: report.backups,
      cases: report.run.cases.map((item) => ({ id: item.id, passed: item.passed })),
      changes: report.changes,
      criticalPassRate: report.run.criticalPassRate,
      ok: true,
      overallScore: report.run.overallScore,
      path: report.path,
      status: report.status,
      suite: report.run.suite.id,
      written: report.written,
    }, null, 2));
    return;
  }
  console.log(report.status === 'current'
    ? 'Vibe-Harness behavioral run artifact is current.'
    : `Vibe-Harness behavioral run artifact ${write ? 'updated' : 'drifted'}.`);
  for (const change of report.changes) {
    console.log(`changed: ${change.field} ${change.from ?? '-'} -> ${change.to ?? '-'}`);
  }
  for (const backup of report.backups) console.log(`backup: ${backup.backup}`);
  console.log(JSON.stringify({
    criticalPassRate: report.run.criticalPassRate,
    overallScore: report.run.overallScore,
    status: report.run.status,
    suite: report.run.suite.id,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
