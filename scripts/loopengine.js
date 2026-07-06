#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyInstallPlan, createInstallPlan } from './lib/install-planner.js';
import { loadAllManifests, validateManifestSources } from './lib/manifest.js';
import { scanForForbiddenTerms } from './lib/redaction.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function install(args) {
  const targetDir = path.resolve(args.target ?? process.cwd());
  const plan = await createInstallPlan({
    dryRun: !args.apply,
    force: Boolean(args.force),
    profile: args.profile ?? 'codex-internal',
    rootDir,
    targetDir,
  });
  plan.redZoneConfirmed = Boolean(args['confirm-red-zone']);
  const result = await applyInstallPlan(plan);
  console.log(JSON.stringify({ actions: plan.actions, dryRun: plan.dryRun, profile: plan.profile, written: result.written }, null, 2));
}

async function validate() {
  const manifests = await loadAllManifests(rootDir);
  const missing = await validateManifestSources(rootDir, manifests);
  const leaks = await scanForForbiddenTerms({
    forbiddenTerms: ['SYBaseProjectWeb', 'SYBaseProject', 'D:\\Github\\JW', 'T-019', 'T-024', '患者', '病理', '医疗'],
    includeDirs: ['rules', 'templates', 'skills/core', 'workflows', 'adapters/codex', 'manifests', 'schemas'],
    rootDir,
  });
  if (missing.length || leaks.length) {
    console.error(JSON.stringify({ leaks, missing }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log('LoopEngine validation passed.');
}

async function doctor(args) {
  const targetDir = path.resolve(args.target ?? process.cwd());
  const manifests = await loadAllManifests(rootDir);
  const missing = await validateManifestSources(rootDir, manifests);
  console.log(JSON.stringify({ manifestSourcesMissing: missing, rootDir, targetDir }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'help';
if (command === 'install') {
  await install(args);
} else if (command === 'validate') {
  await validate();
} else if (command === 'doctor') {
  await doctor(args);
} else {
  console.log('Usage: loopengine <install|validate|doctor> [--target path] [--profile name] [--dry-run] [--force] [--confirm-red-zone]');
}
