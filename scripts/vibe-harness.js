#!/usr/bin/env node
import path from 'node:path';
import { overrideWarnings } from '../runtime/lib/delivery.mjs';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { inspectValidationCommands } from './lib/command-status.js';
import { inspectGitHooks } from './lib/git-hooks.js';
import { migrateRetiredTools } from './lib/retired-tools.js';
import {
  applyRollbackPlan,
  applyUninstallPlan,
  createRollbackPlan,
  createUninstallPlan,
  hashFile,
  readInstallState,
  stateFilePath,
} from './lib/install-state.js';
import { pathExists } from './lib/manifest.js';
import {
  applyInstallPlan,
  createMultiTargetInstallPlan,
  diffMultiTargetInstall,
  isMutatingInstallAction,
  previewInstallPlan,
  strictEnforcementWarnings,
} from './lib/install-planner.js';
import { validatePack } from './lib/pack-validation.js';
import { detectProjectProfile } from './lib/project-profile.js';
import {
  defaultWorktreeMirrors,
  parseTargetsOption,
  readRequiredProjectConfig,
  resolveEnforcementPolicy,
  validationCommandView,
  validateConfigAndGeneratedContent,
  validateProjectConfig,
  validateProjectConfigWithSchema,
  mvpTargets,
  migrateLegacyProjectConfig,
  projectTargets,
  validateProfileName,
  writeDefaultProjectConfig,
} from './lib/project-config.js';
import {
  emptyValidationTiers,
  planValidationTierMigration,
  validationTiersDeclared,
} from './lib/validation-tiers.js';
import { resolveInstallSurface } from './lib/install-preset.js';
import { canonicalAgentsTemplate, loadAdapterCatalog, resolveAdapter } from './lib/adapter.js';
import { safetyPostureWarnings } from './lib/safety-posture.js';
import {
  blockingHookWarning,
  hookDefinitionDrift,
  hookDefinitionPath,
  inspectMemory,
  inspectRuntimeHooks,
  runtimeHookWarnings,
} from './lib/runtime-diagnostics.js';
import {
  inspectProvisioningMarker,
  inspectProfileTools,
  toolWarnings,
} from './lib/tool-provisioning.js';
import { inspectTransactions, recoverTransaction } from './lib/file-transaction.js';
import { assertNoUnsupportedLegacyAssets } from './lib/project-layout.js';
import { findNestedInstallations, nestedInstallMigrationCommands } from './lib/nested-install.js';
import { sanitizePublicReport } from './lib/tool-provisioning/subprocess.js';

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

// Signal 0 only probes process existence: ESRCH means the pid is gone, EPERM
// means the process exists but is protected. Any other failure counts as gone
// so the stale classification always names a recovery path.
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function provisioningProcessWarning(marker) {
  const parentPid = Number(marker.parentPid);
  if (marker.status === 'active' && Number.isInteger(parentPid) && parentPid > 0 && !processAlive(parentPid)) {
    return {
      code: 'PROVISIONING_MARKER_STALE',
      message: `Provisioning marker reports an active process (parent pid ${parentPid}) that no longer exists; re-run provisioning with --write to refresh it, or uninstall/rollback to retire it.`,
    };
  }
  return {
    code: 'PROVISIONING_PROCESS_INCOMPLETE',
    message: `Provisioning process state is ${marker.status}.`,
  };
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
      roleProjection: item.roleProjection ?? null,
      status: item.status,
    }])),
    changed: (report.changed ?? []).map(({ target }) => ({ target })),
    enforcementPolicy: report.enforcementPolicy ?? 'advisory',
    missing: (report.missing ?? []).map(({ target }) => ({ target })),
    ok: report.ok,
    profile: report.profile,
    redZone: (report.redZone ?? []).map(({ status, target }) => ({ status, target })),
    staleProjections: report.staleProjections ?? [],
    strictEnforcementRefusals: report.strictEnforcementRefusals ?? [],
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

function roleRuntimeReport(adapters = {}) {
  return Object.fromEntries(Object.entries(adapters)
    .filter(([, item]) => item.roleProjection)
    .map(([id, item]) => {
      const projection = item.roleProjection;
      const manual = projection.activation === 'manual';
      return [id, {
        permissionMapping: projection.permissionMapping,
        roleCount: projection.roles.length,
        // The merged status stays a statement about generated files only; the
        // four fields below keep "written", "loaded", "bound" and "usable now"
        // from being read as one conclusion.
        status: manual ? 'manual-activation-required' : 'configured-unverified',
        fileGenerated: 'generated',
        hostActivated: manual ? 'manual-activation-required' : 'automatic',
        toolBinding: projection.toolBinding ?? 'configured-unverified',
        currentTaskExecutable: false,
        activationPath: projection.activationPath,
        missingCapabilities: projection.missingCapabilities ?? {},
      }];
    }));
}

function roleRuntimeWarnings(adapters = {}) {
  return Object.entries(adapters).flatMap(([id, item]) => {
    const projection = item.roleProjection;
    if (!projection) return [];
    return [
      ...(projection.activation === 'manual' ? [{
        code: 'ROLE_ACTIVATION_MANUAL',
        message: id + ' 的 role plugin 需要手动激活，位置：' + (projection.activationPath ?? '生成的项目本地目录') + '；请在 ' + id + ' 中启用该项目插件。'
      }] : []),
      ...(projection.permissionMapping === 'degraded-permission-mapping' ? [{
        code: 'ROLE_PERMISSION_MAPPING_DEGRADED',
        message: id + ' 无法原生强制所有角色权限；严格的父级 sandbox 和 Prompt guard 仍然有效。',
      }] : []),
      ...(projection.toolBinding === 'configured-unverified' ? [{
        code: 'ROLE_TOOL_BINDING_UNVERIFIED',
        message: id + ' 的角色工具绑定尚未验证（宿主读取角色文件的路径或工具名未经实证）；在完成真机核验前只按文件已生成处理。',
      }] : []),
    ];
  });
}

function summaryText(value, maxLength = 480) {
  const compact = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function toolSummaryLines(tools = {}, recommendations = []) {
  return Object.entries(tools).flatMap(([tool, state]) => {
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
      ...(recommendation?.command || recommendation?.message ? [`next: ${recommendation.command ?? recommendation.message}`] : []),
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
      ...(normalized.runtimeHooks ? ['runtimeHooks: ' + normalized.runtimeHooks.activation.status + ' (' + normalized.runtimeHooks.activation.mechanism + ')'] : []),
      ...(normalized.memory ? ['memory: runtime=' + normalized.memory.runtime.status + ', durable=' + normalized.memory.durable.status] : []),
      ...(normalized.preset ? ['preset: ' + normalized.preset] : []),
      `status: ${normalized.status}`,
      ...(normalized.scopeStatus ? [`scopeStatus: ${normalized.scopeStatus}`] : []),
      ...(normalized.nextTier ? [`nextTier: ${normalized.nextTier}`] : []),
      ...(Array.isArray(normalized.deferredChecks) && normalized.deferredChecks.length > 0
        ? [`deferredChecks: ${normalized.deferredChecks.map((item) => item.id).join(',')}`]
        : []),
      ...(normalized.profile ? [`profile: ${normalized.profile}`] : []),
      ...(Array.isArray(normalized.requestedPlugins) ? [`plugins: ${normalized.requestedPlugins.length ? normalized.requestedPlugins.join(',') : 'none'}`] : []),
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

// diff/rollback/uninstall print raw plan reports; redact them through the
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

async function init(args) {
  const allowedOptions = new Set(['_', 'force', 'project', 'target', 'targets', 'write', 'dry-run', 'confirm-red-zone', 'output', 'verbose']);
  const unknownOption = Object.keys(args).find((key) => !allowedOptions.has(key));
  if (unknownOption) throw new Error('Unknown init option: --' + unknownOption);
  if (args.write && !args['confirm-red-zone']) {
    throw new Error('Writing vibe-harness.config.json requires --confirm-red-zone.');
  }
  const projectDir = path.resolve(args.project);
  const targets = args.targets === undefined ? undefined : parseTargetsOption(args.targets);
  if (targets && args.target !== undefined) {
    throw new Error('Use --target <adapter> or --targets <adapter,...>, not both.');
  }
  const selectedTargets = targets ?? [args.target ?? 'codex'];
  const result = await writeDefaultProjectConfig({
    dryRun: !args.write,
    force: Boolean(args.force),
    projectDir,
    target: selectedTargets[0],
    targets: selectedTargets,
  });
  emitReport({
    ok: true,
    dryRun: !args.write,
    config: result.config,
    path: result.path,
    written: args.write ? [result.path] : [],
  }, args);
}

async function install(args) {
  if (!args.project) throw new Error('install requires --project <path>; legacy --target path and --apply were removed.');
  const allowedOptions = new Set([
    '_', 'confirm-red-zone', 'dry-run', 'force', 'output',
    'preserve-retired', 'preserve-user-modified', 'project', 'target', 'upgrade', 'verbose', 'write',
  ]);
  const unknownOption = Object.keys(args).find((key) => !allowedOptions.has(key));
  if (unknownOption) throw new Error(`Unknown install option: --${unknownOption}`);
  const isMvpMode = true;
  const writeRequested = Boolean(args.write);
  const dryRunRequested = Boolean(args['dry-run']) || !writeRequested;
  if (args['preserve-user-modified'] && !args.upgrade) {
    throw new Error('--preserve-user-modified requires --upgrade.');
  }
  if (args['preserve-user-modified'] && args.force) {
    throw new Error('--preserve-user-modified cannot be combined with --force.');
  }
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
  const toolMigration = args.upgrade ? migrateRetiredTools(sourceConfig, existingState) : { config: sourceConfig, removed: [] };
  const config = toolMigration.config;
  const enforcementPolicy = resolveEnforcementPolicy(config);
  const { configured: targets, selected: selectedTargets } = resolveCommandTargets(config, existingState, args.target);
  const adapterId = selectedTargets[0];
  const adapter = await resolveAdapter(rootDir, adapterId);
  const resolvedInstallSurface = resolveInstallSurface({ args, config, installState: existingState });
  const installSurface = resolvedInstallSurface;
  const profile = validateProfileName(installSurface.profile);
  const effectiveConfig = {
    ...config,
    ...(installSurface.preset ? { preset: installSurface.preset } : {}),
    profile,
  };
  validateProjectConfigWithSchema(effectiveConfig);
  const projectProfile = await detectProjectProfile({ config: effectiveConfig, targetDir });
  const validationCommands = validationCommandView(projectProfile, effectiveConfig);
  const renderData = {
    ...effectiveConfig,
    profile,
    projectProfile,
    target: adapterId,
    targets,
    validationCommands,
  };
  const requestedModules = installSurface.modules;
  const requestedPlugins = installSurface.plugins;

  const migratedConfig = migrateLegacyProjectConfig(config);
  const writePreset = Boolean(installSurface.preset)
    && (config.preset !== installSurface.preset || config.profile !== installSurface.profile);
  // Tier migration is upgrade-only: a project that already declared its tiers
  // keeps them, and only missing keys are filled from the detected project
  // facts. An empty array is a deliberate "this tier is disabled" statement.
  const tierMigration = args.upgrade
    ? planValidationTierMigration({
        configuredTiers: config.validationCommands?.tiers,
        derivedTiers: projectProfile.derivedValidationTiers ?? emptyValidationTiers(),
      })
    : null;
  const migrateTarget = Object.hasOwn(config, 'target') && Boolean(args.upgrade);
  // Seed `worktree.mirrors` once, from the resolved install surface, so a
  // project upgraded from before the key existed still gets its governance
  // surface projected into every worktree. A project that already declares the
  // key keeps its own list untouched.
  const mirrorsSeed = Object.hasOwn(config.worktree ?? {}, 'mirrors')
    ? null
    : defaultWorktreeMirrors({
        plugins: [...new Set([...(config.plugins ?? []), ...(requestedPlugins ?? [])])],
        targets: projectTargets(config),
        target: adapterId,
      });
  const seedMirrors = Boolean(mirrorsSeed && mirrorsSeed.length > 0);
  const configUpdate = toolMigration.removed.length > 0 || migrateTarget || writePreset || tierMigration || seedMirrors
    ? {
        config: {
          ...migratedConfig,
          ...(writePreset ? { preset: installSurface.preset, profile: installSurface.profile } : {}),
          ...(tierMigration
            ? { validationCommands: { ...migratedConfig.validationCommands, tiers: tierMigration.tiers } }
            : {}),
          ...(seedMirrors
            ? { worktree: { ...migratedConfig.worktree, mirrors: mirrorsSeed } }
            : {}),
        },
        path: path.join(targetDir, 'vibe-harness.config.json'),
      }
    : null;
  if (writePreset && !dryRunRequested && !args['confirm-red-zone']) {
    throw new Error('Refusing to persist the project preset in vibe-harness.config.json without explicit red-zone confirmation; retry with --confirm-red-zone.');
  }
  if (tierMigration && !dryRunRequested && !args['confirm-red-zone']) {
    throw new Error(
      'Refusing to persist validationCommands.tiers in vibe-harness.config.json without explicit red-zone confirmation; retry with --confirm-red-zone.',
    );
  }
  if (seedMirrors && !dryRunRequested && !args['confirm-red-zone']) {
    throw new Error(
      'Refusing to persist worktree.mirrors in vibe-harness.config.json without explicit red-zone confirmation; retry with --confirm-red-zone.',
    );
  }
  if (toolMigration.removed.length > 0 && !dryRunRequested && !args['confirm-red-zone']) {
    throw new Error('Retiring tool configuration requires --confirm-red-zone.');
  }
  const plan = await createMultiTargetInstallPlan({
    configUpdate,
    allowPreview: installSurface.allowPreview,
    dryRun: dryRunRequested,
    enforcementPolicy,
    force: Boolean(args.force),
    managedAgentsBlock: isMvpMode,
    profile,
    requestedModules,
    requestedPlugins,
    preserveRetired: Boolean(args['preserve-retired']),
    preserveUserModified: Boolean(args['preserve-user-modified']),
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
  // The host trust record is keyed on the Hook definition text, so an install
  // that rewrites that text invalidates the host's record. Compare the file
  // around the write: after the install the recorded hash matches the new file
  // by construction, so the post-install drift check cannot see this case.
  const installedHookDefinition = hookDefinitionPath(adapter, targetDir);
  const hookDefinitionBefore = installedHookDefinition && await pathExists(installedHookDefinition)
    ? await hashFile(installedHookDefinition)
    : null;
  const result = await applyInstallPlan(plan);
  const hookDefinitionChanged = Boolean(hookDefinitionBefore)
    && installedHookDefinition
    && await pathExists(installedHookDefinition)
    && await hashFile(installedHookDefinition) !== hookDefinitionBefore;
  const previewFiles = plan.dryRun ? await previewInstallPlan(plan, { includeContent: Boolean(args.verbose) }) : [];
  let health = { ok: true, status: 'ready' };
  const runtimeHooks = await inspectRuntimeHooks(adapter, targetDir);
  // Project-owned seeds keep whatever the project wrote into them. The plan
  // marks the targets whose content is retained instead of reinstalled, so both
  // the dry-run plan and the write report can name them instead of letting a
  // memory file silently drift away from install-state.
  const retainedProjectOwned = (plan.actions ?? [])
    .filter((action) => action.projectContentRetained === true)
    .map((action) => ({ reason: 'project-owned-drift', target: action.relativeTarget }));
  const retainedUserModified = (plan.actions ?? [])
    .filter((action) => action.kind === 'user-modified' && !action.projectOwned)
    .map((action) => ({ reason: 'user-modified-file-preserved', target: action.relativeTarget }));
  const warnings = [
    ...safetyPostureWarnings(adapter),
    ...(retainedProjectOwned.length > 0 ? [{
      code: 'PROJECT_OWNED_FILE_RETAINED',
      message: 'Kept project-owned content and re-recorded it as the baseline: '
        + retainedProjectOwned.map((item) => item.target).join(', ') + '.',
    }] : []),
    ...(retainedUserModified.length > 0 ? [{
      code: 'USER_MODIFIED_FILES_PRESERVED',
      message: 'Preserved user-modified files without advancing their install-state baselines: '
        + retainedUserModified.map((item) => item.target).join(', ') + '.',
    }] : []),
    ...(seedMirrors ? [{
      code: 'WORKTREE_MIRRORS_SEEDED',
      message: 'Recorded worktree.mirrors (' + mirrorsSeed.join(', ') + ') in vibe-harness.config.json so worktrees project the governance surface; rerun `worktree bootstrap` for existing worktrees.',
    }] : []),
    ...runtimeHookWarnings(runtimeHooks, { definitionChanged: hookDefinitionChanged, enforcementPolicy }),
    ...strictEnforcementWarnings(plan.strictEnforcementRefusals),
    ...(result.backupRetentionError ? [{
      code: 'BACKUP_RETENTION_FAILED',
      message: 'Install committed, but pruning old backups failed: ' + result.backupRetentionError,
    }] : []),
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
    ...Object.entries(plan.roleProjections ?? {})
      .flatMap(([target, projection]) => [
        ...(projection.activation === 'manual' ? [{
          code: 'ROLE_ACTIVATION_MANUAL',
          message: target + ' role plugin requires manual activation from the generated project-local directory.',
        }] : []),
        ...(projection.permissionMapping === 'degraded-permission-mapping' ? [{
          code: 'ROLE_PERMISSION_MAPPING_DEGRADED',
          message: target + ' cannot enforce every role permission natively; the strict parent sandbox and Prompt guard remain authoritative.',
        }] : []),
      ]),
  ];
  // A blocking Hook warning (hooks.enforcement "strict") downgrades an
  // otherwise ready install to degraded so the exit code carries the posture.
  if (blockingHookWarning(warnings) && health.status === 'ready') {
    health = { ok: false, status: 'degraded' };
  }
  emitReport({
    ...health,
    enforcementPolicy,
    strictEnforcementRefusals: plan.strictEnforcementRefusals ?? [],
    actions: args.verbose ? plan.actions : plan.actions.map(compactAction),
    backupActions: plan.baselinePlan.actions,
    backupRetentionError: result.backupRetentionError ?? null,
    baselineId: result.baseline?.id ?? plan.baselinePlan.baselineId,
    configUpdate: configUpdate
      ? {
          ...(tierMigration
            ? { addedTiers: tierMigration.addedTiers, tiers: tierMigration.tiers }
            : {}),
          ...(seedMirrors ? { mirrors: mirrorsSeed } : {}),
          preset: writePreset ? installSurface.preset : null,
          profile: writePreset ? installSurface.profile : null,
          relativeTarget: path.relative(targetDir, configUpdate.path).replaceAll('\\', '/'),
        }
      : null,
    dryRun: plan.dryRun,
    implicitModules: plan.implicitModules,
    adapterCapabilities: plan.adapterCapabilities,
    linearMcp: plan.linearMcp,
    missingCapabilities: plan.missingCapabilities,
    previewFiles,
    preset: installSurface.preset,
    profile: plan.profile,
    prunedBackups: result.prunedBackups ?? [],
    previewCapabilities: plan.previewCapabilities,
    requestedModules: plan.requestedModules,
    requestedPlugins: plan.requestedPlugins,
    preserveRetired: plan.preserveRetired,
    preserveUserModified: plan.preserveUserModified,
    resolvedModules: plan.resolvedModules,
    roleProjections: plan.roleProjections ?? {},
    runtimeHooks,
    requiresRedZoneConfirmation: plan.dryRun
      && !args['confirm-red-zone']
      && plan.actions.some((action) => action.redZone
        && isMutatingInstallAction(action)),
    target: isMvpMode && selectedTargets.length === 1 ? adapterId : undefined,
    targets: selectedTargets,
    ...(args.verbose ? { targetDir: plan.targetDir } : {}),
    warnings,
    retired: result.retired,
    retiredToolConfiguration: toolMigration.removed,
    retained: result.retained,
    retainedProjectOwned,
    retainedUserModified,
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
    validateProjectConfig(config);
    const enforcementPolicy = resolveEnforcementPolicy(config);
    const installSurface = resolveInstallSurface({ args, config, installState });
    const requestedModules = installSurface.modules;
    const requestedPlugins = installSurface.plugins;
    const adapter = await resolveAdapter(rootDir, selectedTargets[0]);
    const projectProfile = await detectProjectProfile({ config, targetDir });
    const validationCommands = validationCommandView(projectProfile, config);
    const plan = await createMultiTargetInstallPlan({
      allowPreview: true,
      dryRun: true,
      enforcementPolicy,
      force: true,
      managedAgentsBlock: true,
      profile: installSurface.profile,
      requestedModules,
      requestedPlugins,
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
      profile: installSurface.profile,
      requestedModules,
      requestedPlugins,
      renderData: { ...config, projectProfile, validationCommands },
      rootDir,
      selectedTargets,
      targetDir,
      targets,
    });
    if (!target.ok) {
      // The inconsistency report is the *only* signal a project in drift gets,
      // so it must still carry the host-side posture: a project can be fully
      // installed and still have its Hook disabled in the host, and that is
      // exactly when the operator needs the reminder. Skipping it here would
      // leave `validate` quieter than `doctor` on the same machine state.
      const runtimeHooks = await inspectRuntimeHooks(adapter, targetDir);
      emitReport({
        ok: false,
        scope: 'project',
        ...(args.verbose ? { targetDir } : {}),
        runtimeHooks,
        target: args.verbose ? target : compactTargetReport(target),
        warnings: [
          ...overrideWarnings(config),
          ...safetyPostureWarnings(adapter),
          ...runtimeHookWarnings(runtimeHooks, {
            definitionChanged: await hookDefinitionDrift(adapter, targetDir, installState),
            enforcementPolicy,
          }),
          ...strictEnforcementWarnings(target.strictEnforcementRefusals),
        ],
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
    const tools = await inspectProfileTools(installSurface.profile, targetDir, plan.resolvedModules, undefined, {
      allowPreview: true,
    });
    let health = healthReport({ profile: installSurface.profile, tools });
    const runtimeHooks = await inspectRuntimeHooks(adapter, targetDir);
    // Missing tiers stay a hint, not a failure: the effective tiers are derived
    // from the project scripts, and the plan reports which source was used.
    const tiersMissing = !validationTiersDeclared(config.validationCommands?.tiers);
    const warnings = [
      ...overrideWarnings(config),
      ...toolWarnings(tools),
      ...safetyPostureWarnings(adapter),
      ...runtimeHookWarnings(runtimeHooks, {
        definitionChanged: await hookDefinitionDrift(adapter, targetDir, installState),
        enforcementPolicy,
      }),
      ...strictEnforcementWarnings(target.strictEnforcementRefusals),
      ...roleRuntimeWarnings(target.adapters),
      ...(tiersMissing ? [{
        code: 'VALIDATION_TIERS_NOT_CONFIGURED',
        message: 'Add validationCommands.tiers (quick/standard/deep) or declare the matching package scripts; verify falls back to the detected project commands.',
      }] : []),
    ];
    if (blockingHookWarning(warnings) && health.status === 'ready') {
      health = { ok: false, status: 'degraded' };
    }
    emitReport({
      ...health,
      commandStatus,
      enforcementPolicy,
      strictEnforcementRefusals: target.strictEnforcementRefusals ?? [],
      recommendations: toolRecommendations(tools),
      runtimeHooks,
      roles: roleRuntimeReport(target.adapters),
      scope: 'project',
      preset: installSurface.preset,
      tierSource: projectProfile.tierSource,
      targets: selectedTargets,
      ...(args.verbose ? { targetDir } : {}),
      validationTiers: projectProfile.validationTiers,
      tools,
      warnings,
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






/** @param {Record<string, any>} tools */
function toolRecommendations(tools) {
  return Object.entries(tools).flatMap(([tool, state]) => {
    if (state.status === 'unsupported') {
      const fallback = 'Use the project-supported fallback and record the limitation.';
      return [{
        action: 'fallback',
        ...(state.code ? { code: state.code } : {}),
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
          message: `Inspect the project's ${tool} configuration using the host's native tooling.`,
          phase: state.phase,
          tool,
        }];
      }
      return [{
        action: 'use-native-tooling',
        code: state.code,
        ...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
        message: `Vibe-Harness no longer provisions ${tool}; manage it with the host or project-native tooling.`,
        phase: state.phase,
        tool,
      }];
    }
    if (state.status === 'pending-config') {
      return [{
        action: 'configure-credentials',
        message: `Manage ${tool} credentials through the host or project-native tooling.`,
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
  validateProjectConfig(config);
  const enforcementPolicy = resolveEnforcementPolicy(config);
  const installSurface = resolveInstallSurface({ args, config, installState });
  const profile = validateProfileName(installSurface.profile);
  const requestedPlugins = installSurface.plugins ?? [];
  const managedAgentsBlock = installState?.files?.some(
    (file) => ['managed-block', 'managed-instruction-block'].includes(file.contentStrategy),
  );
  const detectedProfile = await detectProjectProfile({ config, targetDir });
  let renderData = { ...config, profile };
  if (managedAgentsBlock) {
    renderData = {
      ...config,
      profile,
      projectProfile: detectedProfile,
      validationCommands: validationCommandView(detectedProfile, config),
    };
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
    enforcementPolicy,
    managedAgentsBlock: true,
    profile,
    requestedModules: installState?.requestedModules,
    requestedPlugins,
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
    selfCheck: true,
  });
  if (runtimeHooks.selfCheck?.status === 'degraded') health = { ok: false, status: 'degraded' };
  const memory = await inspectMemory(config, installState, targetDir);
  const warnings = [
    ...overrideWarnings(config),
    ...toolWarnings(tools),
    ...(provisioningProcess ? [provisioningProcessWarning(provisioningProcess)] : []),
    ...(nestedInstallations.length > 0 ? [{
      code: 'NESTED_INSTALLATIONS_FOUND',
      message: nestedInstallations.length + ' nested Vibe-Harness installation(s) require explicit migration and uninstall.',
    }] : []),
    ...safetyPostureWarnings(adapter),
    ...runtimeHookWarnings(runtimeHooks, {
      definitionChanged: await hookDefinitionDrift(adapter, targetDir, installState),
      enforcementPolicy,
    }),
    ...strictEnforcementWarnings(target?.strictEnforcementRefusals),
    ...roleRuntimeWarnings(target?.adapters),
    ...(pack.instructionBudgetWarnings ?? []).map((message) => ({
      code: 'INSTRUCTION_BUDGET',
      message,
    })),
  ];
  if (blockingHookWarning(warnings) && health.status === 'ready') {
    health = { ok: false, status: 'degraded' };
  }
  emitReport({
    ...health,
    enforcementPolicy,
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
    runtimeHooks,
    roles: roleRuntimeReport(target?.adapters),
    provisioningProcess,
    preset: installSurface.preset,
    ...(args.verbose ? { rootDir } : {}),
    target,
    ...(args.verbose ? { targetDir } : {}),
    tierSource: detectedProfile.tierSource ?? 'empty',
    validationTiers: detectedProfile.validationTiers ?? emptyValidationTiers(),
    tools,
    transactionLock,
    transactions,
    recommendations: toolRecommendations(tools),
    warnings,
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
  validateProjectConfig(config);
  const enforcementPolicy = resolveEnforcementPolicy(config);
  const installSurface = resolveInstallSurface({ args, config, installState });
  const profile = validateProfileName(installSurface.profile);
  const projectProfile = await detectProjectProfile({ config, targetDir });
  const validationCommands = validationCommandView(projectProfile, config);
  const renderData = { ...config, profile, projectProfile, validationCommands };
  const requestedPlugins = installSurface.plugins;
  const report = await diffMultiTargetInstall({
    allowPreview: true,
    enforcementPolicy,
    managedAgentsBlock: true,
    profile,
    requestedModules: installSurface.modules ?? installState?.requestedModules,
    requestedPlugins,
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
  console.log('用法：vibe-harness <init|install|validate|doctor|diff|rollback|uninstall|recover|help> --project <path>');
  console.log('安装生命周期参数：--target <adapter>、--targets <adapter,...>（仅 init）、--all-targets、--write、--dry-run、--force、--upgrade、--preserve-retired、--preserve-user-modified、--confirm-red-zone、--output json|summary、--verbose。');
  console.log('项目执行、任务、验证、评测、审计和工具托管命令已退役；请使用宿主能力与项目原生命令。');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'help';
  const knownCommands = new Set(['init', 'install', 'validate', 'doctor', 'diff', 'rollback', 'uninstall', 'recover', 'help']);
  if (!knownCommands.has(command)) {
    throw Object.assign(new Error(`Unknown or retired command: ${command}. Use the host or project-native tools.`), {
      code: 'VIBE_HARNESS_COMMAND_UNSUPPORTED',
    });
  }
  const allowedOptions = new Set(['_', 'project', 'target', 'targets', 'all-targets', 'write', 'dry-run',
    'force', 'upgrade', 'preserve-retired', 'preserve-user-modified', 'confirm-red-zone',
    'output', 'verbose', 'transaction', 'help']);
  const unknownOption = Object.keys(args).find((key) => !allowedOptions.has(key));
  if (unknownOption) throw new Error(`Unknown or retired option: --${unknownOption}`);
  if (args._.length > 1) throw new Error('Unexpected positional argument.');
  if (command === 'help' || args.help) {
    await printUsage();
    return;
  }
  if (typeof args.project !== 'string' || args.project.length === 0) throw new Error('A project command requires --project <path>.');
  if (args.write && args['dry-run']) throw new Error('Use --write or --dry-run, not both.');
  if (args.targets !== undefined) {
    if (command !== 'init') throw new Error('--targets is only accepted by init.');
    parseTargetsOption(args.targets);
  }
  if (args.target && !mvpTargets.has(args.target)) {
    throw Object.assign(new Error('--target only accepts adapter ids codex|claude|gemini|cursor|qoder|zcode|antigravity|opencode; use --project <path> for a project path.'), {
      ...(command === 'baseline' ? { code: 'BASELINE_PROJECT_REQUIRED' } : {}),
    });
  }
  if (args.project || command === 'init') {
    await assertNoUnsupportedLegacyAssets(path.resolve(args.project ?? process.cwd()));
  }
  if (command === 'init') {
    await init(args);
  } else if (command === 'install') {
    await install(args);
  } else if (command === 'validate') {
    await validate(args);
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
      ...(error.details ? { details: error.details } : {}),
      message: error.message,
    },
  }, { ...args, project: typeof args.project === 'string' ? args.project : undefined,
    output: ['json', 'summary'].includes(args.output) ? args.output : 'json' }, { error: true });
  process.exitCode = 1;
}
