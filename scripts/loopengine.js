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
} from './lib/install-state.js';
import { readJson } from './lib/manifest.js';
import {
  applyInstallPlan,
  createInstallPlan,
  diffTargetInstall,
  inspectTargetInstall,
  previewInstallPlan,
} from './lib/install-planner.js';
import { validatePack } from './lib/pack-validation.js';
import { executeProjectVerification } from './lib/project-verification.js';
import { detectProjectProfile } from './lib/project-profile.js';
import {
  readRequiredProjectConfig,
  resolveGovernanceMode,
  resolveValidationCommands,
  validateConfigAndGeneratedContent,
  validateGovernanceModeForProfile,
  validateProjectConfig,
  writeDefaultProjectConfig,
} from './lib/project-config.js';
import { collectProjectBaselineInputs, createProjectBaseline } from './lib/project-baseline.js';
import {
  checkProjectEvaluations,
  runProjectEvaluations,
  writeProjectEvaluationReference,
} from './lib/project-evaluation.js';
import { parseModulesOption } from './lib/module-selection.js';
import { resolveAdapter } from './lib/adapter.js';
import { readFile } from 'node:fs/promises';
import {
  createToolProvisioningPlan,
  inspectProfileTools,
  provisionProfileTools,
  toolWarnings,
} from './lib/tool-provisioning.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requiredToolsDegraded(profile, tools = {}) {
  return ['full', 'codex-internal'].includes(profile)
    && Object.values(tools).some((tool) => tool.status !== 'ready');
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
    ok: report.ok,
    profile: report.profile,
    redZone: (report.redZone ?? []).map(({ status, target }) => ({ status, target })),
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

function toolSummaryLines(tools = {}, recommendations = []) {
  return Object.entries(tools).flatMap(([tool, state]) => {
    if (state.status !== 'degraded') return [];
    const diagnostic = state.diagnostic;
    const details = diagnostic?.stderrTail ?? diagnostic?.stdoutTail;
    const recommendation = recommendations.find((item) => item.tool === tool);
    return [
      `tool: ${tool}`,
      `phase: ${state.phase}`,
      `reason: ${summaryText(diagnostic?.message ?? `${tool} is degraded during ${state.phase}.`)}`,
      ...(details && details !== diagnostic?.message ? [`details: ${summaryText(details)}`] : []),
      ...(diagnostic?.exitCode !== undefined ? [`exitCode: ${diagnostic.exitCode}`] : []),
      ...(diagnostic?.truncated ? ['detailsTruncated: true'] : []),
      ...(recommendation?.command || recommendation?.message ? [`next: ${recommendation.command ?? recommendation.message}`] : []),
    ];
  });
}

function emitReport(report, args, { error = false } = {}) {
  const normalized = normalizeReport(report);
  const output = args.output ?? 'json';
  if (!['json', 'summary'].includes(output)) throw new Error(`Unknown output format: ${output}`);
  if (output === 'summary') {
    const lines = [
      `status: ${normalized.status}`,
      ...(normalized.profile ? [`profile: ${normalized.profile}`] : []),
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

async function projectRequestedModules(config, targetDir) {
  if (config.modules) return config.modules;
  return (await readInstallState(targetDir))?.requestedModules ?? undefined;
}

async function init(args) {
  const projectDir = path.resolve(args.project ?? process.cwd());
  const result = await writeDefaultProjectConfig({
    force: Boolean(args.force),
    projectDir,
    target: args.target ?? 'codex',
  });
  console.log(JSON.stringify({
    config: result.config,
    path: result.path,
    written: [result.path],
  }, null, 2));
}

async function install(args) {
  const isMvpMode = Boolean(args.project);
  if (!isMvpMode && ['claude', 'gemini'].includes(args.target)) {
    throw new Error('Legacy/internal install is Codex-only; use --project <path> --target <claude|gemini> for MVP adapters.');
  }
  const writeRequested = Boolean(args.write || args.apply);
  const dryRunRequested = Boolean(args['dry-run']) || !writeRequested;
  if ((args.apply || args.write) && args['dry-run']) {
    throw new Error('Use --write/--apply or --dry-run, not both.');
  }
  const targetDir = isMvpMode ? path.resolve(args.project) : path.resolve(args.target ?? process.cwd());
  const config = isMvpMode ? await readRequiredProjectConfig(targetDir) : null;
  const adapterId = isMvpMode ? (args.target ?? config.target) : 'codex';
  if (config && args.target && args.target !== config.target) {
    throw new Error(`CLI target ${args.target} does not match loopengine.config.json target ${config.target}.`);
  }
  const adapter = await resolveAdapter(rootDir, adapterId);
  const profile = args.profile ?? config?.profile ?? 'codex-internal';
  const projectProfile = config ? await detectProjectProfile({ config, targetDir }) : null;
  const governanceMode = config ? resolveGovernanceMode(config, profile) : undefined;
  if (config) validateGovernanceModeForProfile(governanceMode, profile);
  const validationCommands = config
    ? resolveValidationCommands(config, projectProfile, governanceMode)
    : undefined;
  const renderData = config ? {
    ...config,
    profile,
    projectProfile,
    target: args.target ?? config.target,
    governance: { mode: governanceMode },
    validationCommands,
  } : {};
  if (config) {
    validateProjectConfig({ ...config, profile, target: args.target ?? config.target });
  }
  const requestedModules = args.modules !== undefined
    ? parseModulesOption(args.modules)
    : config?.modules;

  const plan = await createInstallPlan({
    adapterId,
    dryRun: dryRunRequested,
    force: Boolean(args.force),
    managedAgentsBlock: isMvpMode,
    profile,
    requestedModules,
    renderData,
    rootDir,
    targetDir,
    upgrade: Boolean(args.upgrade),
  });
  if (config) {
    const agentsTemplate = await readFile(path.join(rootDir, `adapters/${adapter.id}/${path.basename(adapter.instructionTarget, '.md')}.template.md`), 'utf8');
    const installedTargets = plan.actions.map((action) => action.relativeTarget);
    validateConfigAndGeneratedContent(plan.renderData, agentsTemplate, { installedTargets });
  }
  plan.redZoneConfirmed = Boolean(args['confirm-red-zone']);
  const result = await applyInstallPlan(plan);
  const previewFiles = plan.dryRun ? await previewInstallPlan(plan, { includeContent: Boolean(args.verbose) }) : [];
  const plannedToolActions = createToolProvisioningPlan({
    profile,
    resolvedModules: plan.resolvedModules,
    targetDir,
  }).map(({ id, mode, phases, version }) => ({
    id,
    mode,
    phases,
    version,
  }));
  const tools = plan.dryRun
    ? await inspectProfileTools(profile, targetDir, plan.resolvedModules)
    : await provisionProfileTools({
        mcpConflicts: result.mcpConflicts,
        profile,
        resolvedModules: plan.resolvedModules,
        targetDir,
      });
  if (!plan.dryRun && plannedToolActions.length > 0) {
    await registerGeneratedFile(targetDir, '.loopengine/tool-state/tools.json');
  }
  const health = plan.dryRun ? { ok: true, status: 'ready' } : healthReport({ profile, tools });
  emitReport({
    ...health,
    actions: args.verbose ? plan.actions : plan.actions.map(compactAction),
    backupActions: plan.baselinePlan.actions,
    baselineId: result.baseline?.id ?? plan.baselinePlan.baselineId,
    dryRun: plan.dryRun,
    governanceMode,
    implicitModules: plan.implicitModules,
    plannedToolActions,
    previewFiles,
    profile: plan.profile,
    requestedModules: plan.requestedModules,
    resolvedModules: plan.resolvedModules,
    target: isMvpMode ? adapterId : undefined,
    ...(args.verbose ? { targetDir: plan.targetDir } : {}),
    tools,
    recommendations: toolRecommendations(tools, profile, { adapterId, mvp: isMvpMode }),
    warnings: toolWarnings(tools),
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
    const requestedModules = await projectRequestedModules(config, targetDir);
    validateProjectConfig(config);
    const adapter = await resolveAdapter(rootDir, config.target);
    const projectProfile = await detectProjectProfile({ config, targetDir });
    const governanceMode = resolveGovernanceMode(config, config.profile);
    validateGovernanceModeForProfile(governanceMode, config.profile);
    const validationCommands = resolveValidationCommands(config, projectProfile, governanceMode);
    const plan = await createInstallPlan({
      adapterId: adapter.id,
      dryRun: true,
      force: true,
      managedAgentsBlock: true,
      profile: config.profile,
      requestedModules,
      renderData: { ...config, governance: { mode: governanceMode }, projectProfile, validationCommands },
      rootDir,
      targetDir,
    });
    const agentsTemplate = await readFile(path.join(rootDir, `adapters/${adapter.id}/${path.basename(adapter.instructionTarget, '.md')}.template.md`), 'utf8');
    const installedTargets = plan.actions.map((action) => action.relativeTarget);
    validateConfigAndGeneratedContent({ ...config, governance: { mode: governanceMode }, projectProfile, validationCommands }, agentsTemplate, { installedTargets });
    validateConfigAndGeneratedContent(plan.renderData, agentsTemplate, { installedTargets });
    const target = await inspectTargetInstall({
      adapterId: adapter.id,
      managedAgentsBlock: true,
      profile: config.profile,
      requestedModules,
      renderData: { ...config, governance: { mode: governanceMode }, projectProfile, validationCommands },
      rootDir,
      targetDir,
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
    const tools = await inspectProfileTools(config.profile, targetDir, plan.resolvedModules);
    const health = healthReport({ profile: config.profile, tools });
    emitReport({
      ...health,
      commandStatus,
      recommendations: toolRecommendations(tools, config.profile, { adapterId: adapter.id, mvp: true }),
      scope: 'project',
      ...(args.verbose ? { targetDir } : {}),
      tools,
      warnings: toolWarnings(tools),
    }, args);
    applyHealthExit(health.status, args);
    return;
  }

  if (args.target) {
    const profile = args.profile ?? 'codex-internal';
    const targetDir = path.resolve(args.target);
    const report = await inspectTargetInstall({
      profile,
      rootDir,
      targetDir,
    });
    const tools = await inspectProfileTools(profile, targetDir);
    report.tools = tools;
    report.warnings = toolWarnings(tools);
    report.recommendations = toolRecommendations(tools, profile);
    Object.assign(report, healthReport({ baseOk: report.ok, profile, tools }));
    emitReport(args.verbose ? report : { ...report, targetDir: undefined }, args, { error: report.status === 'invalid' });
    applyHealthExit(report.status, args);
    return;
  }

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
  const requestedModules = await projectRequestedModules(config, targetDir);
  validateProjectConfig(config);
  const adapter = await resolveAdapter(rootDir, config.target);
  const projectProfile = await detectProjectProfile({ config, targetDir });
  const governanceMode = resolveGovernanceMode(config, config.profile);
  validateGovernanceModeForProfile(governanceMode, config.profile);
  const validationCommands = resolveValidationCommands(config, projectProfile, governanceMode);
  const renderData = { ...config, governance: { mode: governanceMode }, projectProfile, validationCommands };
  const target = await inspectTargetInstall({
    adapterId: adapter.id,
    managedAgentsBlock: true,
    profile: config.profile,
    requestedModules,
    renderData,
    rootDir,
    targetDir,
  });
  if (!target.ok) {
    const error = new Error('Project installation is not consistent; run loopengine validate --project first.');
    error.code = 'PROJECT_VERIFICATION_FAILED';
    throw error;
  }
  const pack = await validatePack(rootDir);
  if (!pack.ok) {
    const error = new Error('LoopEngine pack validation failed.');
    error.code = 'PROJECT_VERIFICATION_FAILED';
    throw error;
  }
  const commandStatus = await inspectValidationCommands({ commands: validationCommands, targetDir });
  const results = await executeProjectVerification({
    allowManual: Boolean(args['allow-manual']),
    commandStatus,
    targetDir,
  });
  console.log(JSON.stringify({ ok: true, results, scope: 'project', targetDir }, null, 2));
}

async function baseline(args) {
  if (!args.project) throw Object.assign(new Error('baseline requires --project <path>.'), { code: 'BASELINE_PROJECT_REQUIRED' });
  if (args.target) throw Object.assign(new Error('baseline supports MVP --project only; legacy --target is not supported.'), { code: 'BASELINE_PROJECT_REQUIRED' });
  if (args.apply) throw new Error('baseline uses --write, not legacy --apply.');
  if (args.write && args['dry-run']) throw new Error('Use --write or --dry-run, not both.');
  const allowedOptions = new Set(['_', 'dry-run', 'force', 'project', 'verify', 'write']);
  const unknownOption = Object.keys(args).find((key) => !allowedOptions.has(key));
  if (unknownOption) throw new Error(`Unknown baseline option: --${unknownOption}`);
  const targetDir = path.resolve(args.project);
  let config;
  try {
    config = await readRequiredProjectConfig(targetDir);
  } catch (cause) {
    throw Object.assign(new Error('Project configuration is missing or invalid; run loopengine init before baseline.'), {
      cause,
      code: 'BASELINE_INSTALL_INVALID',
    });
  }
  try {
    validateProjectConfig(config);
  } catch (cause) {
    throw Object.assign(new Error('Project configuration is invalid; fix loopengine.config.json before baseline.'), {
      cause,
      code: 'BASELINE_INSTALL_INVALID',
    });
  }
  const projectProfile = await detectProjectProfile({ config, targetDir });
  const adapter = await resolveAdapter(rootDir, config.target);
  let requestedModules;
  try {
    requestedModules = await projectRequestedModules(config, targetDir);
  } catch (cause) {
    throw Object.assign(new Error('Project installation state is invalid; reinstall before baseline.'), {
      cause,
      code: 'BASELINE_INSTALL_INVALID',
    });
  }
  const governanceMode = resolveGovernanceMode(config, config.profile);
  validateGovernanceModeForProfile(governanceMode, config.profile);
  const validationCommands = resolveValidationCommands(config, projectProfile, governanceMode);
  const renderData = { ...config, governance: { mode: governanceMode }, projectProfile, validationCommands };
  const target = await inspectTargetInstall({
    adapterId: adapter.id,
    managedAgentsBlock: true,
    profile: config.profile,
    requestedModules,
    renderData,
    rootDir,
    targetDir,
  });
  const inputs = await collectProjectBaselineInputs({
    config,
    governanceMode,
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
    governanceMode,
    projectProfile,
    target,
    targetDir,
    verify: Boolean(args.verify),
    write: Boolean(args.write),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function evaluateProject(args) {
  const action = args._[1];
  if (!['check', 'run', 'reference'].includes(action)) throw new Error('eval requires check, run, or reference.');
  if (!args.project) throw new Error('eval requires --project <path>.');
  if (args.target) throw new Error('eval supports MVP --project only; legacy --target is not supported.');
  if (args.apply) throw new Error('eval uses --write, not legacy --apply.');
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

function toolRecommendations(tools, profile, { adapterId = 'codex', mvp = false } = {}) {
  const retryCommand = mvp
    ? `loopengine install --project <project> --target ${adapterId} --profile ${profile} --write --confirm-red-zone`
    : `loopengine install --target <target> --profile ${profile} --apply --confirm-red-zone`;
  return Object.entries(tools).flatMap(([tool, state]) => {
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
        command: retryCommand,
        ...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
        message: `Retry ${tool} provisioning after checking network access and the reported phase.`,
        phase: state.phase,
        tool,
      }];
    }
    if (state.status === 'pending-config') {
      return [{
        action: 'configure-credentials',
        command: retryCommand,
        message: `Configure a supported ${tool} credential in the environment, then retry provisioning.`,
        phase: state.phase,
        tool,
      }];
    }
    return [];
  });
}

async function doctor(args) {
  const targetDir = path.resolve(args.target ?? process.cwd());
  const installState = args.target ? await readInstallState(targetDir) : null;
  const profile = args.profile ?? installState?.profile ?? 'codex-internal';
  const managedAgentsBlock = installState?.files?.some(
    (file) => ['managed-block', 'managed-instruction-block'].includes(file.contentStrategy),
  );
  let renderData = {};
  if (managedAgentsBlock) {
    const config = await readRequiredProjectConfig(targetDir);
    const projectProfile = await detectProjectProfile({ config, targetDir });
    const governanceMode = resolveGovernanceMode(config, profile);
    const validationCommands = resolveValidationCommands(config, projectProfile, governanceMode);
    renderData = { ...config, profile, governance: { mode: governanceMode }, projectProfile, validationCommands };
  }
  const [pack, gitHooks] = await Promise.all([
    validatePack(rootDir),
    inspectGitHooks(targetDir),
  ]);
  let target = args.target
    ? await inspectTargetInstall({
        managedAgentsBlock,
        adapterId: installState?.adapter ?? 'codex',
        profile,
        requestedModules: installState?.requestedModules,
        renderData,
        rootDir,
        targetDir,
      })
    : null;
  const tools = args.target ? await inspectProfileTools(profile, targetDir) : {};
  if (target && !args.verbose) target = compactTargetReport(target);
  const health = healthReport({ baseOk: pack.ok && (!target || target.ok), profile, tools });
  emitReport({
    ...health,
    gitHooks,
    pack,
    ...(args.verbose ? { rootDir } : {}),
    target,
    ...(args.verbose ? { targetDir } : {}),
    tools,
    recommendations: toolRecommendations(tools, profile, {
      adapterId: installState?.adapter ?? 'codex',
      mvp: Boolean(managedAgentsBlock),
    }),
    warnings: toolWarnings(tools),
  }, args);
  applyHealthExit(health.status, args);
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

async function uninstall(args) {
  if (!args.project) throw new Error('uninstall requires --project <path>.');
  const targetDir = path.resolve(args.project);
  const config = await readRequiredProjectConfig(targetDir);
  const adapter = await resolveAdapter(rootDir, args.target ?? config.target);
  if (args.target && args.target !== config.target) {
    throw new Error(`CLI target ${args.target} does not match loopengine.config.json target ${config.target}.`);
  }
  const state = await readInstallState(targetDir);
  if (state && state.adapter !== adapter.id) {
    throw new Error(`Installed adapter ${state.adapter} does not match uninstall target ${adapter.id}.`);
  }
  if (args.apply) throw new Error('MVP uninstall uses --write, not legacy --apply.');
  if (args.write && args['dry-run']) throw new Error('Use --write or --dry-run, not both.');
  const allowedOptions = new Set(['_', 'confirm-red-zone', 'dry-run', 'project', 'target', 'write']);
  const unknownOption = Object.keys(args).find((key) => !allowedOptions.has(key));
  if (unknownOption) throw new Error(`Unknown uninstall option: --${unknownOption}`);

  const plan = await createUninstallPlan({
    dryRun: !args.write,
    redZoneConfirmed: Boolean(args['confirm-red-zone']),
    targetDir,
  });
  const result = await applyUninstallPlan(plan);
  console.log(JSON.stringify({
    actions: plan.actions,
    applied: result.applied,
    dryRun: plan.dryRun,
    retainedState: result.retainedState,
    skipped: result.skipped,
    target: adapter.id,
    targetDir: plan.targetDir,
  }, null, 2));
  if (result.skipped.length > 0) process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'help';
  if (command === 'init') {
    await init(args);
  } else if (command === 'install') {
    await install(args);
  } else if (command === 'validate') {
    await validate(args);
  } else if (command === 'verify') {
    await verify(args);
  } else if (command === 'baseline') {
    await baseline(args);
  } else if (command === 'eval') {
    await evaluateProject(args);
  } else if (command === 'doctor') {
    await doctor(args);
  } else if (command === 'diff') {
    await diff(args);
  } else if (command === 'rollback') {
    await rollback(args);
  } else if (command === 'uninstall') {
    await uninstall(args);
  } else {
    console.log('Usage: loopengine <init|install|uninstall|validate|verify|baseline|eval|doctor|diff|rollback> [--project path] [--target codex|claude|gemini|path] [--profile minimal|core|full|docs-only] [--modules list] [--write|--apply] [--dry-run] [--output json|summary] [--verbose] [--verify] [--force] [--upgrade] [--confirm-red-zone] [--allow-manual] [--allow-degraded]');
    console.log('MVP uses --project <path> --target <codex|claude|gemini> and --write. Legacy Codex-only install uses --target <path> and --apply. Install defaults to dry-run.');
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
      code: error.code ?? 'LOOPENGINE_ERROR',
      message: error.message,
    },
  }, args, { error: true });
  process.exitCode = 1;
}
