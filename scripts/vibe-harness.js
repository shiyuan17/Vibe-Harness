#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectValidationCommands } from './lib/command-status.js';
import { inspectGitHooks } from './lib/git-hooks.js';
import {
  CODEBASE_MEMORY_CACHE_STALE_COPY,
  codebaseMemoryRuntimePresent,
  describeCodebaseMemoryCache,
  removeCodebaseMemoryCache,
} from './lib/codebase-memory-cache.js';
import {
  applyRollbackPlan,
  applyUninstallPlan,
  createRollbackPlan,
  createUninstallPlan,
  hashFile,
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
  strictEnforcementWarnings,
} from './lib/install-planner.js';
import { validatePack } from './lib/pack-validation.js';
import { createVerificationPreflightError, runVerificationPlan } from './lib/project-verification.js';
import { detectProjectProfile } from './lib/project-profile.js';
import {
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
  DEFAULT_VALIDATION_TIER,
  emptyValidationTiers,
  normalizeTierOption,
  planValidationTierMigration,
  validationTiersDeclared,
} from './lib/validation-tiers.js';
import { installPresetForId, parsePresetOption, resolveInstallSurface } from './lib/install-preset.js';
import { collectProjectBaselineInputs, createProjectBaseline } from './lib/project-baseline.js';
import {
  checkProjectEvaluations,
  runProjectEvaluations,
  writeProjectEvaluationReference,
} from './lib/project-evaluation.js';
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
import { AUDIT_KINDS, runProjectAudit } from './lib/project-audit.js';
import { buildImpactMapping, collectChangedDetails, collectChangedPaths } from './lib/change-impact.js';
import { buildVerificationPlan } from './lib/verification-plan.js';

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

function optionalToolFallback(tool) {
  if (tool === 'rtk') return '直接使用原命令并记录该回退。';
  if (tool === 'astGrep') return '改用 rg 或项目搜索命令并记录该回退。';
  return null;
}

/**
 * Cache facts are only reported for projects that actually resolve the tool,
 * so an unrelated project never grows a diagnostic about a cache it does not
 * use. The report covers the location, the freshness stamp and any cache left
 * behind by the pre-0.11.0 layout (those copies are never deleted silently).
 */
async function inspectCodebaseMemoryCache(targetDir, tools = {}) {
  if (!tools?.codebaseMemoryMcp && !(await codebaseMemoryRuntimePresent(targetDir))) return null;
  return describeCodebaseMemoryCache(targetDir);
}

function codebaseMemoryCacheWarnings(cache) {
  if (!cache) return [];
  const warnings = [];
  if (cache.staleCopies.length > 0) {
    warnings.push({
      code: CODEBASE_MEMORY_CACHE_STALE_COPY,
      message: 'Stale codebase-memory index copies exist at '
        + cache.staleCopies.map((item) => `${item.path} (${item.kind})`).join(', ')
        + '; doctor only reports them and never deletes them.',
    });
  }
  if (cache.indexState && cache.freshness.state !== 'fresh') {
    warnings.push({
      code: 'CODEBASE_MEMORY_INDEX_STALE',
      message: 'The codebase-memory index stamp predates the current HEAD ('
        + cache.freshness.reason
        + '); rebuild it through the project command `codebase-memory refresh --project . --write`.',
    });
  }
  return warnings;
}

function planRemovesCodebaseMemoryRuntime(actions = []) {
  return actions.some((action) => String(action?.target ?? action?.relativeTarget ?? '')
    .replaceAll('\\', '/')
    .includes('.agents/runtime/tools/codebase-memory-mcp/'));
}

/**
 * Cleanup runs only when the runtime leaves the project: a targeted uninstall
 * that keeps another adapter keeps the cache, and a dry run reports the
 * intended directory without touching the disk.
 */
async function cleanupCodebaseMemoryCache({ actions = [], dryRun, targetDir }) {
  const runtimeRemoved = !(await codebaseMemoryRuntimePresent(targetDir))
    || planRemovesCodebaseMemoryRuntime(actions);
  if (!runtimeRemoved) return null;
  const cleanup = await removeCodebaseMemoryCache(targetDir, { dryRun });
  return cleanup.reason === 'absent' ? null : cleanup;
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
      ...(normalized.preset ? ['preset: ' + normalized.preset] : []),
      `status: ${normalized.status}`,
      ...(normalized.scopeStatus ? [`scopeStatus: ${normalized.scopeStatus}`] : []),
      ...(normalized.nextTier ? [`nextTier: ${normalized.nextTier}`] : []),
      ...(Array.isArray(normalized.deferredChecks) && normalized.deferredChecks.length > 0
        ? [`deferredChecks: ${normalized.deferredChecks.map((item) => item.id).join(',')}`]
        : []),
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
  const allowedOptions = new Set(['_', 'force', 'preset', 'profile', 'project', 'target', 'targets']);
  const unknownOption = Object.keys(args).find((key) => !allowedOptions.has(key));
  if (unknownOption) throw new Error('Unknown init option: --' + unknownOption);
  const projectDir = path.resolve(args.project ?? process.cwd());
  const existingState = await readInstallState(projectDir);
  const preset = args.preset === undefined ? undefined : parsePresetOption(args.preset);
  const presetProfile = preset ? installPresetForId(preset).profile : null;
  if (presetProfile && args.profile !== undefined && args.profile !== presetProfile) {
    throw new Error('preset ' + preset + ' requires profile ' + presetProfile + ', received --profile ' + args.profile + '.');
  }
  const targets = args.targets === undefined ? undefined : parseTargetsOption(args.targets);
  if (targets && args.target !== undefined) {
    throw new Error('Use --target <adapter> or --targets <adapter,...>, not both.');
  }
  const selectedTargets = targets ?? [args.target ?? existingState?.targets?.[0] ?? 'codex'];
  const result = await writeDefaultProjectConfig({
    force: Boolean(args.force),
    preset,
    profile: presetProfile ?? args.profile ?? existingState?.profile ?? 'core',
    projectDir,
    target: selectedTargets[0],
    targets: selectedTargets,
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
    'plugin', 'preset', 'preserve-retired', 'profile', 'project', 'provision', 'rtk-hooks', 'target', 'upgrade', 'verbose', 'write',
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
  const enforcementPolicy = resolveEnforcementPolicy(config);
  const { configured: targets, selected: selectedTargets } = resolveCommandTargets(config, existingState, args.target);
  const adapterId = selectedTargets[0];
  const adapter = await resolveAdapter(rootDir, adapterId);
  const installSurface = resolveInstallSurface({ args, config, installState: existingState });
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
  const configUpdate = migrateTarget || writePreset || tierMigration
    ? {
        config: {
          ...migratedConfig,
          ...(writePreset ? { preset: installSurface.preset, profile: installSurface.profile } : {}),
          ...(tierMigration
            ? { validationCommands: { ...migratedConfig.validationCommands, tiers: tierMigration.tiers } }
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
  const allowPreview = installSurface.allowPreview;
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
  const provisionRequested = installSurface.provision;
  const provisionExecuted = provisionRequested && !plan.dryRun;
  const tools = provisionExecuted
    ? await provisionWithSignalHandling({
        allowPreview: installSurface.allowPreview,
        mcpConflicts: result.mcpConflicts,
        profile,
        resolvedModules: plan.resolvedModules,
        targetDir,
      })
    : await inspectProfileTools(profile, targetDir, plan.resolvedModules, undefined, {
        allowPreview: installSurface.allowPreview,
      });
  if (provisionExecuted && plannedToolActions.length > 0) {
    await registerGeneratedFile(targetDir, toolStateRelativePath(targetDir));
  }
  let health = provisionExecuted ? healthReport({ profile, tools }) : { ok: true, status: 'ready' };
  const runtimeHooks = await inspectRuntimeHooks(adapter, targetDir);
  const warnings = [
    ...(provisionExecuted
      ? toolWarnings(tools)
      : (plannedToolActions.length > 0 ? [{
          code: 'PROVISIONING_NOT_RUN',
          message: 'Tool provisioning was not run; use vibe-harness provision --project <project> --write.',
        }] : [])),
    ...safetyPostureWarnings(adapter),
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
          preset: writePreset ? installSurface.preset : null,
          profile: writePreset ? installSurface.profile : null,
          relativeTarget: path.relative(targetDir, configUpdate.path).replaceAll('\\', '/'),
        }
      : null,
    deferredToolActions,
    dryRun: plan.dryRun,
    implicitModules: plan.implicitModules,
    plannedToolActions,
    adapterCapabilities: plan.adapterCapabilities,
    linearMcp: plan.linearMcp,
    missingCapabilities: plan.missingCapabilities,
    previewFiles,
    preset: installSurface.preset,
    profile: plan.profile,
    prunedBackups: result.prunedBackups ?? [],
    provisioning: {
      executed: provisionExecuted,
      requested: provisionRequested,
      source: installSurface.provisionSource,
    },
    previewCapabilities: plan.previewCapabilities,
    requestedModules: plan.requestedModules,
    requestedPlugins: plan.requestedPlugins,
    preserveRetired: plan.preserveRetired,
    resolvedModules: plan.resolvedModules,
    roleProjections: plan.roleProjections ?? {},
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
    retained: result.retained,
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
    const rtkHooksSetting = resolveRtkHooksSetting({
      adapterId: adapter.id,
      config,
      installState,
      requestedPlugins: requestedPlugins ?? [],
      targets,
    });
    const rtkHooksEnabled = rtkHooksSetting.enabled;
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
      profile: installSurface.profile,
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
    const tools = await inspectProfileTools(installSurface.profile, targetDir, plan.resolvedModules, undefined, {
      allowPreview: true,
    });
    let health = healthReport({ profile: installSurface.profile, tools });
    const runtimeHooks = await inspectRuntimeHooks(adapter, targetDir);
    const codebaseMemoryCache = await inspectCodebaseMemoryCache(targetDir, tools);
    // Missing tiers stay a hint, not a failure: the effective tiers are derived
    // from the project scripts, and the plan reports which source was used.
    const tiersMissing = !validationTiersDeclared(config.validationCommands?.tiers);
    const warnings = [
      ...toolWarnings(tools),
      ...safetyPostureWarnings(adapter),
      ...runtimeHookWarnings(runtimeHooks, {
        definitionChanged: await hookDefinitionDrift(adapter, targetDir, installState),
        enforcementPolicy,
      }),
      ...strictEnforcementWarnings(target.strictEnforcementRefusals),
      ...roleRuntimeWarnings(target.adapters),
      ...codebaseMemoryCacheWarnings(codebaseMemoryCache),
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
      ...(codebaseMemoryCache ? { codebaseMemoryCache } : {}),
      commandStatus,
      enforcementPolicy,
      strictEnforcementRefusals: target.strictEnforcementRefusals ?? [],
      recommendations: toolRecommendations(tools, installSurface.profile, { adapterId: adapter.id, mvp: true }),
      rtkHooks: rtkHooksReport(rtkHooksEnabled, tools, rtkHooksSetting.source),
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

async function verify(args) {
  if (!args.project) throw new Error('verify requires --project <path>.');
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
  const rtkHooksEnabled = resolveRtkHooksEnabled({
    adapterId: adapter.id,
    config,
    installState,
    requestedPlugins: requestedPlugins ?? [],
    targets,
  });
  const projectProfile = await detectProjectProfile({ config, targetDir });
  const validationCommands = validationCommandView(projectProfile, config);
  const renderData = { ...config, projectProfile, validationCommands };
  const target = await diffMultiTargetInstall({
    allowPreview: true,
    enforcementPolicy,
    managedAgentsBlock: true,
    profile: installSurface.profile,
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
    throw createVerificationPreflightError({
      kind: 'installation',
      message: 'Project installation is not consistent; run vibe-harness validate --project first.',
      report: target,
      targetDir,
    });
  }
  const pack = await validatePack(rootDir);
  if (!pack.ok) {
    throw createVerificationPreflightError({
      kind: 'pack',
      message: 'Vibe-Harness pack validation failed.',
      report: pack,
      targetDir,
    });
  }
  const commandStatus = await inspectValidationCommands({ commands: validationCommands, targetDir });
  // The verification receipt also carries the Hook enforcement posture: under
  // hooks.enforcement "strict" an unproven or denied posture must not read as
  // a green verification run.
  const runtimeHooks = await inspectRuntimeHooks(adapter, targetDir);
  const hookPolicyWarnings = [
    ...safetyPostureWarnings(adapter),
    ...runtimeHookWarnings(runtimeHooks, {
      definitionChanged: await hookDefinitionDrift(adapter, targetDir, installState),
      enforcementPolicy,
    }),
    ...strictEnforcementWarnings(target.strictEnforcementRefusals),
  ];
  const blockingHookFailure = blockingHookWarning(hookPolicyWarnings);
  if (args.tier !== undefined && args.full) {
    throw new Error('Use --tier or --full, not both: --tier selects a cost layer, --full runs the complete matrix.');
  }
  // The fast layer is the default path: standard and deep evidence has to be
  // asked for. `--full` stays the single explicit "complete matrix" door and
  // implies every declared layer.
  const full = Boolean(args.full);
  const tierExplicit = args.tier !== undefined;
  const tier = tierExplicit ? normalizeTierOption(args.tier) : (full ? 'deep' : DEFAULT_VALIDATION_TIER);
  let changedPaths = [];
  let changedDetails = [];
  try {
    changedPaths = await collectChangedPaths({ cwd: targetDir });
    changedDetails = await collectChangedDetails({ cwd: targetDir });
  } catch (error) {
    const detail = String(error?.stderr ?? '') + ' ' + String(error?.message ?? '');
    if (!/not a git repository|不是 git 仓库/iu.test(detail)) throw error;
  }
  const plan = await buildVerificationPlan({
    changedPaths,
    commandStatus,
    config,
    changedDetails,
    targetDir,
    full,
    tier,
    tierExplicit,
    tiers: validationCommands.tiers,
    tierSource: projectProfile.tierSource,
  });
  const planned = { ...plan, impactMapping: buildImpactMapping(changedPaths, plan.selectedChecks) };
  if (args.plan) {
    emitReport({
      ok: true,
      scope: 'project',
      status: 'ready',
      targetDir,
      plan: planned,
    }, args);
    return;
  }
  const verificationReport = await runVerificationPlan({
    allowManual: Boolean(args['allow-manual']),
    commandStatus,
    plan: planned,
    targetDir,
    timeoutMs: config.verification?.timeoutMs,
  });
  emitReport({
    ...verificationReport,
    ...(blockingHookFailure ? { ok: false } : {}),
    deferredChecks: verificationReport.verification?.deferredChecks ?? [],
    enforcementPolicy,
    executionTier: verificationReport.verification?.executionTier ?? null,
    nextTier: verificationReport.verification?.nextTier ?? null,
    runtimeHooks,
    scope: 'project',
    scopeStatus: verificationReport.verification?.scopeStatus ?? 'complete',
    status: verificationReport.ok && !blockingHookFailure ? 'ready' : 'invalid',
    strictEnforcementRefusals: target.strictEnforcementRefusals ?? [],
    targetDir,
    tierFallback: verificationReport.verification?.tierFallback ?? null,
    tierSource: verificationReport.verification?.tierSource ?? null,
    ...(hookPolicyWarnings.length ? { warnings: hookPolicyWarnings } : {}),
  }, args, { error: !verificationReport.ok || Boolean(blockingHookFailure) });
  if (!verificationReport.ok || blockingHookFailure) process.exitCode = 1;
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
    const surface = resolveInstallSurface({ config, installState });
    requestedModules = surface.modules;
    requestedPlugins = surface.plugins;
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
  const validationCommands = validationCommandView(projectProfile, config);
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
      protectedApproval: process.env.VIBE_HARNESS_PROTECTED_APPROVAL === '1',
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
  if (!args.kind) throw new Error(`audit requires --kind ${AUDIT_KINDS.join('|')}.`);
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

/** @param {Record<string, any>} tools @param {string} profile @param {{adapterId?: string, mvp?: boolean}} options */
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
  validateProjectConfig(config);
  const enforcementPolicy = resolveEnforcementPolicy(config);
  const installSurface = resolveInstallSurface({ args, config, installState });
  const profile = validateProfileName(installSurface.profile);
  const requestedPlugins = installSurface.plugins ?? [];
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
    selfCheck: true,
  });
  if (runtimeHooks.selfCheck?.status === 'degraded') health = { ok: false, status: 'degraded' };
  const memory = await inspectMemory(config, installState, targetDir);
  const codebaseMemoryCache = await inspectCodebaseMemoryCache(targetDir, tools);
  const warnings = [
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
    ...codebaseMemoryCacheWarnings(codebaseMemoryCache),
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
    ...(codebaseMemoryCache ? { codebaseMemoryCache } : {}),
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
    rtkHooks: rtkHooksReport(rtkHooksEnabled, tools, rtkHooksSetting.source),
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
    recommendations: toolRecommendations(tools, profile, {
      adapterId: selectedTargets[0],
      mvp: true,
    }),
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
  const rtkHooksEnabled = resolveRtkHooksEnabled({
    adapterId: selectedTargets[0],
    config,
    installState,
    requestedPlugins,
    targets,
  });
  const report = await diffMultiTargetInstall({
    allowPreview: true,
    enforcementPolicy,
    managedAgentsBlock: true,
    profile,
    requestedModules: installSurface.modules ?? installState?.requestedModules,
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
  // The rollback restores the pre-install surface, so the private cache the
  // runtime wrote afterwards would otherwise survive as an orphan.
  const cacheCleanup = await cleanupCodebaseMemoryCache({
    actions: plan.actions,
    dryRun: !args.write,
    targetDir: path.resolve(args.project),
  });
  printRawReport({
    actions: plan.actions,
    applied: result.applied,
    ...(cacheCleanup ? { cacheCleanup } : {}),
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
  const cacheCleanup = await cleanupCodebaseMemoryCache({ actions: plan.actions, dryRun: !args.write, targetDir });
  printRawReport({
    actions: plan.actions,
    applied: result.applied,
    ...(cacheCleanup ? { cacheCleanup } : {}),
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
  const installSurface = resolveInstallSurface({ args, config, installState: state });
  const profile = validateProfileName(installSurface.profile);
  if (profile !== state.profile) {
    throw new Error(`Provision profile ${profile} does not match installed profile ${state.profile}.`);
  }
  const toolIds = selectedToolIds(args.tool);
  const plannedToolActions = createToolProvisioningPlan({
    allowPreview: installSurface.allowPreview,
    profile,
    resolvedModules: state.resolvedModules,
    targetDir,
    toolIds,
  }).map(({ id, mode, phases, supportLevel, version }) => ({ id, mode, phases, supportLevel, version }));
  const dryRun = !args.write;
  const tools = dryRun
    ? await inspectProfileTools(profile, targetDir, state.resolvedModules, toolIds, {
        allowPreview: installSurface.allowPreview,
      })
    : await provisionWithSignalHandling({
        allowPreview: installSurface.allowPreview,
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
    preset: installSurface.preset,
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
  console.log('用法：vibe-harness <init|install|provision|recover|uninstall|validate|verify|baseline|eval|audit|doctor|diff|rollback> [--project path] [--target codex|claude|gemini|cursor|qoder|zcode|antigravity|opencode] [--targets codex,zcode,opencode (仅 init)] [--all-targets] [--profile minimal|core|full|docs-only] [--preset everything] [--modules list] [--plugin -all|-rtk|linear-mcp|linear-mcp-readonly ...] [--rtk-hooks on|off] [--tool id] [--write] [--dry-run] [--output json|summary] [--verbose] [--verify] [--full] [--tier quick|standard|deep] [--plan] [--force] [--upgrade] [--preserve-retired] [--confirm-red-zone] [--allow-preview] [--allow-manual] [--allow-degraded] [--provision]');
  console.log('所有项目命令使用 --project <path>；--target 只选择 adapter，--targets 只在 init 时声明多宿主目标，--write 执行真实写入。旧版 --apply 和取路径值的 --target 已移除。');
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
  if (args.preset !== undefined && !['init', 'install'].includes(command)) {
    throw new Error('--preset is only accepted by init and install; other commands read the preset from vibe-harness.config.json.');
  }
  if (args.preset !== undefined) parsePresetOption(args.preset);
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
      ...(error.details ? { details: error.details } : {}),
      message: error.message,
    },
  }, args, { error: true });
  process.exitCode = 1;
}
