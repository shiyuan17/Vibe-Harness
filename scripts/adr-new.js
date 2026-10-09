#!/usr/bin/env node
// ADR scaffold CLI.
//
// Creates the next docs/adr/ADR-0000-short-title.md from the repository
// template and then lets docs-sync reconcile the ADR catalog, the documentation
// catalog, the documentation index and docs/memory/DECISIONS.md. The default is
// a read-only preview; --write creates the file and applies the projections.
import { pathToFileURL } from 'node:url';

import { buildAdrPlan, writeAdrDocument } from './lib/adr-scaffold.js';
import { runDocSync } from './lib/docs-projection.js';

const OPTIONS_WITH_VALUES = new Set([
  '--consulted', '--date', '--decision-makers', '--informed', '--language',
  '--owner', '--review-date', '--slug', '--status', '--summary', '--supersedes', '--title',
]);

function printUsage() {
  console.log('Usage: node scripts/adr-new.js --title <title> --owner <owner> [options] [--write]');
  console.log();
  console.log('Options:');
  console.log('  --slug <slug>             Filename slug (required for non-ASCII titles).');
  console.log('  --status <status>         proposed | accepted | rejected | deprecated | superseded.');
  console.log('  --date <YYYY-MM-DD>       Decision date, default today (UTC).');
  console.log('  --review-date <date>      Optional review trigger date.');
  console.log('  --decision-makers <list>  Comma-separated list, default the owner.');
  console.log('  --consulted <list>        Comma-separated list.');
  console.log('  --informed <list>         Comma-separated list.');
  console.log('  --supersedes <ids>        Comma-separated ADR ids this decision replaces.');
  console.log('  --language <tag>          Catalog language, default the project language.');
  console.log('  --summary <text>          DECISIONS.md one-line summary, default the title.');
  console.log('  --write                   Create the ADR and update its projections.');
  console.log('  --json                    Emit the plan as JSON.');
}

function usageError(message) {
  console.error(`adr-new: ${message}`);
  printUsage();
  process.exit(1);
}

export function parseAdrArgs(argv) {
  const options = {};
  let write = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--write') { write = true; continue; }
    if (token === '--json') { json = true; continue; }
    if (token === '--help' || token === '-h') { printUsage(); process.exit(0); }
    if (!OPTIONS_WITH_VALUES.has(token)) usageError(`unknown argument: ${token}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) usageError(`${token} requires a value`);
    const key = token.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    if (token === '--decision-makers' || token === '--consulted' || token === '--informed') {
      options[key] = value.split(',').map((item) => item.trim()).filter(Boolean);
    } else if (token === '--supersedes') {
      options[key] = value.split(',').map((item) => item.trim()).filter(Boolean);
    } else {
      options[key] = value;
    }
  }
  return { json, options, write };
}

function projectionStillMissing(plan, relativePath) {
  return plan.fixable.catalog.some((item) => item.path === relativePath)
    || plan.fixable.index.some((group) => group.items.some((item) => item.path === relativePath))
    || plan.fixable.adrCatalog.some((item) => item.path === relativePath)
    || plan.fixable.decisions.some((item) => item.path === relativePath)
    || plan.manualActions.some((item) => item.path === relativePath);
}

async function main() {
  const { json, options, write } = parseAdrArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const plan = await buildAdrPlan({ ...options, rootDir });
  if (plan.errors.length > 0) {
    if (json) console.log(JSON.stringify({ errors: plan.errors, ok: false }, null, 2));
    else for (const error of plan.errors) console.error(`adr-new: ${error}`);
    process.exitCode = 1;
    return;
  }

  const summary = options.summary ?? plan.title;
  const projections = { catalogOverrides: { [plan.relativePath]: plan.catalogEntry }, decisionsSummaries: { [plan.relativePath]: summary } };
  let written = [];
  let syncPlan = null;
  if (write) {
    await writeAdrDocument(rootDir, plan.relativePath, plan.content);
    const sync = await runDocSync({ ...projections, rootDir, write: true });
    written = [plan.relativePath, ...new Set(sync.written)];
    syncPlan = sync.plan;
  }

  const followUps = [];
  if (Array.isArray(options.supersedes) && options.supersedes.length > 0) {
    followUps.push('Superseded ADRs also need status: superseded, superseded-by in their front matter, and a superseded/supersededBy catalog entry.');
  }
  const incomplete = write && syncPlan ? projectionStillMissing(syncPlan, plan.relativePath) : false;
  const report = {
    id: plan.id,
    ok: write ? !incomplete : true,
    path: plan.relativePath,
    planned: !write,
    status: plan.status,
    title: plan.title,
    written,
    ...(followUps.length > 0 ? { followUps } : {}),
    ...(syncPlan ? { remainingManualActions: syncPlan.manualActions } : {}),
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    if (write) console.log(`Created ${plan.relativePath}`);
    else console.log(`Would create ${plan.relativePath} (dry run; pass --write to create it)`);
    if (written.length > 1) console.log(`Updated projections: ${written.slice(1).sort().join(', ')}`);
    for (const followUp of followUps) console.log(`Note: ${followUp}`);
    if (syncPlan?.manualActions.length) for (const item of syncPlan.manualActions) console.log(`Manual: ${item.code} ${item.message}`);
    console.log('Next: fill in the ADR sections, then run pnpm check.');
  }
  if (incomplete) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
