#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectValidationCommands } from './lib/command-status.js';
import { inspectGitHooks } from './lib/git-hooks.js';
import {
  applyRollbackPlan,
  applyUninstallPlan,
  createRollbackPlan,
  createUninstallPlan,
  readInstallState,
  registerGeneratedFile,
  stateFilePath,
} from './lib/install-state.js';
import { pathExists, readJson } from './lib/manifest.js';
import {
  applyInstallPlan,
  createInstallPlan,
  createMultiTargetInstallPlan,
  diffMultiTargetInstall,
  diffTargetInstall,
  inspectTargetInstall,
  previewInstallPlan,
} from './lib/install-planner.js';
import { validatePack } from './lib/pack-validation.js';
import { runProjectVerification } from './lib/project-verification.js';
import { detectProjectProfile } from './lib/project-profile.js';
import {
  readRequiredProjectConfig,
  resolveValidationCommands,
  validateConfigAndGeneratedContent,
  validateProjectConfig,
  validateProjectConfigWithSchema,
  mvpTargets,
  migrateLegacyProjectConfig,
  projectTargets,
  validateProfileName,
  writeDefaultProjectConfig,
} from './lib/project-config.js';
import { collectProjectBaselineInputs, createProjectBaseline } from './lib/project-baseline.js';
import {
  checkProjectEvaluations,
  runProjectEvaluations,
  writeProjectEvaluationReference,
} from './lib/project-evaluation.js';
import { parseModulesOption, parsePluginsOption } from './lib/module-selection.js';
import { canonicalAgentsTemplate, loadAdapterCatalog, resolveAdapter } from './lib/adapter.js';
import { safetyPostureWarnings } from './lib/safety-posture.js';
import { inspectMemory, inspectRuntimeHooks, runtimeHookWarnings } from './lib/runtime-diagnostics.js';
import { readFile } from 'node:fs/promises';
import {
  createToolProvisioningPlan,
  inspectProvisioningMarker,
  inspectProfileTools,
  provisionProfileTools,
  toolWarnings,
} from './lib/tool-provisioning.js';
import { inspectTransactions, recoverTransaction } from './lib/file-transaction.js';
import { assertNoUnsupportedLegacyAssets } from './lib/project-layout.js';
import { findNestedInstallations, nestedInstallMigrationCommands } from './lib/nested-install.js';
import { sanitizePublicReport } from './lib/tool-provisioning/subprocess.js';
import { runProjectAudit } from './lib/project-audit.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requiredToolsDegraded(profile, tools = {}) {
  return Object.values(tools).some((tool) => ['degraded', 'unsupported'].includes(tool.status));
}

function healthReport({ baseOk = true, profile, tools = {} }) {
  if (!baseOk) return { ok: false, status: 'invalid' };
  if (requiredToolsDegraded(profile, tools)) return { ok: false, status: 'degraded' };
  return { ok: true, status: 'ready' };
}

function applyHealthExit(status, args) {
  if (status === 'invalid') process.exitCode = 1;
  if (status === 'degraded' && !args['allow-degraded']) process.exitCode = 2;
}

function rtkHooksReport(enabled, tools = {}, source = 'unknown') {
  if (!enabled) return { enabled: false, source, status: 'disabled', reason: 'RTK hooks are disabled.' };
  const state = tools.rtk;
  if (state?.status === 'ready') {
    return { enabled: true, source, status: 'ready', reason: 'Project-local RTK runtime is ready.' };
  }
  const status = state?.status ?? 'degraded';
  return {
    enabled: true,
    source,
    status,
    reason: state?.diagnostic?.message ?? `Project-local RTK runtime is ${status}. Original commands remain available.`,
  };
}

function toolStateRelativePath(targetDir) {
  return path.relative(
    targetDir,
    path.join(path.dirname(stateFilePath(targetDir)), 'tool-state/tools.json'),
  ).replaceAll('\\', '/');
}

function compactAction(action) {
  return {
    ...(action.kind === 'write' ? {} : { kind: action.kind }),
    ...(action.contentStrategy === 'replace' ? {} : { contentStrategy: action.contentStrategy }),
    ...(action.redZone ? { redZone: true } : {}),
    relativeTarget: action.relativeTarget,
  };
}

function normalizeReport(report) {
  const status = report.status ?? (report.ok === false ? 'invalid' : 'ready');
  return {
    ...report,
    ok: status === 'ready' && report.ok !== false,
    status,
    warnings: report.warnings ?? [],
    recommendations: report.recommendations ?? [],
  };
}

function compactTargetReport(report) {
  if (!report) return report;
  return {
    adapters: Object.fromEntries(Object.entries(report.adapters ?? {}).map(([id, item]) => [id, {
      missingCapabilities: item.missingCapabilities ?? [],
      ok: item.ok,
      previewCapabilities: item.previewCapabilities ?? [],
      status: item.status,
    }])),
    changed: (report.changed ?? []).map(({ target }) => ({ target })),
    missing: (report.missing ?? []).map(({ target }) => ({ target })),
    ok: report.ok,
    profile: report.profile,
    redZone: (report.redZone ?? []).map(({ status, target }) => ({ status, target })),
    staleProjections: report.staleProjections ?? [],
    summary: report.summary ? {
      changedCount: report.summary.changedCount,
      missingCount: report.summary.missingCount,
      sameCount: report.summary.sameCount,
      unmanagedCount: report.summary.unmanagedCount,
      samples: Object.fromEntries(Object.entries(report.summary.samples ?? {}).map(
        ([name, items]) => [name, items.map(({ target }) => ({ target }))],
      )),
    } : undefined,
  };
}

function summaryText(value, maxLength = 480) {
  const compact = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function optionalToolFallback(tool) {
  if (tool === 'rtk') return 'Use the original command directly and record the fallback.';
  if (tool === 'astGrep') return 'Use rg or the project search command and record the fallback.';
  return null;
}

function toolSummaryLines(tools = {}, recommendations = []) {
  return Object.entries(tools).flatMap(([tool, state]) => {
    const fallback = optionalToolFallback(tool);
    const diagnostic = state.diagnostic;
    const details = diagnostic?.stderrTail ?? diagnostic?.stdoutTail;
    const recommendation = recommendations.find((item) => item.tool === tool);
    const lines = [
      `tool: ${tool}`,
      `status: ${state.status}`,
      ...(state.version ? [`version: ${state.version}`] : []),
      ...(state.platform ? [`platform: ${state.platform}`] : []),
      ...(state.source ? [`source: ${state.source}`] : []),
      `phase: ${state.phase}`,
    ];
    if (state.status === 'ready') return lines;
    return [
      ...lines,
      `reason: ${summaryText(diagnostic?.message ?? `${tool} is ${state.status} during ${state.phase}.`)}`,
      ...(details && details !== diagnostic?.message ? [`details: ${summaryText(details)}`] : []),
      ...(diagnostic?.exitCode !== undefined ? [`exitCode: ${diagnostic.exitCode}`] : []),
      ...(diagnostic?.truncated ? ['detailsTruncated: true'] : []),
      ...(recommendation?.command || recommendation?.message || fallback ? [`next: ${recommendation?.action === 'fallback' ? recommendation.message : (recommendation?.command ?? recommendation?.message ?? fallback)}`] : []),
    ];
  });
}

function emitReport(report, args, { error = false } = {}) {
  const targetDir = path.resolve(args.project ?? process.cwd());
  const normalized = sanitizePublicReport(normalizeReport(report), targetDir);
  const output = args.output ?? 'json';
  if (!['json', 'summary'].includes(output)) throw new Error(`Unknown output format: ${output}`);
  if (output === 'summary') {
    const lines = [
      ...(normalized.rtkHooks ? ['rtkHooksSource: ' + normalized.rtkHooks.source] : []),
      ...(normalized.runtimeHooks ? ['runtimeHooks: ' + normalized.runtimeHooks.activation.status + ' (' + normalized.runtimeHooks.activation.mechanism + ')'] : []),
      ...(normalized.memory ? ['memory: runtime=' + normalized.memory.runtime.status + ', durable=' + normalized.memory.durable.status] : []),
      `status: ${normalized.status}`,
      ...(normalized.profile ? [`profile: ${normalized.profile}`] : []),
      ...(Array.isArray(normalized.requestedPlugins) ? [`plugins: ${normalized.requestedPlugins.length ? normalized.requestedPlugins.join(',') : 'none'}`] : []),
      ...(normalized.rtkHooks ? [`rtkHooks: ${normalized.rtkHooks.status} (enabled=${normalized.rtkHooks.enabled})`] : []),
      ...(normalized.rtkHooks && normalized.rtkHooks.status !== 'ready' ? [`rtkHooksReason: ${summaryText(normalized.rtkHooks.reason)}`] : []),
      ...(typeof normalized.target === 'string' ? [`target: ${normalized.target}`] : []),
      ...(normalized.dryRun !== undefined ? [`dryRun: ${normalized.dryRun}`] : []),
      `warnings: ${normalized.warnings.length}`,
      ...toolSummaryLines(normalized.tools, normalized.recommendations),
    ];
    (error ? console.error : console.log)(lines.join('\n'));
    return;
  }
  (error ? console.error : console.log)(JSON.stringify(normalized, null, args.verbose ? 2 : 0));
}

// diff/rollback/uninstall/baseline print raw plan reports; redact them through the
// same public-report sanitizer so absolute project paths never reach stdout.
function printRawReport(report, args) {
  const targetDir = path.resolve(args.project ?? process.cwd());
  console.log(JSON.stringify(sanitizePublicReport(report, targetDir), null, args?.verbose ? 2 : 0));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (key === 'plugin') {
        const values = [];
        while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
          values.push(argv[index + 1]);
          index += 1;
        }
        args[key] = [...(Array.isArray(args[key]) ? args[key] : []), ...values];
        continue;
      }
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        if (key === 'tool' && args[key] !== undefined) {
          args[key] = Array.isArray(args[key]) ? [...args[key], next] : [args[key], next];
        } else {
          args[key] = next;
        }
        index += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function resolveCommandTargets(config, state, requestedTarget) {
  const configured = projectTargets(config);
  const installed = state?.targets ?? [];
  if (requestedTarget) {
    if (!configured.includes(requestedTarget) && !installed.includes(requestedTarget)) {
      throw new Error('CLI target ' + requestedTarget + ' is not configured or installed for this project.');
    }
    return { configured, selected: [requestedTarget] };
  }
  return { configured, selected: configured };
}

async function projectRequestedModules(config, targetDir) {
  if (config.modules) return config.modules;
  return (await readInstallState(targetDir))?.requestedModules ?? undefined;
}

async function projectRequestedPlugins(config, targetDir) {
  if (config.plugins) return parsePluginsOption(config.plugins);
  return (await readInstallState(targetDir))?.requestedPlugins ?? undefined;
}

function parseRtkHooksOption(value) {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error('--rtk-hooks must be on or off.');
}

function resolveRtkHooksSetting({ adapterId, args = {}, config, installState, requestedPlugins = [], targets = [adapterId] }) {
  const configured = Object.hasOwn(config.hooks?.rtk ?? {}, 'enabled');
  const rtkSelected = requestedPlugins.includes('rtk');
  let enabled;
  let source;
  if (args['rtk-hooks'] !== undefined) {
    enabled = parseRtkHooksOption(args['rtk-hooks']);
    source = 'cli';
  } else if (configured) {
    enabled = config.hooks.rtk.enabled;
    source = 'project-config';
  } else if (installState) {
    enabled = Boolean(installState.rtkHooksEnabled && rtkSelected);
    source = 'install-state';
  } else {
    enabled = Boolean(rtkSelected && targets.includes('codex'));
    source = enabled ? 'fresh-install-default' : 'default-disabled';
  }
  if (enabled && !targets.includes('codex')) {
    throw new Error('RTK hooks are only supported for the codex target.');
  }
  if (enabled && !rtkSelected) {
    throw new Error('RTK hook integration requires the rtk plugin. Select --plugin -rtk.');
  }
  return { enabled, source };
}

function resolveRtkHooksEnabled(options) {
  return resolveRtkHooksSetting(options).enabled;
}

async function init(args) {
  const projectDir = path.resolve(args.project ?? process.cwd());
  const existingState = await readInstallState(projectDir);
  const result = await writeDefaultProjectConfig({
    force: Boolean(args.force),
    profile: args.profile ?? existingState?.profile ?? 'core',
    projectDir,
    target: args.target ?? existingState?.targets?.[0] ?? 'codex',
  });
  console.log(JSON.stringify({
    config: result.config,
    path: result.path,
    written: [result.path],
  }, null, 2));
}

async function install(args) {
  if (!args.project) throw new Error('install requires --project <path>; legacy --target path and --apply were removed.');
  const allowedOptions = new Set([
    '_', 'allow-degraded', 'allow-preview', 'confirm-red-zone', 'dry-run', 'force', 'modules', 'output',
    'plugin', 'profile', 'project', 'provision', 'rtk-hooks', 'target', 'upgrade', 'verbose', 'write',
  ]);
  const unknownOption = Object.keys(args).find((key) => !allowedOptions.has(key));
  if (unknownOption) throw new Error(`Unknown install option: --${unknownOption}`);
  const isMvpMode = true;
  const writeRequested = Boolean(args.write);
  const dryRunRequested = Boolean(args['dry-run']) || !writeRequested;
  if (args.write && args['dry-run']) {
    throw new Error('Use --write or --dry-run, not both.');
  }
  const targetDir = path.resolve(args.project);
  const existingState = await readInstallState(targetDir);
  if (
    existingState
    && !args.upgrade
    && (existingState.stateVersion !== 5 || existingState.product !== 'vibe-harness')
  ) {
    throw Object.assign(new Error('Pre-v4 install state requires vibe-harness install --upgrade.'), {
      code: 'VIBE_HARNESS_STATE_MIGRATION_REQUIRED',
    });
  }
  const sourceConfig = await readRequiredProjectConfig(targetDir);
  const config = sourceConfig;
  const { configured: targets, selected: selectedTargets } = resolveCommandTargets(config, existingState, args.target);
  const adapterId = selectedTargets[0];
  if (args.target && !targets.includes(args.target) && !existingState?.targets?.includes(args.target)) {
    throw new Error(`CLI target ${args.target} does not match vibe-harness.config.json target ${config.target}.`);
  }
  const adapter = await resolveAdapter(rootDir, adapterId);
  const requestedProfile = args.profile ?? config.profile;
  const profile = validateProfileName(requestedProfile);
  validateProjectConfigWithSchema({ ...config, profile });
  const projectProfile = await detectProjectProfile({ config, targetDir });
  const validationCommands = resolveValidationCommands(config, projectProfile);
  const renderData = {
    ...config,
    profile,
    projectProfile,
    target: adapterId,
    targets,
    validationCommands,
  };
  const requestedModules = args.modules !== undefined
    ? parseModulesOption(args.modules)
    : config.modules;
  const requestedPlugins = args.plugin !== undefined
    ? parsePluginsOption(args.plugin)
    : (config.plugins ? parsePluginsOption(config.plugins) : existingState?.requestedPlugins);
  const rtkHooksSetting = resolveRtkHooksSetting({
    adapterId,
    args,
    config,
    installState: existingState,
    requestedPlugins: requestedPlugins ?? [],
    targets,
  });
  const rtkHooksEnabled = rtkHooksSetting.enabled;

  const migratedConfig = migrateLegacyProjectConfig(config);
  const configUpdate = Object.hasOwn(config, 'target') && args.upgrade
    ? { config: migratedConfig, path: path.join(targetDir, 'vibe-harness.config.json') }
    : null;
  const plan = await createMultiTargetInstallPlan({
    configUpdate,
    allowPreview: Boolean(args['allow-preview']),
    dryRun: dryRunRequested,
    force: Boolean(args.force),
    managedAgentsBlock: isMvpMode,
    profile,
    requestedModules,
    requestedPlugins,
    rtkHooksEnabled,
    renderData,
    rootDir,
    selectedTargets,
    targetDir,
    targets,
    upgrade: Boolean(args.upgrade),
  });
  const installedTargets = plan.actions.map((action) => action.relativeTarget);
  // Validate every selected adapter's instruction template render, not just the
  // first; a broken template for a later target must fail the install itself.
  const adapterCatalog = await loadAdapterCatalog(rootDir);
  for (const adapterEntry of adapterCatalog.items) {
    if (!selectedTargets.includes(adapterEntry.id)) continue;
    const templatePath = adapterEntry.instructionTarget === 'AGENTS.md'
      ? canonicalAgentsTemplate
      : `adapters/${adapterEntry.id}/${adapterEntry.instructionTemplate}.template.md`;
    const template = await readFile(path.join(rootDir, templatePath), 'utf8');
    validateConfigAndGeneratedContent(plan.renderData, template, { installedTargets, skillRoots: plan.skillRoots });
  }
  plan.redZoneConfirmed = Boolean(args['confirm-red-zone']);
  const result = await applyInstallPlan(plan);
  const previewFiles = plan.dryRun ? await previewInstallPlan(plan, { includeContent: Boolean(args.verbose) }) : [];
  const allowPreview = Boolean(args['allow-preview']);
  // Single superset plan (allowPreview:true) derives both the user-facing plan and
  // the deferred preview tools, avoiding a duplicate createToolProvisioningPlan call.
  const allToolActions = createToolProvisioningPlan({
    allowPreview: true,
    profile,
    resolvedModules: plan.resolvedModules,
    targetDir,
  });
  const compactToolAction = ({ id, mode, phases, supportLevel, version }) => ({ id, mode, phases, supportLevel, version });
  const plannedToolActions = (allowPreview ? allToolActions : allToolActions.filter((item) => item.supportLevel !== 'preview'))
    .map(compactToolAction);
  const deferredToolActions = allToolActions
    .filter((item) => item.supportLevel === 'preview' && !allowPreview)
    .map(compactToolAction);
  const provisionRequested = Boolean(args.provision);
  const provisionExecuted = provisionRequested && !plan.dryRun;
  const tools = provisionExecuted
    ? await provisionWithSignalHandling({
        allowPreview: Boolean(args['allow-preview']),
        mcpConflicts: result.mcpConflicts,
        profile,
        resolvedModules: plan.resolvedModules,
        targetDir,
      })
    : await inspectProfileTools(profile, targetDir, plan.resolvedModules, undefined, {
        allowPreview: Boolean(args['allow-preview']),
      });
  if (provisionExecuted && plannedToolActions.length > 0) {
    await registerGeneratedFile(targetDir, toolStateRelativePath(targetDir));
  }
  const health = provisionExecuted ? healthReport({ profile, tools }) : { ok: true, status: 'ready' };
  const runtimeHooks = await inspectRuntimeHooks(adapter, targetDir);
  const warnings = [
    ...(provisionExecuted
      ? toolWarnings(tools)
      : (plannedToolActions.length > 0 ? [{
          code: 'PROVISIONING_NOT_RUN',
          message: 'Tool provisioning was not run; use vibe-harness provision --project <project> --write.',
        }] : [])),
    ...safetyPostureWarnings(adapter),
    ...runtimeHookWarnings(runtimeHooks),
    ...Object.entries(plan.linearMcp ?? {})
      .filter(([, item]) => item.configuration === 'manual')
      .map(([target, item]) => ({
        code: 'LINEAR_MCP_MANUAL_SETUP',
        message: target + ' requires manual project MCP setup for ' + item.endpoint + '.',
      })),
    ...Object.entries(plan.linearMcp ?? {})
      .map(([target]) => ({
        code: 'LINEAR_MCP_AUTH_REQUIRED',
        message: 'Complete ' + target + "'s native Linear OAuth flow; no credential was written by Vibe-Harness.",
      })),
  ];
  emitReport({
    ...health,
    actions: args.verbose ? plan.actions : plan.actions.map(compactAction),
    backupActions: plan.baselinePlan.actions,
    baselineId: result.baseline?.id ?? plan.baselinePlan.baselineId,
    deferredToolActions,
    dryRun: plan.dryRun,
    implicitModules: plan.implicitModules,
    plannedToolActions,
    adapterCapabilities: plan.adapterCapabilities,
    linearMcp: plan.linearMcp,
    missingCapabilities: plan.missingCapabilities,
    provisioning: { executed: provisionExecuted, requested: provisionRequested },
    previewFiles,
    profile: plan.profile,
    previewCapabilities: plan.previewCapabilities,
    requestedModules: plan.requestedModules,
    requestedPlugins: plan.requestedPlugins,
    resolvedModules: plan.resolvedModules,
    rtkHooks: rtkHooksReport(plan.rtkHooksEnabled, tools, rtkHooksSetting.source),
    runtimeHooks,
    requiresRedZoneConfirmation: plan.dryRun
      && !args['confirm-red-zone']
      && plan.actions.some((action) => action.redZone && action.kind === 'write'),
    target: isMvpMode && selectedTargets.length === 1 ? adapterId : undefined,
    targets: selectedTargets,
    ...(args.verbose ? { targetDir: plan.targetDir } : {}),
    tools,
    recommendations: toolRecommendations(tools, profile, { adapterId, mvp: isMvpMode }),
    warnings,
    retired: result.retired,
    skipped: result.skipped,
    written: result.written,
  }, args);
  applyHealthExit(health.status, args);
}

async function validate(args) {
  if (args.project) {
    const targetDir = path.resolve(args.project);
    const config = await readRequiredProjectConfig(targetDir);
    const installState = await readInstallState(targetDir);
    const { configured: targets, selected: selectedTargets } = resolveCommandTargets(config, installState, args.target);
    if (args.target && !targets.includes(args.target) && !installState?.targets?.includes(args.target)) {
      throw new Error(`CLI target ${args.target} does not match vibe-harness.config.json target ${config.target}.`);
    }
    const requestedModules = await projectRequestedModules(config, targetDir);
    const requestedPlugins = await projectRequestedPlugins(config, targetDir);
    validateProjectConfig(config);
    const adapter = await resolveAdapter(rootDir, selectedTargets[0]);
    const rtkHooksSetting = resolveRtkHooksSetting({
      adapterId: adapter.id,
      config,
      installState,
      requestedPlugins: requestedPlugins ?? [],
      targets,
    });
    const rtkHooksEnabled = rtkHooksSetting.enabled;
    const projectProfile = await detectProjectProfile({ config, targetDir });
    const validationCommands = resolveValidationCommands(config, projectProfile);
    const plan = await createMultiTargetInstallPlan({
      allowPreview: true,
      dryRun: true,
      force: true,
      managedAgentsBlock: true,
      profile: config.profile,
      requestedModules,
      requestedPlugins,
      rtkHooksEnabled,
      renderData: { ...config, projectProfile, validationCommands },
      rootDir,
      selectedTargets,
      targetDir,
      targets,
    });
    const agentsTemplatePath = adapter.instructionTarget === 'AGENTS.md'
      ? canonicalAgentsTemplate
      : `adapters/${adapter.id}/${adapter.instructionTemplate}.template.md`;
    const agentsTemplate = await readFile(path.join(rootDir, agentsTemplatePath), 'utf8');
    const installedTargets = plan.actions.map((action) => action.relativeTarget);
    validateConfigAndGeneratedContent({ ...config, projectProfile, validationCommands }, agentsTemplate, { installedTargets, skillRoots: plan.skillRoots });
    validateConfigAndGeneratedContent(plan.renderData, agentsTemplate, { installedTargets, skillRoots: plan.skillRoots });
    const target = await diffMultiTargetInstall({
      aggregatePlan: plan,
      allowPreview: true,
      managedAgentsBlock: true,
      profile: config.profile,
      requestedModules,
      requestedPlugins,
      rtkHooksEnabled,
      renderData: { ...config, projectProfile, validationCommands },
      rootDir,
      selectedTargets,
      targetDir,
      targets,
    });
    if (!target.ok) {
      emitReport({
        ok: false,
        scope: 'project',
        ...(args.verbose ? { targetDir } : {}),
        target: args.verbose ? target : compactTargetReport(target),
      }, args, { error: true });
      applyHealthExit('invalid', args);
      return;
    }
    const pack = await validatePack(rootDir);
    if (!pack.ok) {
      emitReport({ ...pack, status: 'invalid' }, args, { error: true });
      applyHealthExit('invalid', args);
      return;
    }
    const commandStatus = await inspectValidationCommands({
      commands: validationCommands,
      targetDir,
    });
    const tools = await inspectProfileTools(config.profile, targetDir, plan.resolvedModules, undefined, {
      allowPreview: true,
    });
    const health = healthReport({ profile: config.profile, tools });
    const runtimeHooks = await inspectRuntimeHooks(adapter, targetDir);
    emitReport({
      ...health,
      commandStatus,
      recommendations: toolRecommendations(tools, config.profile, { adapterId: adapter.id, mvp: true }),
      rtkHooks: rtkHooksReport(rtkHooksEnabled, tools, rtkHooksSetting.source),
      runtimeHooks,
      scope: 'project',
      targets: selectedTargets,
      ...(args.verbose ? { targetDir } : {}),
      tools,
      warnings: [...toolWarnings(tools), ...safetyPostureWarnings(adapter), ...runtimeHookWarnings(runtimeHooks)],
    }, args);
    applyHealthExit(health.status, args);
    return;
  }

  if (args.target) throw new Error('validate uses --project <path>; --target only selects an adapter.');

  const report = await validatePack(rootDir);
  if (!report.ok) {
    emitReport({ ...report, status: 'invalid' }, args, { error: true });
    applyHealthExit('invalid', args);
    return;
  }
  emitReport({ ok: true, scope: 'pack', status: 'ready' }, args);
}

async function verify(args) {
  if (!args.project) throw new Error('verify requires --project <path>.');
  const targetDir = path.resolve(args.project);
  const config = await readRequiredProjectConfig(targetDir);
  const installState = await readInstallState(targetDir);
  const { configured: targets, selected: selectedTargets } = resolveCommandTargets(config, installState, args.target);
  if (args.target && !targets.includes(args.target) && !installState?.targets?.includes(args.target)) {
    throw new Error(`CLI target ${args.target} does not match vibe-harness.config.json target ${config.target}.`);
  }
  const requestedModules = await projectRequestedModules(config, targetDir);
  const requestedPlugins = await projectRequestedPlugins(config, targetDir);
  validateProjectConfig(config);
  const adapter = await resolveAdapter(rootDir, selectedTargets[0]);
  const rtkHooksEnabled = resolveRtkHooksEnabled({
    adapterId: adapter.id,
    config,
    installState,
    requestedPlugins: requestedPlugins ?? [],
    targets,
  });
  const projectProfile = await detectProjectProfile({ config, targetDir });
  const validationCommands = resolveValidationCommands(config, projectProfile);
  const renderData = { ...config, projectProfile, validationCommands };
  const target = await diffMultiTargetInstall({
    allowPreview: true,
    managedAgentsBlock: true,
    profile: config.profile,
    requestedModules,
    requestedPlugins,
    rtkHooksEnabled,
    renderData,
    rootDir,
    selectedTargets,
    targetDir,
    targets,
  });
  if (!target.ok) {
    const error = new Error('Project installation is not consistent; run vibe-harness validate --project first.');
    error.code = 'PROJECT_VERIFICATION_FAILED';
    throw error;
  }
  const pack = await validatePack(rootDir);
  if (!pack.ok) {
    const error = new Error('Vibe-Harness pack validation failed.');
    error.code = 'PROJECT_VERIFICATION_FAILED';
    throw error;
  }
  const commandStatus = await inspectValidationCommands({ commands: validationCommands, targetDir });
  const verificationReport = await runProjectVerification({
    allowManual: Boolean(args['allow-manual']),
    commandStatus,
    targetDir,
  });
  emitReport({
    ...verificationReport,
    scope: 'project',
    status: verificationReport.ok ? 'ready' : 'invalid',
    targetDir,
  }, args, { error: !verificationReport.ok });
  if (!verificationReport.ok) process.exitCode = 1;
}

async function baseline(args) {
  if (!args.project) throw Object.assign(new Error('baseline requires --project <path>.'), { code: 'BASELINE_PROJECT_REQUIRED' });
  if (args.target) throw Object.assign(new Error('baseline uses --project <path> and does not accept --target.'), { code: 'BASELINE_PROJECT_REQUIRED' });
  if (args.write && args['dry-run']) throw new Error('Use --write or --dry-run, not both.');
  const allowedOptions = new Set(['_', 'dry-run', 'force', 'project', 'verify', 'write']);
  const unknownOption = Object.keys(args).find((key) => !allowedOptions.has(key));
  if (unknownOption) throw new Error(`Unknown baseline option: --${unknownOption}`);
  const targetDir = path.resolve(args.project);
  let config;
  try {
    config = await readRequiredProjectConfig(targetDir);
  } catch (cause) {
    throw Object.assign(new Error('Project configuration is missing or invalid; run vibe-harness init before baseline.'), {
      cause,
      code: 'BASELINE_INSTALL_INVALID',
    });
  }
  try {
    validateProjectConfig(config);
  } catch (cause) {
    throw Object.assign(new Error('Project configuration is invalid; fix vibe-harness.config.json before baseline.'), {
      cause,
      code: 'BASELINE_INSTALL_INVALID',
    });
  }
  const projectProfile = await detectProjectProfile({ config, targetDir });
  const targets = projectTargets(config);
  const adapter = await resolveAdapter(rootDir, targets[0]);
  let installState;
  let requestedModules;
  let requestedPlugins;
  try {
    installState = await readInstallState(targetDir);
    if (!installState) throw new Error('Install state is missing.');
    requestedModules = await projectRequestedModules(config, targetDir);
    requestedPlugins = await projectRequestedPlugins(config, targetDir);
  } catch (cause) {
    throw Object.assign(new Error('Project installation state is invalid; reinstall before baseline.'), {
      cause,
      code: 'BASELINE_INSTALL_INVALID',
    });
  }
  const rtkHooksEnabled = resolveRtkHooksEnabled({
    adapterId: adapter.id,
    config,
    installState,
    requestedPlugins: requestedPlugins ?? [],
    targets,
  });
  const validationCommands = resolveValidationCommands(config, projectProfile);
  const renderData = { ...config, projectProfile, validationCommands };
  const target = await diffMultiTargetInstall({
    allowPreview: true,
    managedAgentsBlock: true,
    profile: config.profile,
    requestedModules,
    requestedPlugins,
    rtkHooksEnabled,
    renderData,
    rootDir,
    targetDir,
    targets,
  });
  const inputs = await collectProjectBaselineInputs({
    config,
    projectProfile,
    target,
    targetDir,
    validationCommands,
  });
  const result = await createProjectBaseline({
    ...inputs,
    baselineSchema: await readJson(path.join(rootDir, 'schemas/project-baseline.schema.json')),
    config,
    force: Boolean(args.force),
    projectProfile,
    target,
    targetDir,
    verify: Boolean(args.verify),
    write: Boolean(args.write),
  });
  printRawReport(result, args);
  if (!result.ok) process.exitCode = 1;
}

async function evaluateProject(args) {
  const action = args._[1];
  if (!['check', 'run', 'reference'].includes(action)) throw new Error('eval requires check, run, or reference.');
  if (!args.project) throw new Error('eval requires --project <path>.');
  if (args.target) throw new Error('eval uses --project <path> and does not accept --target.');
  if (args.write && args['dry-run']) throw new Error('Use --write or --dry-run, not both.');
  const allowed = {
    check: new Set(['_', 'output', 'project', 'suite', 'verbose']),
    run: new Set(['_', 'allow-degraded', 'dry-run', 'mode', 'output', 'project', 'reference', 'runner', 'suite', 'verbose', 'write']),
    reference: new Set(['_', 'confirm-reference-update', 'dry-run', 'force', 'from', 'output', 'project', 'verbose', 'write']),
  }[action];
  const unknownOption = Object.keys(args).find((key) => !allowed.has(key));
  if (unknownOption) throw new Error(`Unknown eval ${action} option: --${unknownOption}`);
  const targetDir = path.resolve(args.project);
  const config = await readRequiredProjectConfig(targetDir);
  validateProjectConfig(config);
  if (!config.evaluations?.enabled) throw new Error('Project evaluations are disabled.');

  let report;
  if (action === 'check') {
    report = await checkProjectEvaluations({ config, rootDir, suiteId: args.suite, targetDir });
  } else if (action === 'run') {
    report = await runProjectEvaluations({
      config,
      mode: args.mode,
      reference: args.reference,
      rootDir,
      runner: args.runner,
      suiteId: args.suite,
      targetDir,
      write: Boolean(args.write),
    });
  } else {
    if (!args.from) throw new Error('eval reference requires --from <run>.');
    if (args.write && !args['confirm-reference-update']) {
      throw new Error('eval reference --write requires --confirm-reference-update.');
    }
    report = await writeProjectEvaluationReference({
      config,
      force: Boolean(args.force),
      from: args.from,
      rootDir,
      targetDir,
      write: Boolean(args.write),
    });
  }
  emitReport(report, args, { error: report.status === 'invalid' });
  applyHealthExit(report.status, args);
}

async function auditProject(args) {
  if (!args.project) throw new Error('audit requires --project <path>.');
  if (!args.kind) throw new Error('audit requires --kind memory|review|improvements|all.');
  if (args.target) throw new Error('audit uses --project <path> and does not accept --target.');
  const allowed = new Set(['_', 'base', 'kind', 'output', 'project', 'receipt', 'verbose', 'write']);
  const unknownOption = Object.keys(args).find((key) => !allowed.has(key));
  if (unknownOption) throw new Error('Unknown audit option: --' + unknownOption);
  const report = await runProjectAudit({
    baseSha: typeof args.base === 'string' ? args.base : undefined,
    kind: args.kind,
    receiptPath: typeof args.receipt === 'string' ? args.receipt : undefined,
    rootDir,
    targetDir: path.resolve(args.project),
    write: Boolean(args.write),
  });
  emitReport(report, args, { error: report.status === 'degraded' });
  if (report.status === 'degraded') process.exitCode = 1;
}

function toolRecommendations(tools, profile, { adapterId = 'codex' } = {}) {
  const retryCommand = `vibe-harness provision --project <project> --target ${adapterId} --profile ${profile} --write`;
  return Object.entries(tools).flatMap(([tool, state]) => {
    const toolRetryCommand = retryCommand + ' --tool ' + tool;
    const fallback = optionalToolFallback(tool);
    if (fallback && ['pending', 'degraded', 'unsupported'].includes(state.status)) {
      return [{
        action: 'fallback',
        ...(state.code ? { code: state.code } : {}),
        ...(state.status === 'degraded' ? { command: toolRetryCommand } : {}),
        ...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
        message: `${tool} is ${state.status} during ${state.phase}. ${fallback}`,
        phase: state.phase,
        tool,
      }];
    }
    if (state.status === 'unsupported') {
      const fallback = tool === 'rtk'
        ? 'Use the original command without RTK and record the fallback.'
        : tool === 'astGrep'
          ? 'Use rg or the project search command and record the fallback.'
          : 'Use the project-supported fallback and record the limitation.';
      return [{
        action: 'fallback',
        code: state.code,
        message: `${tool} is unsupported on this platform. ${fallback}`,
        phase: state.phase,
        tool,
      }];
    }
    if (state.status === 'degraded') {
      if (state.code === 'MCP_CONFIG_CONFLICT') {
        return [{
          action: 'resolve-mcp-config',
          code: state.code,
          ...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
          message: `Remove or rename the unmanaged MCP server for ${tool}, then retry provisioning.`,
          phase: state.phase,
          tool,
        }];
      }
      return [{
        action: 'retry-provision',
        code: state.code,
        command: toolRetryCommand,
        ...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
        message: ['rtk', 'astGrep'].includes(tool)
          ? `${tool} is unavailable; retry provisioning after checking the pinned download or package, or use the documented fallback.`
          : `Retry ${tool} provisioning after checking network access and the reported phase.`,
        phase: state.phase,
        tool,
      }];
    }
    if (state.status === 'pending-config') {
      return [{
        action: 'configure-credentials',
        command: toolRetryCommand,
        message: `Configure a supported ${tool} credential in the environment, then retry provisioning.`,
        phase: state.phase,
        tool,
      }];
    }
    return [];
  });
}

async function doctor(args) {
  if (!args.project) throw new Error('doctor requires --project <path>.');
  const targetDir = path.resolve(args.project);
  const installState = await readInstallState(targetDir);
  const config = await readRequiredProjectConfig(targetDir);
  const { configured: targets, selected: selectedTargets } = resolveCommandTargets(config, installState, args.target);
  if (args.target && !targets.includes(args.target) && !installState?.targets?.includes(args.target)) {
    throw new Error(`CLI target ${args.target} does not match vibe-harness.config.json target ${config.target}.`);
  }
  validateProjectConfig(config);
  const profile = validateProfileName(args.profile ?? config.profile);
  const requestedPlugins = config.plugins
    ? parsePluginsOption(config.plugins)
    : (installState?.requestedPlugins ?? []);
  const rtkHooksSetting = resolveRtkHooksSetting({
    adapterId: selectedTargets[0],
    config,
    installState,
    requestedPlugins,
    targets,
  });
  const rtkHooksEnabled = rtkHooksSetting.enabled;
  const managedAgentsBlock = installState?.files?.some(
    (file) => ['managed-block', 'managed-instruction-block'].includes(file.contentStrategy),
  );
  let renderData = {};
  if (managedAgentsBlock) {
    const projectProfile = await detectProjectProfile({ config, targetDir });
    const validationCommands = resolveValidationCommands(config, projectProfile);
    renderData = { ...config, profile, projectProfile, validationCommands };
  }
  const adapter = await resolveAdapter(rootDir, selectedTargets[0]);
  const [pack, gitHooks, nestedInstallations, provisioningProcess, transactions, transactionLock] = await Promise.all([
    validatePack(rootDir),
    inspectGitHooks(targetDir),
    findNestedInstallations(targetDir),
    inspectProvisioningMarker(targetDir),
    inspectTransactions(targetDir),
    pathExists(path.join(path.dirname(stateFilePath(targetDir)), 'transaction.lock')),
  ]);
  let target = await diffMultiTargetInstall({
    allowPreview: true,
    managedAgentsBlock: true,
    profile,
    requestedModules: installState?.requestedModules,
    requestedPlugins,
    rtkHooksEnabled,
    renderData,
    rootDir,
    selectedTargets,
    targetDir,
    targets,
  });
  const tools = await inspectProfileTools(profile, targetDir, installState?.resolvedModules, undefined, {
    allowPreview: true,
  });
  if (!args.verbose) target = compactTargetReport(target);
  let health = provisioningProcess
    ? { ok: false, status: 'degraded' }
    : healthReport({ baseOk: pack.ok && (!target || target.ok), profile, tools });
  const runtimeHooks = await inspectRuntimeHooks(adapter, targetDir, {
    hookMode: config.hooks?.mode,
    selfCheck: true,
  });
  if (runtimeHooks.selfCheck?.status === 'degraded') health = { ok: false, status: 'degraded' };
  const memory = await inspectMemory(config, installState, targetDir);
  emitReport({
    ...health,
    gitHooks,
    memory,
    nestedInstallations,
    nestedInstallMigration: nestedInstallations.length > 0
      ? nestedInstallMigrationCommands(targetDir, nestedInstallations)
      : [],
    pack,
    previewCapabilities: installState?.previewCapabilities ?? [],
    requestedPlugins,
    resolvedModules: installState?.resolvedModules ?? [],
    rtkHooks: rtkHooksReport(rtkHooksEnabled, tools, rtkHooksSetting.source),
    runtimeHooks,
    provisioningProcess,
    ...(args.verbose ? { rootDir } : {}),
    target,
    ...(args.verbose ? { targetDir } : {}),
    tools,
    transactionLock,
    transactions,
    recommendations: toolRecommendations(tools, profile, {
      adapterId: selectedTargets[0],
      mvp: true,
    }),
    warnings: [
      ...toolWarnings(tools),
      ...(provisioningProcess ? [{
        code: 'PROVISIONING_PROCESS_INCOMPLETE',
        message: `Provisioning process state is ${provisioningProcess.status}.`,
      }] : []),
      ...(nestedInstallations.length > 0 ? [{
        code: 'NESTED_INSTALLATIONS_FOUND',
        message: nestedInstallations.length + ' nested Vibe-Harness installation(s) require explicit migration and uninstall.',
      }] : []),
      ...safetyPostureWarnings(adapter),
      ...runtimeHookWarnings(runtimeHooks),
      ...(pack.instructionBudgetWarnings ?? []).map((message) => ({
        code: 'INSTRUCTION_BUDGET',
        message,
      })),
    ],
    targets: selectedTargets,
  }, args);
  applyHealthExit(health.status, args);
}

async function diff(args) {
  if (!args.project) throw new Error('diff requires --project <path>.');
  const targetDir = path.resolve(args.project);
  const config = await readRequiredProjectConfig(targetDir);
  const installState = await readInstallState(targetDir);
  const { configured: targets, selected: selectedTargets } = resolveCommandTargets(config, installState, args.target);
  if (args.target && !targets.includes(args.target) && !installState?.targets?.includes(args.target)) {
    throw new Error(`CLI target ${args.target} does not match vibe-harness.config.json target ${config.target}.`);
  }
  validateProjectConfig(config);
  const profile = validateProfileName(args.profile ?? config.profile);
  const projectProfile = await detectProjectProfile({ config, targetDir });
  const validationCommands = resolveValidationCommands(config, projectProfile);
  const renderData = { ...config, profile, projectProfile, validationCommands };
  const requestedPlugins = config.plugins
    ? parsePluginsOption(config.plugins)
    : (installState?.requestedPlugins ?? []);
  const rtkHooksEnabled = resolveRtkHooksEnabled({
    adapterId: selectedTargets[0],
    config,
    installState,
    requestedPlugins,
    targets,
  });
  const report = await diffMultiTargetInstall({
    allowPreview: true,
    managedAgentsBlock: true,
    profile,
    requestedModules: config.modules ?? installState?.requestedModules,
    requestedPlugins,
    rtkHooksEnabled,
    renderData,
    rootDir,
    selectedTargets,
    targetDir,
    targets,
  });
  printRawReport(report, args);
}

async function rollback(args) {
  if (!args.project) throw new Error('rollback requires --project <path>.');
  if (args.target) {
    const state = await readInstallState(path.resolve(args.project));
    if (!state) throw new Error(`No Vibe-Harness install state found in ${path.resolve(args.project)}`);
    if (!state.targets.includes(args.target)) {
      throw new Error('CLI target ' + args.target + ' is not present in installed targets: ' + state.targets.join(', ') + '.');
    }
  }
  if (args.write && args['dry-run']) {
    throw new Error('Use either --write or --dry-run, not both.');
  }
  const plan = await createRollbackPlan({
    dryRun: !args.write,
    redZoneConfirmed: Boolean(args['confirm-red-zone']),
    targetDir: path.resolve(args.project),
  });
  const result = await applyRollbackPlan(plan);
  printRawReport({
    actions: plan.actions,
    applied: result.applied,
    dryRun: plan.dryRun,
    retainedState: result.retainedState,
    skipped: result.skipped,
  }, args);
}

async function uninstall(args) {
  if (!args.project) throw new Error('uninstall requires --project <path>.');
  const targetDir = path.resolve(args.project);
  const config = await readRequiredProjectConfig(targetDir);
  const state = await readInstallState(targetDir);
  if (!state) throw new Error('No Vibe-Harness install state found in the project.');
  if (Boolean(args.target) === Boolean(args['all-targets'])) {
    throw new Error('Use --target <adapter> for one projection or --all-targets for the complete installation.');
  }
  const configuredTargets = projectTargets(config);
  const adapter = await resolveAdapter(rootDir, args.target ?? state.targets[0]);
  if (args.target && !state.targets.includes(args.target)) {
    throw new Error('CLI target ' + args.target + ' is not present in installed targets: ' + state.targets.join(', ') + '.');
  }
  if (state && !state.targets.includes(adapter.id)) {
    throw new Error(`Installed adapter ${state.adapter} does not match uninstall target ${adapter.id}.`);
  }
  if (args.write && args['dry-run']) throw new Error('Use --write or --dry-run, not both.');
  if (args.target && state.targets.length === 1) {
    throw new Error('The final target must be removed with --all-targets.');
  }
  const allowedOptions = new Set(['_', 'all-targets', 'confirm-red-zone', 'dry-run', 'project', 'target', 'write']);
  const unknownOption = Object.keys(args).find((key) => !allowedOptions.has(key));
  if (unknownOption) throw new Error(`Unknown uninstall option: --${unknownOption}`);

  const canonicalConfig = migrateLegacyProjectConfig(config);
  const configUpdate = args.target ? {
    config: { ...canonicalConfig, targets: configuredTargets.filter((item) => item !== args.target) },
    path: path.join(targetDir, 'vibe-harness.config.json'),
  } : null;
  const plan = await createUninstallPlan({
    allTargets: Boolean(args['all-targets']),
    configUpdate,
    dryRun: !args.write,
    redZoneConfirmed: Boolean(args['confirm-red-zone']),
    target: args.target,
    targetDir,
  });
  const result = await applyUninstallPlan(plan);
  printRawReport({
    actions: plan.actions,
    applied: result.applied,
    dryRun: plan.dryRun,
    retainedState: result.retainedState,
    skipped: result.skipped,
    target: args.target,
    targets: args['all-targets'] ? state.targets : state.targets.filter((item) => item !== args.target),
    targetDir: plan.targetDir,
  }, args);
  if (result.skipped.length > 0) process.exitCode = 2;
}

function selectedToolIds(value) {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

async function provisionWithSignalHandling(options) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    return await provisionProfileTools({ ...options, signal: controller.signal });
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

async function provision(args) {
  if (!args.project) throw new Error('provision requires --project <path>.');
  if (args.write && args['dry-run']) throw new Error('Use --write or --dry-run, not both.');
  const allowedOptions = new Set([
    '_', 'allow-degraded', 'allow-preview', 'dry-run', 'force', 'output', 'profile', 'project', 'target', 'tool', 'verbose', 'write',
  ]);
  const unknownOption = Object.keys(args).find((key) => !allowedOptions.has(key));
  if (unknownOption) throw new Error(`Unknown provision option: --${unknownOption}`);
  const targetDir = path.resolve(args.project);
  const config = await readRequiredProjectConfig(targetDir);
  const state = await readInstallState(targetDir);
  if (!state) throw new Error(`No Vibe-Harness install state found in ${targetDir}; run install first.`);
  const configuredTargets = projectTargets(config);
  const adapterId = args.target ?? state.targets[0];
  if (!configuredTargets.includes(adapterId) || !state.targets.includes(adapterId)) {
    throw new Error('Provision target ' + adapterId + ' must be present in both configured and installed targets.');
  }
  const profile = validateProfileName(args.profile ?? state.profile);
  if (profile !== state.profile) {
    throw new Error(`Provision profile ${profile} does not match installed profile ${state.profile}.`);
  }
  const toolIds = selectedToolIds(args.tool);
  const plannedToolActions = createToolProvisioningPlan({
    allowPreview: Boolean(args['allow-preview']),
    profile,
    resolvedModules: state.resolvedModules,
    targetDir,
    toolIds,
  }).map(({ id, mode, phases, supportLevel, version }) => ({ id, mode, phases, supportLevel, version }));
  const dryRun = !args.write;
  const tools = dryRun
    ? await inspectProfileTools(profile, targetDir, state.resolvedModules, toolIds, {
        allowPreview: Boolean(args['allow-preview']),
      })
    : await provisionWithSignalHandling({
        allowPreview: Boolean(args['allow-preview']),
        force: Boolean(args.force),
        profile,
        resolvedModules: state.resolvedModules,
        targetDir,
        toolIds,
      });
  if (!dryRun && plannedToolActions.length > 0) {
    await registerGeneratedFile(targetDir, toolStateRelativePath(targetDir));
  }
  const health = dryRun ? { ok: true, status: 'ready' } : healthReport({ profile, tools });
  emitReport({
    ...health,
    dryRun,
    plannedToolActions,
    profile,
    recommendations: toolRecommendations(tools, profile, { adapterId }),
    target: adapterId,
    targets: state.targets,
    tools,
    warnings: dryRun ? [] : toolWarnings(tools),
  }, args);
  applyHealthExit(health.status, args);
}

async function recover(args) {
  if (!args.project) throw new Error('recover requires --project <path>.');
  if (args.write && args['dry-run']) throw new Error('Use --write or --dry-run, not both.');
  const allowedOptions = new Set(['_', 'dry-run', 'output', 'project', 'transaction', 'verbose', 'write']);
  const unknownOption = Object.keys(args).find((key) => !allowedOptions.has(key));
  if (unknownOption) throw new Error(`Unknown recover option: --${unknownOption}`);
  const targetDir = path.resolve(args.project);
  const result = await recoverTransaction({
    id: typeof args.transaction === 'string' ? args.transaction : undefined,
    targetDir,
    write: Boolean(args.write),
  });
  emitReport({
    dryRun: !args.write,
    ok: true,
    ...result,
    status: 'ready',
    targetDir,
  }, args);
}

async function printUsage() {
  console.log('Usage: vibe-harness <init|install|provision|recover|uninstall|validate|verify|baseline|eval|audit|doctor|diff|rollback> [--project path] [--target codex|claude|gemini|cursor|qoder|zcode|antigravity|opencode] [--all-targets] [--profile minimal|core|full|docs-only] [--modules list] [--plugin -all|-rtk|linear-mcp|linear-mcp-readonly ...] [--rtk-hooks on|off] [--tool id] [--write] [--dry-run] [--output json|summary] [--verbose] [--verify] [--force] [--upgrade] [--confirm-red-zone] [--allow-preview] [--allow-manual] [--allow-degraded] [--provision]');
  console.log('All project commands use --project <path>; --target selects an adapter and --write performs mutations. Legacy --apply and path-valued --target are removed.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'help';
  // help/usage is the lowest-friction surface; resolve it before legacy guards so
  // `vibe-harness` / `vibe-harness help` / `vibe-harness unknown-cmd` never trip obsolete-flag errors.
  const knownCommands = new Set(['init', 'install', 'provision', 'validate', 'verify', 'baseline', 'eval', 'audit', 'doctor', 'diff', 'rollback', 'uninstall', 'recover']);
  if (command === 'help' || !knownCommands.has(command)) {
    await printUsage();
    return;
  }
  if (args.apply) throw new Error('Legacy --apply was removed; use --project <path> with --write.');
  if (args.workflow !== undefined) {
    throw Object.assign(new Error('Legacy --workflow was removed; Vibe-Harness now uses one execution path.'), {
      code: 'VIBE_HARNESS_OBSOLETE_GOVERNANCE_CONFIG',
    });
  }
  if (args.profile) validateProfileName(args.profile);
  if (args.target && !mvpTargets.has(args.target)) {
    const error = new Error('--target only accepts adapter ids codex|claude|gemini|cursor|qoder|zcode|antigravity|opencode; use --project <path> for a project path.');
    if (command === 'baseline') error.code = 'BASELINE_PROJECT_REQUIRED';
    throw error;
  }
  if (args.project || command === 'init') {
    await assertNoUnsupportedLegacyAssets(path.resolve(args.project ?? process.cwd()));
  }
  if (command === 'init') {
    await init(args);
  } else if (command === 'install') {
    await install(args);
  } else if (command === 'provision') {
    await provision(args);
  } else if (command === 'validate') {
    await validate(args);
  } else if (command === 'verify') {
    await verify(args);
  } else if (command === 'baseline') {
    await baseline(args);
  } else if (command === 'eval') {
    await evaluateProject(args);
  } else if (command === 'audit') {
    await auditProject(args);
  } else if (command === 'doctor') {
    await doctor(args);
  } else if (command === 'diff') {
    await diff(args);
  } else if (command === 'rollback') {
    await rollback(args);
  } else if (command === 'uninstall') {
    await uninstall(args);
  } else if (command === 'recover') {
    await recover(args);
  }
}

try {
  await main();
} catch (error) {
  const args = parseArgs(process.argv.slice(2));
  emitReport({
    ok: false,
    status: 'invalid',
    error: {
      code: error.code ?? 'VIBE_HARNESS_ERROR',
      message: error.message,
    },
  }, args, { error: true });
  process.exitCode = 1;
}
