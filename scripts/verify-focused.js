#!/usr/bin/env node
// Focused-verification selector: maps current change paths to project-owned
// verification commands. The CLI can run this route as an additional gate;
// scope must still match the completion claim in docs/rules/governance-core.md.
import { pathToFileURL } from 'node:url';

import { readProjectConfig } from './lib/project-config.js';
import { runFocusedProjectVerification } from './lib/project-verification.js';
import {
  DEFAULT_VALIDATION_TIER,
  VALIDATION_TIERS,
  cumulativeTierNames,
  normalizeTierOption,
} from './lib/validation-tiers.js';
import {
  buildImpactMapping,
  collectChangedDetails,
  collectChangedPaths,
} from './lib/change-impact.js';
import { buildVerificationPlan } from './lib/verification-plan.js';

function printUsage() {
  console.log('Usage: node scripts/verify-focused.js [--base <ref>] [--run] [--tier quick|standard|deep] [--json]');
  console.log();
  console.log('Prints suggested focused verification commands for the current changes.');
  console.log('  --base <ref>  Diff against <ref> instead of HEAD (covers committed changes).');
  console.log('  --run         Execute the selected commands in order, stopping on first failure.');
  console.log('  --tier <t>    Cost layer to execute: quick (default), standard, or deep.');
  console.log('  --json        Emit suggestions or the complete focused-verification receipt as JSON.');
}

function usageError(message) {
  console.error(`verify-focused: ${message}`);
  printUsage();
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  let run = false;
  let json = false;
  let base = null;
  let tier = DEFAULT_VALIDATION_TIER;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--run') {
      run = true;
    } else if (args[index] === '--json') {
      json = true;
    } else if (args[index] === '--tier') {
      const value = args[++index];
      if (value === undefined) usageError('--tier requires a layer argument (quick, standard, deep).');
      try {
        tier = normalizeTierOption(value);
      } catch (error) {
        usageError(error.message);
      }
    } else if (args[index] === '--base') {
      base = args[++index];
      if (!base) usageError('--base requires a git ref argument.');
    } else if (args[index] === '--help' || args[index] === '-h') {
      printUsage();
      return;
    } else {
      usageError(`unknown argument: ${args[index]}`);
    }
  }

  const paths = await collectChangedPaths({ base });
  let changedDetails = [];
  try {
    changedDetails = await collectChangedDetails({ base });
  } catch {
    // collectChangedPaths already provides the actionable failure for a bad
    // repository; the selector can still produce a path-only safe plan.
  }
  const config = await readProjectConfig(process.cwd());
  const plan = await buildVerificationPlan({
    changedPaths: paths,
    commandStatus: {},
    config,
    changedDetails,
    targetDir: process.cwd(),
  });
  // The risk plan answers "what does this change affect"; the cost layer
  // answers "which of that evidence do I pay for now". The fast layer is the
  // default, and the deferred checks stay visible instead of disappearing.
  const activeTiers = new Set(cumulativeTierNames(tier));
  const tierOf = (item) => item.costTier ?? 'standard';
  const commands = plan.selectedChecks.filter((item) => activeTiers.has(tierOf(item)));
  const deferredChecks = plan.selectedChecks
    .filter((item) => !activeTiers.has(tierOf(item)))
    .map((item) => ({ ...item }));
  const nextTier = VALIDATION_TIERS.find((name) => deferredChecks.some((item) => tierOf(item) === name)) ?? null;
  const scopeStatus = deferredChecks.length > 0 ? 'partial' : 'complete';
  const notes = plan.selectionReasons;
  const impactMapping = buildImpactMapping(paths, plan.selectedChecks);
  if (!run && json) {
    console.log(JSON.stringify({
      ...plan,
      deferredChecks,
      executionTier: tier,
      impactMapping,
      nextTier,
      notes,
      scopeStatus,
      selectedChecks: commands,
    }, null, 2));
    return;
  }
  let report = null;
  if (run) {
    report = await runFocusedProjectVerification({
      focused: { changedPaths: paths, commands, notes, impactMapping },
      targetDir: process.cwd(),
      timeoutMs: config.verification?.timeoutMs,
    });
    report.verification = {
      ...report.verification,
      deferredChecks,
      executionTier: tier,
      riskLevel: plan.riskLevel,
      planMode: plan.planMode,
      impactGroups: [...plan.impactGroups],
      nextTier,
      scopeStatus,
      selectedChecks: plan.selectedChecks.map((item) => ({ ...item })),
      skippedChecks: plan.skippedChecks.map((item) => ({ ...item })),
      fallbackUsed: plan.fallbackUsed,
      selectionReasons: [...plan.selectionReasons],
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    if (json) return;
  }
  if (paths.length === 0) {
    console.log('No changed paths detected; no focused verification needed.');
    return;
  }
  console.log(`Focused verification suggestions (${paths.length} changed path(s), ${commands.length} command(s)):`);
  for (const item of commands) console.log(`  ${item.command.padEnd(24)}# ${item.reason}`);
  for (const item of deferredChecks) {
    console.log(`  ${item.command.padEnd(24)}# deferred (${item.costTier}): ${item.blockingScope}`);
  }
  for (const note of notes) console.log(`Note: ${note}`);
  if (deferredChecks.length > 0) {
    console.log(`Deferred layers are not run by default; escalate with --tier ${nextTier ?? 'deep'} when the completion claim needs them.`);
  }
  console.log('Use --run to execute the commands in order and emit a receipt.');

  if (!run) return;

  for (const item of commands) {
    console.log(`\n$ ${item.command}`);
    try {
      const result = report.results.find((entry) => entry.command === item.command);
      if (result.stdout) process.stdout.write(result.stdout + (result.stdout.endsWith('\n') ? '' : '\n'));
      if (result.stderr) process.stderr.write(result.stderr + (result.stderr.endsWith('\n') ? '' : '\n'));
      if (result.status !== 'passed') throw result;
    } catch (error) {
      console.error(`\nFocused verification failed at: ${item.command}`);
      console.error('Recovery: ' + (error.next?.command ?? 'pnpm verify:focused --run'));
      process.exit(typeof error.exitCode === 'number' ? error.exitCode : 1);
    }
  }
  console.log('\nFocused verification passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
