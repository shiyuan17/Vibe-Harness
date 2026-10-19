#!/usr/bin/env node
// Focused-verification selector: maps current change paths to project-owned
// verification commands. The CLI can run this route as an additional gate;
// scope must still match the completion claim in docs/rules/governance-core.md.
import { pathToFileURL } from 'node:url';

import { readProjectConfig } from './lib/project-config.js';
import { resolveProjectConfigLocation } from './lib/project-layout.js';
import { runFocusedProjectVerification } from './lib/project-verification.js';
import {
  DEFAULT_VALIDATION_TIER,
  VALIDATION_TIERS,
  cumulativeTierNames,
  deriveValidationTiers,
  normalizeTierOption,
  readProjectTierFacts,
  resolveValidationTiers,
} from './lib/validation-tiers.js';
import { estimateVerificationCost, normalizeVerificationScope } from './lib/verification-contract.js';
import {
  buildImpactMapping,
  collectChangedDetails,
  collectChangedPaths,
} from './lib/change-impact.js';
import { buildVerificationPlan } from './lib/verification-plan.js';
import { main as runMicroVerification } from './micro-verify.js';

function printUsage() {
  console.log('Usage: node scripts/verify-focused.js [--base <ref>] [--run] [--tier quick|standard|deep] [--scope affected|layer|full] [--reviewed <check ids|all>] [--micro <check-id>] [--json]');
  console.log();
  console.log('Prints suggested focused verification commands for the current changes.');
  console.log('  --base <ref>  Diff against <ref> instead of HEAD (covers committed changes).');
  console.log('  --run         Execute the selected commands in order, stopping on first failure.');
  console.log('  --tier <t>    Cost layer to execute: quick (default), standard, or deep.');
  console.log('  --scope <s>   Evidence scope: affected, layer (default), or full.');
  console.log('  --reviewed <ids|all>  Declare the relevance review of the selected checks; without it the receipt reports `unreviewed` and acceptance stays blocked.');
  console.log('  --micro <id>  Execute one declared micro check; mutually exclusive with --tier.');
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
  let tierExplicit = false;
  let scope = null;
  let micro = null;
  const reviewedIds = [];
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
        tierExplicit = true;
      } catch (error) {
        usageError(error.message);
      }
    } else if (args[index] === '--base') {
      base = args[++index];
      if (!base) usageError('--base requires a git ref argument.');
    } else if (args[index] === '--scope') {
      const value = args[++index];
      if (value === undefined) usageError('--scope requires an evidence scope (affected, layer, full).');
      try {
        scope = normalizeVerificationScope(value);
      } catch (error) {
        usageError(error.message);
      }
    } else if (args[index] === '--micro') {
      micro = args[++index];
      if (!micro) usageError('--micro requires a check id.');
    } else if (args[index] === '--reviewed') {
      const value = args[++index];
      if (!value) usageError('--reviewed requires check ids or `all`.');
      reviewedIds.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
    } else if (args[index] === '--help' || args[index] === '-h') {
      printUsage();
      return;
    } else {
      usageError(`unknown argument: ${args[index]}`);
    }
  }

  if (micro) {
    if (tierExplicit) usageError('--micro cannot be combined with --tier.');
    await runMicroVerification([
      '--id', micro,
      ...(run ? ['--run'] : []),
      ...(json ? ['--json'] : []),
    ], process.cwd());
    return;
  }

  const paths = await collectChangedPaths({ base });
  let changedDetails = [];
  try {
    changedDetails = await collectChangedDetails({ base });
  } catch {
    // collectChangedPaths already provides the actionable failure for a bad
    // repository; the selector can still produce a path-only safe plan.
  }
  const config = await resolveProjectConfigLocation(process.cwd())
    ? await readProjectConfig(process.cwd())
    : {};
  const tierFacts = await readProjectTierFacts(process.cwd(), config.packageManager);
  const derivedTiers = deriveValidationTiers({
    ...tierFacts,
    configuredCommands: config.validationCommands,
  });
  const resolvedTiers = resolveValidationTiers({
    configuredTiers: config.validationCommands?.tiers,
    derived: derivedTiers,
  });
  const plan = await buildVerificationPlan({
    changedPaths: paths,
    commandStatus: {},
    config,
    changedDetails,
    targetDir: process.cwd(),
    tiers: resolvedTiers.tiers,
    tierSource: resolvedTiers.tierSource,
    scope,
  });
  // The risk plan answers "what does this change affect"; passing the tier into
  // the same builder answers "which declared commands that layer pays for". A
  // tier run must select every command the cumulative layer declares, not only
  // the ones the change surface happened to surface: on an ordinary
  // scripts/docs change, `--tier deep` would otherwise silently omit a
  // declared integration or e2e command because it never entered the risk
  // plan. The risk plan stays the relevance surface, so its derived checks
  // keep running and keep being reported as deferred.
  const tierPlan = await buildVerificationPlan({
    changedPaths: paths,
    commandStatus: {},
    config,
    changedDetails,
    targetDir: process.cwd(),
    tiers: resolvedTiers.tiers,
    tierSource: resolvedTiers.tierSource,
    scope,
    tier,
    tierExplicit,
  });
  const execution = { tier: tierPlan.executionTier ?? tier, fallback: tierPlan.tierFallback };
  tier = execution.tier ?? tier;
  // The risk plan answers "what does this change affect"; the cost layer
  // answers "which of that evidence do I pay for now". The fast layer is the
  // default, and the deferred checks stay visible instead of disappearing.
  const activeTiers = new Set(cumulativeTierNames(tier));
  const tierOf = (item) => item.costTier ?? 'standard';
  // The plan's own deferred evidence (the slimmed high branch) joins the pool:
  // an escalated tier still pays for it, a quick run still reports it deferred.
  // The risk plan alone is the relevance surface: it is what decides that a
  // change "affects" e2e or lifecycle smoke. The cost tier only decides which
  // of those checks is paid for now, so the tier plan's own additions enter the
  // execution pool without being reported as impact-mapped evidence.
  const impactChecks = [...plan.selectedChecks, ...(plan.deferredChecks ?? [])];
  const pool = [
    ...impactChecks,
    ...(tierPlan.selectedChecks ?? []),
    ...(tierPlan.deferredChecks ?? []),
  ];
  const poolSeen = new Set();
  const considered = [];
  const commands = [];
  const deferredChecks = [];
  for (const item of pool) {
    // The two plans name the same declared command differently (the risk plan
    // derives an id, the tier plan uses the declared script), so the pool is
    // de-duplicated by the execution identity: the command plus the directory
    // it runs in. Two declared checks may legitimately share a command in
    // different working directories.
    const key = `${item.cwd ?? '.'}\0${item.command ?? item.id}`;
    if (poolSeen.has(key)) continue;
    poolSeen.add(key);
    considered.push(item);
    if (activeTiers.has(tierOf(item))) commands.push(item);
    else deferredChecks.push({ ...item });
  }
  const nextTier = VALIDATION_TIERS.find((name) => deferredChecks.some((item) => tierOf(item) === name)) ?? null;
  const scopeStatus = deferredChecks.length > 0 ? 'partial' : 'complete';
  const notes = plan.selectionReasons;
  const impactMapping = buildImpactMapping(paths, impactChecks);
  const selectedIds = new Set(commands.map((item) => item.id));
  const skippedChecks = [...plan.skippedChecks.filter((item) => !selectedIds.has(item.id)), ...considered
    .filter((item) => !selectedIds.has(item.id))
    .map((item) => ({ id: item.id, status: 'not_selected' }))];
  const selectedCost = estimateVerificationCost(commands, config);
  const selection = {
    selectedChecks: commands,
    tierFallback: execution.fallback,
    skippedChecks: [...new Map(skippedChecks.map((item) => [item.id, item])).values()],
    estimatedCostMs: selectedCost.estimatedDurationMs,
    estimatedChecks: selectedCost.estimatedChecks,
    escalation: { ...plan.escalation, nextTier, required: plan.escalation.required || deferredChecks.length > 0 },
  };
  const selectionReasonsByCheck = {
    ...(tierPlan.selectionReasonsByCheck ?? {}),
    ...(plan.selectionReasonsByCheck ?? Object.fromEntries(
      [...plan.selectedChecks, ...(plan.deferredChecks ?? [])].map((item) => [
        item.id ?? item.command,
        [...(item.selectionReasons ?? (item.reason ? [item.reason] : []))],
      ]),
    )),
  };
  if (!run && json) {
    console.log(JSON.stringify({
      ...plan,
      ...selection,
      deferredChecks,
      executionTier: tier,
      impactMapping,
      nextTier,
      notes,
      scopeStatus,
      scope: plan.scope,
      scopeConfidence: plan.scopeConfidence,
      budgetMs: plan.budgetMs,
      environment: plan.environment,
      selectionReasonsByCheck,
    }, null, 2));
    return;
  }
  let report = null;
  if (run) {
    report = await runFocusedProjectVerification({
      focused: {
        changedPaths: paths,
        // No `reviewed: true` here: the runner marking its own checks as
        // reviewed would make the acceptance gate attest its own relevance.
        // `--reviewed` is the caller's declaration.
        commands: commands.map((item) => ({ ...item })),
        reviewedIds,
        notes,
        impactMapping,
      },
      targetDir: process.cwd(),
      timeoutMs: config.verification?.timeoutMs,
    });
    report.verification = {
      ...report.verification,
      ...selection,
      deferredChecks,
      executionTier: tier,
      riskLevel: plan.riskLevel,
      planMode: plan.planMode,
      impactGroups: [...plan.impactGroups],
      nextTier,
      scopeStatus,
      scope: plan.scope,
      scopeConfidence: plan.scopeConfidence,
      budgetMs: plan.budgetMs,
      environment: plan.environment,
      tierSource: plan.tierSource,
      selectionReasonsByCheck,
      fallbackUsed: plan.fallbackUsed,
      selectionReasons: [...plan.selectionReasons],
    };
    if (deferredChecks.length > 0 && report.verification.acceptance) {
      report.verification.acceptance = {
        ...report.verification.acceptance,
        status: 'blocked',
        reasonCode: 'DEFERRED_CHECKS',
      };
      // A receipt blocked for deferred layers cannot be the completion evidence,
      // so the exit status reports the same verdict as the receipt instead of
      // letting a caller read `ok` as "this run completed the change".
      report.ok = false;
    }
    if (json) console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    if (json) return;
  }
  if (paths.length === 0) {
    console.log(run
      ? `No changed paths detected; ran ${commands.length} selected baseline command(s).`
      : `No changed paths detected; ${commands.length} project baseline command(s) selected.`);
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

  for (const [index, item] of commands.entries()) {
    console.log(`\n$ ${item.command}`);
    try {
      // The runner records one result per command in the order it was given, so
      // the same position is this command's own result. A lookup by command
      // alone would hand a repeated command in another working directory the
      // other check's output and status.
      const result = report.results[index];
      if (!result) throw new Error(`No result was recorded for: ${item.command}`);
      if (result.stdout) process.stdout.write(result.stdout + (result.stdout.endsWith('\n') ? '' : '\n'));
      if (result.stderr) process.stderr.write(result.stderr + (result.stderr.endsWith('\n') ? '' : '\n'));
      if (result.status !== 'passed') throw result;
    } catch (error) {
      console.error(`\nFocused verification failed at: ${item.command}`);
      console.error('Recovery: ' + (error.next?.command ?? 'pnpm verify:focused --run'));
      process.exit(typeof error.exitCode === 'number' ? error.exitCode : 1);
    }
  }
  console.log(report.ok
    ? '\nFocused verification passed.'
    : '\nFocused verification selected checks passed; the receipt remains blocked by deferred evidence.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
