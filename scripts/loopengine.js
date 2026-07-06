#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyRollbackPlan, createRollbackPlan } from './lib/install-state.js';
import { applyInstallPlan, createInstallPlan, diffTargetInstall, inspectTargetInstall } from './lib/install-planner.js';
import { validatePack } from './lib/pack-validation.js';

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
  if (args.apply && args['dry-run']) {
    throw new Error('Use either --apply or --dry-run, not both.');
  }
  const targetDir = path.resolve(args.target ?? process.cwd());
  const plan = await createInstallPlan({
    dryRun: !args.apply,
    force: Boolean(args.force),
    profile: args.profile ?? 'codex-internal',
    rootDir,
    targetDir,
    upgrade: Boolean(args.upgrade),
  });
  plan.redZoneConfirmed = Boolean(args['confirm-red-zone']);
  const result = await applyInstallPlan(plan);
  console.log(JSON.stringify({ actions: plan.actions, dryRun: plan.dryRun, profile: plan.profile, written: result.written }, null, 2));
}

async function validate(args) {
  if (args.target) {
    const report = await inspectTargetInstall({
      profile: args.profile ?? 'codex-internal',
      rootDir,
      targetDir: path.resolve(args.target),
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  const report = await validatePack(rootDir);
  if (!report.ok) {
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, scope: 'pack' }, null, 2));
}

async function doctor(args) {
  const targetDir = path.resolve(args.target ?? process.cwd());
  const pack = await validatePack(rootDir);
  const target = args.target
    ? await inspectTargetInstall({ profile: args.profile ?? 'codex-internal', rootDir, targetDir })
    : null;
  console.log(JSON.stringify({ pack, rootDir, target, targetDir }, null, 2));
}

async function diff(args) {
  const report = await diffTargetInstall({
    profile: args.profile ?? 'codex-internal',
    rootDir,
    targetDir: path.resolve(args.target ?? process.cwd()),
  });
  console.log(JSON.stringify(report, null, 2));
}

async function rollback(args) {
  if (args.apply && args['dry-run']) {
    throw new Error('Use either --apply or --dry-run, not both.');
  }
  const plan = await createRollbackPlan({
    dryRun: !args.apply,
    redZoneConfirmed: Boolean(args['confirm-red-zone']),
    targetDir: path.resolve(args.target ?? process.cwd()),
  });
  const result = await applyRollbackPlan(plan);
  console.log(JSON.stringify({ actions: plan.actions, applied: result.applied, dryRun: plan.dryRun, skipped: result.skipped }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'help';
if (command === 'install') {
  await install(args);
} else if (command === 'validate') {
  await validate(args);
} else if (command === 'doctor') {
  await doctor(args);
} else if (command === 'diff') {
  await diff(args);
} else if (command === 'rollback') {
  await rollback(args);
} else {
  console.log('Usage: loopengine <install|validate|doctor|diff|rollback> [--target path] [--profile name] [--apply] [--dry-run] [--force] [--upgrade] [--confirm-red-zone]');
  console.log('Install defaults to dry-run. Use --apply for writes. Red-zone writes require --confirm-red-zone.');
}
