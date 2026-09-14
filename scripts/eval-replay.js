#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadEvalAssets, validateEvalAssets, validateEvalSuiteSemantics } from './lib/eval-contract.js';
import { syncOfflineRunArtifact } from './lib/eval-replay.js';
import { compareFingerprints } from './lib/eval-scoring.js';
import { validateJsonAgainstSchema } from './lib/manifest.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log('Usage: node scripts/eval-replay.js [--write] [--json]');
  console.log();
  console.log('Reproduces the checked-in offline run (evals/results/) from the suite and compares it.');
  console.log('  --write  Regenerate the checked-in run; the previous file is backed up under .vibe-harness/backups/.');
  console.log('  --json   Emit the complete report as JSON.');
  console.log();
  console.log('The run embeds the same asset fingerprint as the approved reference, so a rule, Hook,');
  console.log('config or suite change requires regenerating the reference first and this artifact second.');
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
      console.error(`eval-replay: unknown argument: ${token}`);
      usage();
      process.exitCode = 1;
      return;
    }
  }

  const assets = await loadEvalAssets(rootDir);

  if (write) {
    // The checked-in asset pair is intentionally allowed to disagree here: the
    // documented flow regenerates the reference first and this artifact second.
    const suiteErrors = [
      ...validateJsonAgainstSchema(assets.suite, assets.schemas.suite, 'evals/suites/vibe-harness-core.json'),
      ...validateEvalSuiteSemantics(assets.suite),
    ];
    if (suiteErrors.length > 0) {
      fail({ errors: suiteErrors, ok: false });
      return;
    }
    const report = await syncOfflineRunArtifact({ rootDir, suite: assets.suite, write: true });
    const mismatches = compareFingerprints(report.run.fingerprint, assets.reference.fingerprint).mismatches;
    const referenceMatched = mismatches.length === 0;
    if (json) {
      console.log(JSON.stringify({
        backups: report.backups,
        changes: report.changes,
        errors: referenceMatched ? [] : mismatches.map((item) => `reference fingerprint mismatch for ${item.field}`),
        nextAction: referenceMatched
          ? null
          : 'Regenerate the reference (`pnpm vibe-harness eval reference --project . --from <run> --write --confirm-reference-update --force`) and rerun `pnpm eval:replay`.',
        ok: referenceMatched,
        path: report.path,
        reference: referenceMatched ? 'matched' : 'mismatched',
        status: report.status,
        written: report.written,
      }, null, 2));
    } else {
      console.log(report.status === 'current'
        ? 'Vibe-Harness offline replay artifact is current.'
        : 'Vibe-Harness offline replay artifact updated.');
      for (const change of report.changes) {
        console.log(`changed: ${change.field} ${change.from ?? '-'} -> ${change.to ?? '-'}`);
      }
      for (const backup of report.backups) console.log(`backup: ${backup.backup}`);
      if (!referenceMatched) {
        console.error('reference fingerprint still differs from the regenerated run; update the reference and rerun pnpm eval:replay.');
      }
    }
    if (!referenceMatched) process.exitCode = 1;
    return;
  }

  const errors = validateEvalAssets(assets);
  if (errors.length > 0) {
    fail({ errors, ok: false });
    return;
  }
  const report = await syncOfflineRunArtifact({ rootDir, suite: assets.suite, write: false });
  if (report.changed) {
    fail({
      changes: report.changes,
      errors: ['replay differs from the checked-in result'],
      nextAction: 'Review the drifted groups, update the reference, then regenerate this artifact with `pnpm eval:replay --write`.',
      ok: false,
    });
    return;
  }
  console.log('Vibe-Harness deterministic replay passed.');
  console.log(JSON.stringify({
    criticalPassRate: report.run.criticalPassRate,
    overallScore: report.run.overallScore,
    status: report.run.status,
    suite: report.run.suite.id,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
